// The owner API (design.md, "Owner API"). The owner uses it with a session; an agent's token reaches only
// the mail operations its scopes allow, and never account administration.
import { Env, HttpError, json, nowIso, actorUrl, addressOf, UserRow, parseJson, Caller, consumerOf, requireScope, requireSession, Scope, serverKeysAllowed } from './env';
import { encKeys, clientKeys, nextKeyN, createServerKey } from './keys';
import { pull, ack, listRequests, setRule, counts, doorbell, unreadMessages } from './inboxq';
import { resolveMany, prepare, markRead } from './outbox';
import { gatedSend, gatedApprove, gatedBlock, gatedMembers, listApprovals, decideApproval, prepareApproval, cancelApproval, pendingApprovals } from './approvals';
import { createToken, revokeToken } from './auth';
import { oauthClientInfo, oauthApprove } from './oauth';
import { signedFetch } from './federation';
import { b64, b64url, randomBytes, hex, sha256, unb64url } from '../shared/enc';
import { MAX_ATTACHMENT_BYTES, MAX_CLIENT_KEYS, isUrl } from '../shared/activity';
import { normalizeDoorbellHeader, normalizeDoorbellValue, parseDoorbellExtra } from '../shared/doorbell';

export async function meInfo(env: Env, c: Caller) {
  const u = c.user;
  const actor = actorUrl(env, u.handle);
  const keys = await clientKeys(env, u.id);
  const base = {
    handle: u.handle, name: u.name, actor, address: addressOf(env, u.handle), readReceipts: !!u.read_receipts,
    encKeys: (await encKeys(env, u.id)).map(k => ({ n: k.n, keyId: `${actor}#enc-${k.n}`, publicKey: k.public_key })),
    ...(await counts(env, u.id, consumerOf(c))),
    unreadMessages: await unreadMessages(env, u.id),
    approvals: await pendingApprovals(env, u.id, c.token?.id ?? null),
  };
  // An agent learns about itself and the keys mail is sealed to (all public). The email, the doorbell
  // (a webhook URL is often a secret in itself) and the other agents are the owner's to see.
  if (c.token) return { ...base, clientKeys: keys.map(k => ({ n: k.n, keyId: `${actor}#enc-${k.n}`, publicKey: k.public_key })), token: { label: c.token.label, scopes: c.token.scopes, ask: c.token.ask, serverKey: c.token.hosted } };
  return {
    ...base, email: u.email,
    clientKeys: keys.map(k => ({ n: k.n, keyId: `${actor}#enc-${k.n}`, publicKey: k.public_key, label: k.label, tokenId: k.token_id, serverKey: !!k.hosted })),
    doorbell: { url: u.doorbell_url ?? '', header: u.doorbell_header ?? 'Authorization', valueSet: !!u.doorbell_value, extra: Object.keys(parseJson<Record<string, string>>(u.doorbell_extra, {})) },
  };
}

export async function threadsList(env: Env, u: UserRow) {
  const rows = (await env.DB.prepare(`SELECT t.uri, t.creator, t.members, t.updated_at,
      (SELECT COUNT(*) FROM messages m WHERE m.user_id = t.user_id AND m.thread = t.uri AND m.direction = 'in' AND m.type = 'Create' AND m.state = 'queued' AND m.read_at IS NULL) AS unread,
      (SELECT MAX(m.id) FROM messages m WHERE m.user_id = t.user_id AND m.thread = t.uri AND m.type = 'Create' AND (m.direction = 'out' OR m.state = 'queued')) AS last_id
      FROM threads t WHERE t.user_id = ? ORDER BY t.updated_at DESC LIMIT 200`).bind(u.id).all<any>()).results;
  const out = [];
  for (const r of rows) {
    if (!r.last_id) continue; // threads that only hold requests stay in Requests
    const last = await env.DB.prepare('SELECT activity, published, direction FROM messages WHERE id = ?').bind(r.last_id).first<any>();
    out.push({ uri: r.uri, creator: r.creator, members: JSON.parse(r.members), updatedAt: r.updated_at, unread: r.unread, last: last ? { direction: last.direction, published: last.published, activity: JSON.parse(last.activity) } : null });
  }
  return out;
}

