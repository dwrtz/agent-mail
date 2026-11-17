// The owner API (design.md, "Owner API").
import { Env, HttpError, json, nowIso, actorUrl, addressOf, UserRow, parseJson } from './env';
import { encKeys } from './keys';
import { pull, ack, listRequests, approve, block, setRule, counts, doorbell, unreadMessages } from './inboxq';
import { resolveMany, prepare, send, changeMembers, markRead } from './outbox';
import { createToken } from './auth';
import { signedFetch } from './federation';
import { b64, b64url, randomBytes, hex, sha256, unb64url } from '../shared/enc';
import { MAX_ATTACHMENT_BYTES, isUrl } from '../shared/activity';
import { normalizeDoorbellHeader, normalizeDoorbellValue } from '../shared/doorbell';

export async function meInfo(env: Env, u: UserRow) {
  const actor = actorUrl(env, u.handle);
  return {
    handle: u.handle, name: u.name, email: u.email, actor, address: addressOf(env, u.handle), readReceipts: !!u.read_receipts,
    encKeys: (await encKeys(env, u.id)).map(k => ({ n: k.n, keyId: `${actor}#enc-${k.n}`, publicKey: k.public_key })),
    doorbell: { url: u.doorbell_url ?? '', header: u.doorbell_header ?? 'Authorization', valueSet: !!u.doorbell_value },
    ...(await counts(env, u.id)),
    unreadMessages: await unreadMessages(env, u.id),
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

export async function threadMessages(env: Env, u: UserRow, uri: string) {
  const rows = (await env.DB.prepare(`SELECT id, direction, type, actor, activity, published, gap_before, read_at, read_by, state FROM messages
      WHERE user_id = ? AND thread = ? AND (direction = 'out' OR state = 'queued') ORDER BY published, id`).bind(u.id, uri).all<any>()).results;
  const out = [];
  for (const r of rows) {
    const deliveries = r.direction === 'out'
      ? (await env.DB.prepare('SELECT target, status, attempts, last_error FROM deliveries WHERE message_id = ? AND user_id = ?').bind(r.id, u.id).all<any>()).results
      : undefined;
    out.push({ id: r.id, direction: r.direction, type: r.type, actor: r.actor, activity: JSON.parse(r.activity), published: r.published, gapBefore: r.gap_before, readAt: r.read_at, readBy: parseJson(r.read_by, {}), deliveries });
  }
  return out;
}

async function body(req: Request) { try { return await req.json<any>(); } catch { throw new HttpError(400, 'bad_request', 'body must be JSON'); } }

export async function ownerApi(req: Request, env: Env, ctx: ExecutionContext, u: UserRow, path: string): Promise<Response> {
  const m = req.method;
  const url = new URL(req.url);
  if (path === '/api/me' && m === 'GET') return json({ user: await meInfo(env, u) });
  if (path === '/api/keys/encryption' && m === 'PUT') {
    const { publicKey } = await body(req);
    let raw: Uint8Array;
    try { raw = unb64url(String(publicKey)); } catch { throw new HttpError(400, 'bad_request', 'publicKey must be base64url'); }
    if (raw.length !== 32) throw new HttpError(400, 'bad_request', 'publicKey must be 32 bytes');
    const ks = await encKeys(env, u.id);
    const same = ks.find(k => k.public_key === b64url(raw));
    if (same) return json({ keyId: `${actorUrl(env, u.handle)}#enc-${same.n}` });
    const n = (ks.at(-1)?.n ?? 0) + 1;
    await env.DB.prepare('INSERT INTO enc_keys (user_id, n, public_key, created_at) VALUES (?, ?, ?, ?)').bind(u.id, n, b64url(raw), nowIso()).run();
    return json({ keyId: `${actorUrl(env, u.handle)}#enc-${n}` });
  }
  const dk = /^\/api\/keys\/encryption\/(\d+)$/.exec(path);
  if (dk && m === 'DELETE') {
    const ks = await encKeys(env, u.id);
    if (ks.length <= 1) throw new HttpError(400, 'bad_request', 'cannot remove your only key');
    if (ks.at(-1)!.n === Number(dk[1])) throw new HttpError(400, 'bad_request', 'cannot remove your newest key');
    await env.DB.prepare('DELETE FROM enc_keys WHERE user_id = ? AND n = ?').bind(u.id, Number(dk[1])).run();
    return json({});
  }
  if (path === '/api/settings' && m === 'PUT') {
    const b = await body(req);
    if (typeof b.name === 'string') await env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(b.name.trim().slice(0, 80) || u.handle, u.id).run();
    if (typeof b.readReceipts === 'boolean') await env.DB.prepare('UPDATE users SET read_receipts = ? WHERE id = ?').bind(b.readReceipts ? 1 : 0, u.id).run();
    if (typeof b.doorbellUrl === 'string') {
      const v = b.doorbellUrl.trim();
      if (v && !isUrl(v)) throw new HttpError(400, 'bad_request', 'doorbell URL must be https');
      await env.DB.prepare('UPDATE users SET doorbell_url = ? WHERE id = ?').bind(v || null, u.id).run();
    }
    if (typeof b.doorbellHeader === 'string') {
      const v = normalizeDoorbellHeader(b.doorbellHeader);
      if (v && !/^[A-Za-z0-9-]{1,64}$/.test(v)) throw new HttpError(400, 'bad_request', 'header name: letters, digits and dashes');
      await env.DB.prepare('UPDATE users SET doorbell_header = ? WHERE id = ?').bind(v || null, u.id).run();
    }
    if (typeof b.doorbellValue === 'string') {
      const header = typeof b.doorbellHeader === 'string'
        ? (normalizeDoorbellHeader(b.doorbellHeader) || 'Authorization')
        : (u.doorbell_header || 'Authorization');
      const v = normalizeDoorbellValue(b.doorbellValue, header);
      await env.DB.prepare('UPDATE users SET doorbell_value = ? WHERE id = ?').bind(v || null, u.id).run();
    }
    const fresh = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(u.id).first<UserRow>();
    return json({ user: await meInfo(env, fresh!) });
  }
  if (path === '/api/doorbell/test' && m === 'POST') {
    if (!u.doorbell_url) throw new HttpError(400, 'bad_request', 'set a doorbell URL first');
    return json({ status: await doorbell(env, ctx, u.id, false, true) });
  }
  if (path === '/api/tokens' && m === 'GET') return json({ tokens: (await env.DB.prepare('SELECT id, label, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY id').bind(u.id).all()).results });
  if (path === '/api/tokens' && m === 'POST') return json({ token: await createToken(env, u.id, String((await body(req)).label ?? '')) });
  const dt = /^\/api\/tokens\/(\d+)$/.exec(path);
  if (dt && m === 'DELETE') { await env.DB.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').bind(Number(dt[1]), u.id).run(); return json({}); }
  if (path === '/api/resolve' && m === 'POST') return json({ actors: await resolveMany(env, ctx, (await body(req)).to) });
  if (path === '/api/outbox/prepare' && m === 'POST') return json(await prepare(env, ctx, u, await body(req)));
  if (path === '/api/threads' && m === 'GET') return json(await threadsList(env, u));
  if (path === '/api/threads/messages' && m === 'GET') return json(await threadMessages(env, u, url.searchParams.get('uri') ?? ''));
  if (path === '/api/threads/members' && m === 'POST') return json(await changeMembers(env, ctx, u, await body(req)));
  if (path === '/api/queue' && m === 'GET') return json(await pull(env, u.id, Number(url.searchParams.get('since') ?? 0), Number(url.searchParams.get('limit') ?? 50)));
  if (path === '/api/queue/ack' && m === 'POST') return json(await ack(env, u.id, await body(req)));
  if (path === '/api/requests' && m === 'GET') return json(await listRequests(env, u.id));
  if (path === '/api/requests/approve' && m === 'POST') return json(await approve(env, ctx, u.id, String((await body(req)).actor ?? '')));
  if (path === '/api/requests/block' && m === 'POST') return json(await block(env, u.id, String((await body(req)).actor ?? '')));
  if (path === '/api/rules' && m === 'GET') return json((await env.DB.prepare('SELECT subject, action, created_at FROM rules WHERE user_id = ? ORDER BY created_at').bind(u.id).all()).results);
  if (path === '/api/rules' && m === 'PUT') { const b = await body(req); await setRule(env, u.id, String(b.subject ?? ''), b.action); return json({}); }
  if (path === '/api/rules' && m === 'DELETE') { await env.DB.prepare('DELETE FROM rules WHERE user_id = ? AND subject = ?').bind(u.id, url.searchParams.get('subject') ?? '').run(); return json({}); }
  if (path === '/api/messages/read' && m === 'POST') return json(await markRead(env, ctx, u, (await body(req)).noteIds));
  if (path === '/api/attachments' && m === 'POST') return json(await uploadAttachment(env, u, req));
  if (path === '/api/attachments/fetch' && m === 'POST') {
    const b = await body(req);
    const bytes = await fetchAttachment(env, ctx, u, b);
    return new Response(bytes as unknown as ArrayBuffer, { headers: { 'content-type': 'application/octet-stream' } });
  }
  throw new HttpError(404, 'not_found', 'no such route');
}

export async function sendFromApi(env: Env, ctx: ExecutionContext, u: UserRow, req: Request) {
  return json(await send(env, ctx, u, await body(req)), 202);
}

async function uploadAttachment(env: Env, u: UserRow, req: Request) {
  const len = Number(req.headers.get('content-length') ?? '0');
  if (len > MAX_ATTACHMENT_BYTES) throw new HttpError(413, 'too_large', 'attachments are at most 25 MiB');
  const bytes = new Uint8Array(await req.arrayBuffer());
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
