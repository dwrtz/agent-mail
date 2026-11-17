// Discovery, actor fetching, the inbox (R4, R6-R9, R11) and signed attachment GETs (R10).
import { Env, HttpError, json, nowIso, isoIn, origin, host, actorUrl, userByHandle, UserRow, parseJson } from './env';
import { buildActor, signingKey } from './keys';
import { webfingerJrd, validateActivity, isUrl, ProtoError, MAX_INBOX_BODY, threadCreator, Inbound, MAX_GROUP } from '../shared/activity';
import { verifyRequest, SigError, POST_COMPONENTS, GET_COMPONENTS, signRequest } from '../shared/httpsig';
import { digestMatches, contentDigest } from '../shared/digest';
import { multikeyDecode, te } from '../shared/enc';
import { onQueued, decide } from './inboxq';

type Handler = (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
let selfHandler: Handler | null = null;
export const setSelfHandler = (h: Handler) => { selfHandler = h; };

/** fetch() that routes requests for this instance's own origin to its own handler (design.md "Local delivery"). */
export async function federatedFetch(env: Env, ctx: ExecutionContext, url: string, init: RequestInit = {}): Promise<Response> {
  if (new URL(url).origin === origin(env) && selfHandler) return selfHandler(new Request(url, init), env, ctx);
  return fetch(url, { ...init, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(15000) });
}

export interface ActorDoc { id: string; inbox: string; preferredUsername?: string; name?: string; assertionMethod?: any[]; keyAgreement?: any[]; [k: string]: any }

export async function fetchActor(env: Env, ctx: ExecutionContext, actorId: string, fresh = false): Promise<ActorDoc> {
  if (!isUrl(actorId)) throw new HttpError(400, 'bad_request', 'actor must be an https URL');
  if (!fresh) {
    const c = await env.DB.prepare('SELECT doc, fetched_at FROM actor_cache WHERE actor_id = ?').bind(actorId).first<{ doc: string; fetched_at: string }>();
    if (c && Date.parse(c.fetched_at) > Date.now() - 3600_000) return JSON.parse(c.doc);
  }
  let res: Response;
  try {
    res = await federatedFetch(env, ctx, actorId, { headers: { accept: 'application/activity+json' }, signal: AbortSignal.timeout(5000) });
  } catch (e) { throw new HttpError(502, 'actor_unavailable', `could not fetch ${actorId}: ${String(e)}`); }
  if (res.status !== 200) throw new HttpError(502, 'actor_unavailable', `${actorId} answered ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > 65536) throw new HttpError(502, 'actor_unavailable', 'actor document over 64 KiB');
  let doc: ActorDoc;
  try { doc = JSON.parse(new TextDecoder().decode(buf)); } catch { throw new HttpError(502, 'actor_unavailable', 'actor document is not JSON'); }
  if (doc?.id !== actorId || !isUrl(doc.inbox)) throw new HttpError(502, 'actor_unavailable', 'actor id or inbox mismatch');
  await env.DB.prepare('INSERT INTO actor_cache (actor_id, doc, fetched_at) VALUES (?, ?, ?) ON CONFLICT(actor_id) DO UPDATE SET doc = excluded.doc, fetched_at = excluded.fetched_at')
    .bind(actorId, JSON.stringify(doc), nowIso()).run();
  return doc;
}

export function signingKeyFromDoc(doc: ActorDoc, keyId: string): Uint8Array {
  const actorId = keyId.split('#')[0];
  const k = (Array.isArray(doc.assertionMethod) ? doc.assertionMethod : []).find((x: any) => x?.id === keyId && x?.controller === actorId);
  if (!k) throw new SigError('key_unavailable', 'key is not listed in the actor\'s assertionMethod');
  try { const d = multikeyDecode(k.publicKeyMultibase); if (d.kind === 'ed25519') return d.key; } catch {}
  throw new SigError('key_unavailable', 'key is not an Ed25519 Multikey');
}

export function encKeyFromDoc(doc: ActorDoc): { keyId: string; publicKey: Uint8Array } | null {
  const list = (Array.isArray(doc.keyAgreement) ? doc.keyAgreement : []).filter((x: any) => x?.controller === doc.id && typeof x?.id === 'string');
  for (let i = list.length - 1; i >= 0; i--) {
    try { const d = multikeyDecode(list[i].publicKeyMultibase); if (d.kind === 'x25519') return { keyId: list[i].id, publicKey: d.key }; } catch {}
  }
  return null;
}

/** Resolves `user@host` (WebFinger) or an actor URL to its actor document. */
export async function resolveAddress(env: Env, ctx: ExecutionContext, to: string): Promise<ActorDoc> {
  const t = to.trim().replace(/^acct:/, '').replace(/^@/, '');
  if (isUrl(t)) return fetchActor(env, ctx, t);
  const m = /^([^@\s]+)@([^@\s/]+)$/.exec(t);
  if (!m) throw new HttpError(422, 'unknown_recipient', `${to} is not a handle or actor URL`);
  const scheme = (env.ALLOW_HTTP_LOCALHOST === '1' && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(m[2])) ? 'http' : 'https';
  const wf = `${scheme}://${m[2]}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${m[1]}@${m[2]}`)}`;
  let res: Response;
  try { res = await federatedFetch(env, ctx, wf, { headers: { accept: 'application/jrd+json' }, signal: AbortSignal.timeout(5000) }); }
  catch { throw new HttpError(422, 'unknown_recipient', `${to}: WebFinger lookup failed`); }
  if (res.status !== 200) throw new HttpError(422, 'unknown_recipient', `${to}: WebFinger answered ${res.status}`);
  const jrd: any = await res.json().catch(() => null);
  const link = (jrd?.links ?? []).find((l: any) => l?.rel === 'self' && l?.type === 'application/activity+json' && isUrl(l?.href));
  if (!link) throw new HttpError(422, 'unknown_recipient', `${to}: no ActivityPub actor link`);
  try { return await fetchActor(env, ctx, link.href); } catch (e) { throw new HttpError(422, 'unknown_recipient', `${to}: ${(e as Error).message}`); }
}

export async function webfinger(req: Request, env: Env): Promise<Response> {
  const cors = { 'access-control-allow-origin': '*' };
  const resource = new URL(req.url).searchParams.get('resource');
  if (!resource) return json({ error: 'bad_request', detail: 'resource is required' }, 400, cors);
  let handle: string | null = null;
  const m = /^acct:([^@]+)@(.+)$/.exec(resource);
  if (m) { if (m[2].toLowerCase() === host(env).toLowerCase()) handle = m[1].toLowerCase(); }
  else if (resource.startsWith(`${origin(env)}/users/`)) handle = resource.slice(`${origin(env)}/users/`.length);
  const u = handle ? await userByHandle(env, handle) : null;
  if (!u) return json({ error: 'not_found', detail: 'no such account here' }, 404, cors);
  return new Response(JSON.stringify(webfingerJrd(u.handle, host(env), actorUrl(env, u.handle))), { headers: { 'content-type': 'application/jrd+json', ...cors } });
}

export async function actorResponse(env: Env, handle: string): Promise<Response> {
  const u = await userByHandle(env, handle);
  if (!u) throw new HttpError(404, 'not_found', 'no such actor');
  return new Response(JSON.stringify(await buildActor(env, u)), { headers: { 'content-type': 'application/activity+json', 'access-control-allow-origin': '*' } });
}

export function outboxCollection(env: Env, handle: string) {
  return new Response(JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', id: `${actorUrl(env, handle)}/outbox`, type: 'OrderedCollection', totalItems: 0, orderedItems: [] }),
    { headers: { 'content-type': 'application/activity+json' } });
}

const lower = (h: Headers) => { const o: Record<string, string> = {}; h.forEach((v, k) => { o[k.toLowerCase()] = v; }); return o; };

/** Verifies an RFC 9421 signature (rows 5-10 of R6). Returns the signer's actor id. */
export async function verifySigned(env: Env, ctx: ExecutionContext, req: Request, components: string[]): Promise<{ actor: string; keyId: string }> {
  const parts = { method: req.method, url: req.url, headers: lower(req.headers) };
  const now = Math.floor(Date.now() / 1000);
  let fetched: ActorDoc | null = null;
  const lookup = async (fresh: boolean) => async (keyId: string) => {
    let doc: ActorDoc;
    try { doc = await fetchActor(env, ctx, keyId.split('#')[0], fresh); } catch (e) { throw new SigError('key_unavailable', (e as Error).message); }
    fetched = doc;
    return signingKeyFromDoc(doc, keyId);
  };
  let r;
  try {
    r = await verifyRequest(parts, { now, requiredComponents: components, lookupKey: await lookup(false) });
  } catch (e) {
    if (!(e instanceof SigError)) throw e;
    if (e.code === 'signature_invalid' && fetched || e.code === 'key_unavailable') {
      try { r = await verifyRequest(parts, { now, requiredComponents: components, lookupKey: await lookup(true) }); }
      catch (e2) { if (e2 instanceof SigError) throw new HttpError(401, e2.code, e2.message); throw e2; }
    } else throw new HttpError(401, e.code, e.message);
  }
  // Row 10: replay
  const k = `${r.keyId} ${r.nonce}`;
  const ins = await env.DB.prepare('INSERT OR IGNORE INTO nonces (k, expires_at) VALUES (?, ?)').bind(k, isoIn(900)).run();
  if (!ins.meta.changes) throw new HttpError(401, 'replayed_nonce', 'nonce already used');
  return { actor: r.keyId.split('#')[0], keyId: r.keyId };
}

export async function inbox(req: Request, env: Env, ctx: ExecutionContext, handle: string): Promise<Response> {
  // 1
  const user = await userByHandle(env, handle);
  if (!user) throw new HttpError(404, 'not_found', 'no such actor');
  // 2
  const len = Number(req.headers.get('content-length') ?? '0');
  if (len > MAX_INBOX_BODY) throw new HttpError(413, 'too_large', 'body over 256 KiB');
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length > MAX_INBOX_BODY) throw new HttpError(413, 'too_large', 'body over 256 KiB');
  // 3
  const ct = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/activity+json' && ct !== 'application/ld+json') throw new HttpError(415, 'unsupported_media_type', 'use application/activity+json');
  // 4
  if (!(await digestMatches(req.headers.get('content-digest'), body))) throw new HttpError(400, 'digest_mismatch', 'Content-Digest sha-256 missing or wrong');
  // 5-10
  const signed = await verifySigned(env, ctx, req, POST_COMPONENTS);
  // 11
  let act: Inbound;
  try {
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder().decode(body)); } catch { throw new ProtoError(400, 'bad_activity', 'body is not JSON'); }
    act = validateActivity(raw);
  } catch (e) { if (e instanceof ProtoError) throw new HttpError(e.status, e.code, e.message); throw e; }
  // 12
  if (act.actor !== signed.actor) throw new HttpError(403, 'actor_mismatch', 'the signing key belongs to another actor');
  // 13
  const me = actorUrl(env, user.handle);
  if (!act.to.includes(me)) throw new HttpError(422, 'not_addressed', 'this inbox\'s actor is not in to');
  if (act.type === 'Create' && act.note['am:encrypted'].recipient !== me) throw new HttpError(422, 'not_addressed', 'am:encrypted.recipient is not this actor');
  // 14
  const senderHost = new URL(signed.actor).host;
  const minute = new Date().toISOString().slice(0, 16);
  const rate = await env.DB.prepare('INSERT INTO rate (host, minute, n) VALUES (?, ?, 1) ON CONFLICT(host, minute) DO UPDATE SET n = n + 1 RETURNING n').bind(senderHost, minute).first<{ n: number }>();
  if ((rate?.n ?? 0) > 120) throw new HttpError(429, 'rate_limited', 'too many requests from your host', { 'retry-after': String(60 - new Date().getUTCSeconds()) });
  // 15-16 and the decision
  const status = await receive(env, ctx, user, act);
  return json({ status }, 202);
}