export async function threadMessages(env: Env, u: UserRow, uri: string, limit = 500) {
  limit = Math.max(1, Math.min(500, Math.floor(limit) || 500));
  // The newest `limit` messages, returned oldest first.
  const rows = (await env.DB.prepare(`SELECT id, direction, type, actor, activity, published, gap_before, read_at, read_by, state FROM messages
      WHERE user_id = ? AND thread = ? AND (direction = 'out' OR state = 'queued') ORDER BY published DESC, id DESC LIMIT ?`).bind(u.id, uri, limit).all<any>()).results.reverse();
  const out = [];
  for (const r of rows) {
    const deliveries = r.direction === 'out'
      ? (await env.DB.prepare('SELECT target, status, attempts, last_error FROM deliveries WHERE message_id = ? AND user_id = ?').bind(r.id, u.id).all<any>()).results
      : undefined;
    out.push({ id: r.id, direction: r.direction, type: r.type, actor: r.actor, activity: JSON.parse(r.activity), published: r.published, gapBefore: r.gap_before, readAt: r.read_at, readBy: parseJson(r.read_by, {}), deliveries });
  }
  return out;
}

/** One stored message by its Note id (received and allowed, or sent). */
export async function getMessage(env: Env, u: UserRow, noteId: string) {
  const r = await env.DB.prepare("SELECT id, direction, type, actor, thread, activity, published, read_at FROM messages WHERE user_id = ? AND note_id = ? AND (direction = 'out' OR state = 'queued')").bind(u.id, noteId).first<any>();
  if (!r) throw new HttpError(404, 'not_found', 'no such message');
  return { id: r.id, direction: r.direction, type: r.type, actor: r.actor, thread: r.thread, activity: JSON.parse(r.activity), published: r.published, readAt: r.read_at };
}

async function body(req: Request) { try { return await req.json<any>(); } catch { throw new HttpError(400, 'bad_request', 'body must be JSON'); } }

async function publicKeyOf(b: any): Promise<string> {
  let raw: Uint8Array;
  try { raw = unb64url(String(b?.publicKey)); } catch { throw new HttpError(400, 'bad_request', 'publicKey must be base64url'); }
  if (raw.length !== 32) throw new HttpError(400, 'bad_request', 'publicKey must be 32 bytes');
  return b64url(raw);
}

export async function ownerApi(req: Request, env: Env, ctx: ExecutionContext, c: Caller, path: string): Promise<Response> {
  const m = req.method;
  const url = new URL(req.url);
  const u = c.user;
  const actor = actorUrl(env, u.handle);
  // `owner()` guards account administration; `can(scope)` guards what a token may do (the owner may do all of it).
  const owner = () => requireSession(c);
  const can = (s: Scope) => requireScope(c, s);

  if (path === '/api/me' && m === 'GET') return json({ user: await meInfo(env, c) });

  // ---- account administration: the owner's session only ----
  if (path === '/api/keys/encryption' && m === 'PUT') {
    owner();
    const key = await publicKeyOf(await body(req));
    const same = (await encKeys(env, u.id)).find(k => k.public_key === key);
    if (same) return json({ keyId: `${actor}#enc-${same.n}` });
    const n = await nextKeyN(env, u.id);
    await env.DB.prepare("INSERT INTO enc_keys (user_id, n, public_key, created_at, kind) VALUES (?, ?, ?, ?, 'primary')").bind(u.id, n, key, nowIso()).run();
    return json({ keyId: `${actor}#enc-${n}` });
  }
  const dk = /^\/api\/keys\/encryption\/(\d+)$/.exec(path);
  if (dk && m === 'DELETE') {
    owner();
    const ks = await encKeys(env, u.id);
    if (ks.length <= 1) throw new HttpError(400, 'bad_request', 'cannot remove your only key');
    if (ks.at(-1)!.n === Number(dk[1])) throw new HttpError(400, 'bad_request', 'cannot remove your newest key');
    await env.DB.prepare("DELETE FROM enc_keys WHERE user_id = ? AND n = ? AND kind = 'primary'").bind(u.id, Number(dk[1])).run();
    return json({});
  }
  if (path === '/api/keys/client' && m === 'PUT') {
    owner();
    const b = await body(req);
    const key = await publicKeyOf(b);
    const ks = await clientKeys(env, u.id);
    const same = ks.find(k => k.public_key === key);
    if (same) return json({ keyId: `${actor}#enc-${same.n}`, n: same.n });
    if ((await encKeys(env, u.id)).some(k => k.public_key === key)) throw new HttpError(400, 'bad_request', 'that is one of your own keys');
    if (ks.length >= MAX_CLIENT_KEYS) throw new HttpError(400, 'too_many_keys', `at most ${MAX_CLIENT_KEYS} agent keys; remove one first`);
    let tokenId: number | null = null;
    if (b.tokenId != null) {
      const t = await env.DB.prepare('SELECT id FROM api_tokens WHERE id = ? AND user_id = ?').bind(Number(b.tokenId), u.id).first<{ id: number }>();
      if (!t) throw new HttpError(400, 'bad_request', 'no such token');
      tokenId = t.id;
    }
    const n = await nextKeyN(env, u.id);
    await env.DB.prepare("INSERT INTO enc_keys (user_id, n, public_key, created_at, kind, label, token_id) VALUES (?, ?, ?, ?, 'client', ?, ?)")
      .bind(u.id, n, key, nowIso(), String(b.label ?? '').trim().slice(0, 60) || null, tokenId).run();
    return json({ keyId: `${actor}#enc-${n}`, n });
  }
  const dc = /^\/api\/keys\/client\/(\d+)$/.exec(path);
  if (dc && m === 'DELETE') {
    owner();
    await env.DB.prepare("DELETE FROM enc_keys WHERE user_id = ? AND n = ? AND kind = 'client'").bind(u.id, Number(dc[1])).run();
    return json({});
  }
  if (path === '/api/settings' && m === 'PUT') {
    owner();
    const b = await body(req);
    if (typeof b.name === 'string') await env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(b.name.trim().slice(0, 80) || u.handle, u.id).run();
    if (typeof b.readReceipts === 'boolean') await env.DB.prepare('UPDATE users SET read_receipts = ? WHERE id = ?').bind(b.readReceipts ? 1 : 0, u.id).run();
    if (typeof b.doorbellUrl === 'string') {
      const v = b.doorbellUrl.trim();
      if (v && !isUrl(v)) throw new HttpError(400, 'bad_request', 'doorbell URL must be https');
      await env.DB.prepare('UPDATE users SET doorbell_url = ? WHERE id = ?').bind(v || null, u.id).run();
    }
    const header = typeof b.doorbellHeader === 'string' ? (normalizeDoorbellHeader(b.doorbellHeader) || 'Authorization') : (u.doorbell_header || 'Authorization');
    if (typeof b.doorbellHeader === 'string') {
      const v = normalizeDoorbellHeader(b.doorbellHeader);
      if (v && !/^[A-Za-z0-9-]{1,64}$/.test(v)) throw new HttpError(400, 'bad_request', 'header name: letters, digits and dashes');
      await env.DB.prepare('UPDATE users SET doorbell_header = ? WHERE id = ?').bind(v || null, u.id).run();
    }
    if (typeof b.doorbellValue === 'string') {
      const v = normalizeDoorbellValue(b.doorbellValue, header);
      await env.DB.prepare('UPDATE users SET doorbell_value = ? WHERE id = ?').bind(v || null, u.id).run();
    }
    if (typeof b.doorbellExtra === 'string') {
      let extra: Record<string, string>;
      try { extra = parseDoorbellExtra(b.doorbellExtra, header); } catch (e) { throw new HttpError(400, 'bad_request', (e as Error).message); }
      await env.DB.prepare('UPDATE users SET doorbell_extra = ? WHERE id = ?').bind(Object.keys(extra).length ? JSON.stringify(extra) : null, u.id).run();
    }
    const fresh = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(u.id).first<UserRow>();
    return json({ user: await meInfo(env, { ...c, user: fresh! }) });
  }
  if (path === '/api/doorbell/test' && m === 'POST') {
    owner();
    if (!u.doorbell_url) throw new HttpError(400, 'bad_request', 'set a doorbell URL first');
    return json({ status: await doorbell(env, ctx, u.id, false, true) });
  }
  if (path === '/api/tokens' && m === 'GET') {
    owner();
    const keys = await clientKeys(env, u.id);
    const rows = (await env.DB.prepare('SELECT id, label, kind, scopes, ask, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY id').bind(u.id).all<any>()).results;
    return json({ tokens: rows.map(t => { const k = keys.find(x => x.token_id === t.id); return { ...t, scopes: String(t.scopes).split(' ').filter(Boolean), ask: String(t.ask).split(' ').filter(Boolean), keyId: k ? `${actor}#enc-${k.n}` : null, serverKey: !!k?.hosted }; }) });
  }
  if (path === '/api/tokens' && m === 'POST') {
    owner();
    const b = await body(req);
    // serverKey: the owner's explicit opt-in to let this instance hold a key for the connector and decrypt for it (R20).
    if (b.serverKey === true && !serverKeysAllowed(env)) throw new HttpError(403, 'server_keys_disabled', 'this instance does not hold keys for connectors');
    const t = await createToken(env, u.id, { label: String(b.label ?? ''), scopes: b.scopes, ask: b.ask });
    if (b.serverKey !== true) return json(t);
    try { return json({ ...t, serverKeyId: (await createServerKey(env, u, t.id, String(b.label ?? ''))).keyId }); }
    catch (e) { await revokeToken(env, u.id, t.id); throw e; }
  }
  const dt = /^\/api\/tokens\/(\d+)$/.exec(path);
  if (dt && m === 'DELETE') { owner(); await revokeToken(env, u.id, Number(dt[1])); return json({}); }
  if (path === '/api/rules' && m === 'PUT') { owner(); const b = await body(req); await setRule(env, u.id, String(b.subject ?? ''), b.action); return json({}); }
  if (path === '/api/rules' && m === 'DELETE') { owner(); await env.DB.prepare('DELETE FROM rules WHERE user_id = ? AND subject = ?').bind(u.id, url.searchParams.get('subject') ?? '').run(); return json({}); }
  const da = /^\/api\/approvals\/(\d+)\/(approve|deny|cancel|prepare)$/.exec(path);
  if (da && m === 'POST') {
    if (da[2] === 'cancel') return json(await cancelApproval(env, c, Number(da[1])));
    owner();
    if (da[2] === 'prepare') return json(await prepareApproval(env, ctx, u, Number(da[1])));
    // Carried out to the end even if the browser goes away while it runs.
    return json(await finishing(ctx, decideApproval(env, ctx, u, Number(da[1]), da[2] === 'approve', da[2] === 'approve' ? await body(req).catch(() => ({})) : {})));
  }
  if (path === '/api/oauth/client' && m === 'GET') { owner(); return json(await oauthClientInfo(env, ctx, url.searchParams)); }
  if (path === '/api/oauth/approve' && m === 'POST') { owner(); return json(await oauthApprove(env, ctx, u, await body(req))); }

  // ---- reading ----
  if (path === '/api/resolve' && m === 'POST') { can('read'); return json({ actors: await resolveMany(env, ctx, (await body(req)).to) }); }
  if (path === '/api/threads' && m === 'GET') { can('read'); return json(await threadsList(env, u)); }
  if (path === '/api/threads/messages' && m === 'GET') { can('read'); return json(await threadMessages(env, u, url.searchParams.get('uri') ?? '', Number(url.searchParams.get('limit') ?? 500))); }
  if (path === '/api/queue' && m === 'GET') { can('read'); return json(await pull(env, u.id, consumerOf(c), Number(url.searchParams.get('since') ?? 0), Number(url.searchParams.get('limit') ?? 50))); }
  if (path === '/api/queue/ack' && m === 'POST') { can('read'); return json(await ack(env, u.id, consumerOf(c), await body(req))); }
  if (path === '/api/requests' && m === 'GET') { can('read'); return json(await listRequests(env, u.id)); }
  if (path === '/api/rules' && m === 'GET') { can('read'); return json((await env.DB.prepare('SELECT subject, action, created_at FROM rules WHERE user_id = ? ORDER BY created_at').bind(u.id).all()).results); }
  if (path === '/api/messages/read' && m === 'POST') { can('read'); return json(await markRead(env, ctx, u, (await body(req)).noteIds)); }
  if (path === '/api/approvals' && m === 'GET') return json(await listApprovals(env, c, url.searchParams.get('status') ?? 'recent'));
  if (path === '/api/attachments/fetch' && m === 'POST') {
    can('read');
    const bytes = await fetchAttachment(env, ctx, u, await body(req));
    return new Response(bytes as unknown as ArrayBuffer, { headers: { 'content-type': 'application/octet-stream' } });
  }

  // ---- sending ----
  if (path === '/api/outbox/prepare' && m === 'POST') { can('send'); return json(await prepare(env, ctx, u, await body(req))); }
  if (path === '/api/attachments' && m === 'POST') { can('send'); return json(await uploadAttachment(env, u, new Uint8Array(await sized(req)))); }

  // ---- managing: an agent's call may be held for the owner (R16) ----
  if (path === '/api/requests/approve' && m === 'POST') return json(await gatedApprove(env, ctx, c, String((await body(req)).actor ?? '')));
  if (path === '/api/requests/block' && m === 'POST') return json(await gatedBlock(env, ctx, c, String((await body(req)).actor ?? '')));
  if (path === '/api/threads/members' && m === 'POST') return json(await gatedMembers(env, ctx, c, await body(req)));
  throw new HttpError(404, 'not_found', 'no such route');
}