interface ThreadRow { id: number; uri: string; creator: string | null; members: string }

export async function getThread(env: Env, userId: number, uri: string): Promise<(ThreadRow & { list: string[] }) | null> {
  const t = await env.DB.prepare('SELECT id, uri, creator, members FROM threads WHERE user_id = ? AND uri = ?').bind(userId, uri).first<ThreadRow>();
  return t ? { ...t, list: parseJson<string[]>(t.members, []) } : null;
}

async function receive(env: Env, ctx: ExecutionContext, user: UserRow, act: Inbound): Promise<'accepted' | 'duplicate'> {
  const me = actorUrl(env, user.handle);
  const now = nowIso();
  if (act.type === 'Read') {
    const m = await env.DB.prepare("SELECT id, read_by, activity FROM messages WHERE user_id = ? AND direction = 'out' AND note_id = ?").bind(user.id, act.object).first<{ id: number; read_by: string; activity: string }>();
    if (m) {
      const sentTo: string[] = parseJson<any>(m.activity, {})?.to ?? [];
      if (sentTo.includes(act.actor)) {
        const rb = parseJson<Record<string, string>>(m.read_by, {});
        if (!rb[act.actor]) { rb[act.actor] = act.raw.published; await env.DB.prepare('UPDATE messages SET read_by = ? WHERE id = ?').bind(JSON.stringify(rb), m.id).run(); }
      }
    }
    return 'accepted';
  }
  const threadUri = act.type === 'Create' ? act.note.context : act.target;
  const thread = await getThread(env, user.id, threadUri);
  const creator = thread?.creator ?? threadCreator(threadUri);
  // 15: thread rules
  if (act.type === 'Create') {
    if (thread && !thread.list.includes(act.actor)) throw new HttpError(403, 'not_member', 'you are not a member of this thread');
  } else {
    const selfLeave = act.type === 'Remove' && act.object === act.actor;
    if (!selfLeave && act.actor !== creator) throw new HttpError(403, 'not_thread_owner', 'only the thread creator may change members');
    if (thread && !thread.list.includes(act.actor)) throw new HttpError(403, 'not_member', 'you are not a member of this thread');
    if (act.type === 'Add' && !act.members.includes(act.object)) throw new ProtoErrorHttp('am:members must include the added member');
    if (act.type === 'Remove' && act.members.includes(act.object)) throw new ProtoErrorHttp('am:members must not include the removed member');
  }
  // 16: duplicate
  const dup = await env.DB.prepare("SELECT 1 FROM messages WHERE user_id = ? AND direction = 'in' AND activity_id = ?").bind(user.id, act.id).first();
  if (dup) return 'duplicate';
  // Decide
  const action = await decide(env, user.id, act.actor);
  if (action === 'block') return 'accepted';
  // Thread state
  if (!thread) {
    const members = act.type === 'Create' ? [...new Set([act.actor, ...act.to])] : [...new Set(act.members)];
    if (members.length > MAX_GROUP) throw new HttpError(422, 'group_too_large', `at most ${MAX_GROUP} members`);
    await env.DB.prepare('INSERT OR IGNORE INTO threads (user_id, uri, creator, members, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(user.id, threadUri, creator, JSON.stringify(members), now, now).run();
  } else if (act.type !== 'Create') {
    await env.DB.prepare('UPDATE threads SET members = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify([...new Set(act.members)]), now, thread.id).run();
  } else {
    await env.DB.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').bind(now, thread.id).run();
  }
  // Sequence / gap
  const seq: number = act.type === 'Create' ? act.note['am:seq'] : act.seq;
  const last = (await env.DB.prepare('SELECT last FROM seqs WHERE user_id = ? AND thread = ? AND actor = ?').bind(user.id, threadUri, act.actor).first<{ last: number }>())?.last ?? 0;
  const gap = Math.max(0, seq - last - 1);
  await env.DB.prepare('INSERT INTO seqs (user_id, thread, actor, last) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, thread, actor) DO UPDATE SET last = MAX(last, excluded.last)')
    .bind(user.id, threadUri, act.actor, seq).run();
  const state = action === 'allow' ? 'queued' : 'request';
  const ins = await env.DB.prepare(`INSERT OR IGNORE INTO messages (user_id, direction, activity_id, type, note_id, thread, actor, activity, published, state, gap_before, received_at)
    VALUES (?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(user.id, act.id, act.type, act.type === 'Create' ? act.note.id : null, threadUri, act.actor, JSON.stringify(act.raw), act.raw.published, state, gap, now).first<{ id: number }>();
  if (!ins) return 'duplicate';
  await onQueued(env, ctx, user, ins.id, state === 'queued');
  void me;
  return 'accepted';
}

class ProtoErrorHttp extends HttpError { constructor(m: string) { super(400, 'bad_activity', m); } }

/** Signed GET for an attachment (R10). Owner sessions are handled by the caller. */
export async function attachmentGet(req: Request, env: Env, ctx: ExecutionContext, id: string, ownerUserId: number | null): Promise<Response> {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new HttpError(404, 'not_found', 'no such attachment');
  const a = await env.DB.prepare('SELECT * FROM attachments WHERE id = ?').bind(id).first<{ id: string; user_id: number; size: number; digest: string }>();
  if (!a) throw new HttpError(404, 'not_found', 'no such attachment');
  if (ownerUserId !== a.user_id) {
    if (!req.headers.get('signature-input')) throw new HttpError(401, 'signature_missing', 'signed GET required');
    const s = await verifySigned(env, ctx, req, GET_COMPONENTS);
    const g = await env.DB.prepare('SELECT 1 FROM attachment_grants WHERE attachment_id = ? AND actor = ?').bind(id, s.actor).first();
    if (!g) throw new HttpError(403, 'forbidden', 'this attachment was not sent to you');
  }
  const obj = await env.FILES.get(`att/${id}`);
  if (!obj) throw new HttpError(404, 'not_found', 'attachment missing');
  return new Response(obj.body, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(a.size), 'content-digest': a.digest } });
}

/** Signs and sends a request as a local user. */
export async function signedFetch(env: Env, ctx: ExecutionContext, u: UserRow, method: 'GET' | 'POST', url: string, body?: string): Promise<Response> {
  const k = signingKey(env, u);
  const headers: Record<string, string> = {};
  if (method === 'POST') {
    headers['content-type'] = 'application/activity+json';
    headers['content-digest'] = await contentDigest(te.encode(body ?? ''));
  }
  const s = signRequest({ method, url, headers }, { keyId: k.keyId, privateKey: k.privateKey });
  return federatedFetch(env, ctx, url, { method, headers: { ...headers, 'signature-input': s['signature-input'], signature: s.signature }, body: method === 'POST' ? body : undefined });
}