/** Lets work that changes state run to its end even if the client disconnects while waiting for the answer. */
export function finishing<T>(ctx: ExecutionContext, p: Promise<T>): Promise<T> {
  ctx.waitUntil(p.then(() => {}, () => {}));
  return p;
}

export async function sendFromApi(env: Env, ctx: ExecutionContext, c: Caller, req: Request) {
  return json(await finishing(ctx, gatedSend(env, ctx, c, await body(req))), 202);
}

async function sized(req: Request): Promise<ArrayBuffer> {
  if (Number(req.headers.get('content-length') ?? '0') > MAX_ATTACHMENT_BYTES) throw new HttpError(413, 'too_large', 'attachments are at most 25 MiB');
  return req.arrayBuffer();
}

export async function uploadAttachment(env: Env, u: UserRow, bytes: Uint8Array) {
  if (bytes.length === 0) throw new HttpError(400, 'bad_request', 'empty file');
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new HttpError(413, 'too_large', 'attachments are at most 25 MiB');
  const id = hex(randomBytes(16));
  const digest = `sha-256=:${b64(await sha256(bytes))}:`;
  await env.FILES.put(`att/${id}`, bytes, { httpMetadata: { contentType: 'application/octet-stream' } });
  await env.DB.prepare('INSERT INTO attachments (id, user_id, size, digest, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, u.id, bytes.length, digest, nowIso()).run();
  return { url: `${new URL(actorUrl(env, u.handle)).origin}/attachments/${id}`, size: bytes.length, digest };
}

export async function fetchAttachment(env: Env, ctx: ExecutionContext, u: UserRow, b: any): Promise<Uint8Array> {
  if (!isUrl(b?.url) || !Number.isInteger(b?.size) || typeof b?.digest !== 'string') throw new HttpError(400, 'bad_request', 'url, size and digest are required');
  const res = await signedFetch(env, ctx, u, 'GET', b.url);
  if (res.status !== 200) throw new HttpError(502, 'attachment_unavailable', `the sender's instance answered ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const digest = `sha-256=:${b64(await sha256(bytes))}:`;
  if (bytes.length !== b.size || digest !== b.digest) throw new HttpError(502, 'attachment_mismatch', 'size or digest does not match the message');
  return bytes;
}
