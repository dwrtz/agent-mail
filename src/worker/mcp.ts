// Owner MCP connector (R12): Streamable HTTP, JSON-RPC 2.0, bearer auth (checked by the caller).
import { Env, HttpError, json, nowIso, UserRow } from './env';
import { meInfo, threadsList, fetchAttachment } from './api';
import { pull, ack, listRequests, approve, block, counts } from './inboxq';
import { prepare, send, markRead } from './outbox';
import { b64 } from '../shared/enc';
import settings from '../../spekkr.inputs.json';

const VERSIONS = ['2025-06-18', '2025-03-26'];
const SERVER_NAME = settings.app_name.toLowerCase().replace(/\s+/g, '-');
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = { type: 'string' }, int = { type: 'integer' };
const payload = obj({ recipient: str, keyId: str, enc: str, ct: str }, ['keyId', 'enc', 'ct']);

const TOOLS = [
  { name: 'whoami', description: 'Your address, actor URL and current encryption key id.', inputSchema: obj({}) },
  { name: 'pull', description: 'Unacked inbox items with cursor > since, oldest first. Bodies are HPKE ciphertext; decrypt with your key file.', inputSchema: obj({ since: int, limit: { type: 'integer', minimum: 1, maximum: 100 } }) },
  { name: 'ack', description: 'Acknowledge delivery (not a read receipt): every item <= upTo, or the listed cursors.', inputSchema: obj({ upTo: int, ids: { type: 'array', items: int } }) },
  { name: 'list_requests', description: 'Messages from senders you have not approved.', inputSchema: obj({}) },
  { name: 'approve', description: 'Allow a sender and move their pending requests into the inbox queue.', inputSchema: obj({ actor: str }, ['actor']) },
  { name: 'block', description: 'Block a sender and drop their pending requests.', inputSchema: obj({ actor: str }, ['actor']) },
  { name: 'list_threads', description: 'Threads with members, unread counts and the latest message (encrypted).', inputSchema: obj({}) },
  { name: 'prepare_message', description: 'Step 1 of sending: give `to` (handles like bob@example.com) for a new thread, `replyTo` (a Note id) to reply, or `threadId`. Returns the note id and every recipient key to encrypt to (HPKE, info and aad as given).', inputSchema: obj({ to: { type: 'array', items: str }, replyTo: str, threadId: str }) },
  { name: 'send_message', description: 'Step 2 of sending: one HPKE payload per recipient plus selfPayload (to your own key). Signs and delivers.', inputSchema: obj({ noteId: str, payloads: { type: 'array', items: payload }, selfPayload: payload, attachments: { type: 'array', items: obj({ url: str, size: int, digest: str }, ['url', 'size', 'digest']) } }, ['noteId', 'payloads', 'selfPayload']) },
  { name: 'mark_read', description: 'Mark messages read; sends Read receipts only if you turned them on.', inputSchema: obj({ noteIds: { type: 'array', items: str } }, ['noteIds']) },
  { name: 'fetch_attachment', description: 'Fetch an attachment (still encrypted) after checking its size and digest. Max 5 MiB here.', inputSchema: obj({ url: str, size: int, digest: str }, ['url', 'size', 'digest']) },
];

async function callTool(env: Env, ctx: ExecutionContext, u: UserRow, name: string, a: any): Promise<unknown> {
  a = a ?? {};
  switch (name) {
    case 'whoami': { const m = await meInfo(env, u); return { address: m.address, actor: m.actor, encKeyId: m.encKeys.at(-1)?.keyId ?? null, readReceipts: m.readReceipts }; }
    case 'pull': return pull(env, u.id, a.since ?? 0, a.limit ?? 50);
    case 'ack': return ack(env, u.id, a);
    case 'list_requests': return listRequests(env, u.id);
    case 'approve': return approve(env, ctx, u.id, String(a.actor ?? ''));
    case 'block': return block(env, u.id, String(a.actor ?? ''));
    case 'list_threads': return threadsList(env, u);
    case 'prepare_message': return prepare(env, ctx, u, a);
    case 'send_message': return send(env, ctx, u, a);
    case 'mark_read': return markRead(env, ctx, u, a.noteIds);
    case 'fetch_attachment': {
      if (a.size > 5 * 1024 * 1024) throw new HttpError(413, 'too_large', 'use POST /api/attachments/fetch for files over 5 MiB');
      return { base64: b64(await fetchAttachment(env, ctx, u, a)) };
    }
  }
  throw new HttpError(404, 'unknown_tool', `no tool ${name}`);
}

const rpc = (id: unknown, result: unknown, headers: Record<string, string> = {}) => json({ jsonrpc: '2.0', id, result }, 200, headers);
const rpcErr = (id: unknown, code: number, message: string, status = 200) => json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, status);

async function session(env: Env, req: Request, u: UserRow) {
  const sid = req.headers.get('mcp-session-id');
  if (!sid) return null;
  const s = await env.DB.prepare('SELECT * FROM mcp_sessions WHERE id = ? AND user_id = ?').bind(sid, u.id).first<{ id: string; subscribed: number }>();
  if (s) await env.DB.prepare('UPDATE mcp_sessions SET last_seen_at = ? WHERE id = ?').bind(nowIso(), sid).run();
  return s;
}

export async function mcp(req: Request, env: Env, ctx: ExecutionContext, u: UserRow): Promise<Response> {
  if (req.method === 'DELETE') {
    const sid = req.headers.get('mcp-session-id');
    if (sid) await env.DB.prepare('DELETE FROM mcp_sessions WHERE id = ? AND user_id = ?').bind(sid, u.id).run();
    return new Response(null, { status: 204 });
  }
  if (req.method === 'GET') {
    if (!(req.headers.get('accept') ?? '').includes('text/event-stream')) return new Response('Use POST, or GET with Accept: text/event-stream', { status: 405, headers: { allow: 'GET, POST, DELETE' } });
    const s = await session(env, req, u);
    if (!s) return rpcErr(null, -32001, 'unknown or missing Mcp-Session-Id', 404);
    return stream(env, s.id, u.id);
  }
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST, DELETE' } });
  let msg: any;
  try { msg = await req.json(); } catch { return rpcErr(null, -32700, 'parse error', 400); }
  if (Array.isArray(msg)) return rpcErr(null, -32600, 'batches are not supported', 400);
  if (msg?.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    if (msg && ('result' in msg || 'error' in msg)) return new Response(null, { status: 202 });
    return rpcErr(msg?.id, -32600, 'invalid request', 400);
  }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    const sid = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO mcp_sessions (id, user_id, subscribed, created_at, last_seen_at) VALUES (?, ?, 0, ?, ?)').bind(sid, u.id, nowIso(), nowIso()).run();
    const v = VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : VERSIONS[0];
    return rpc(id, {
      protocolVersion: v,
      capabilities: { tools: { listChanged: false }, resources: { subscribe: true, listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: '0.1.0' },
      instructions: 'Your agent-mail inbox. pull returns encrypted items; decrypt them on your side with your key file, then ack. Subscribe to inbox://unread for live updates. Never send without the owner approving the text.',
    }, { 'mcp-session-id': sid });
  }
  const s = await session(env, req, u);
  if (!s) return rpcErr(id, -32001, 'unknown or missing Mcp-Session-Id; initialize first', 404);
  if (id === undefined || id === null) return new Response(null, { status: 202 }); // notifications
  switch (method) {
    case 'ping': return rpc(id, {});
    case 'tools/list': return rpc(id, { tools: TOOLS });
    case 'tools/call': {
      try {
        const out = await callTool(env, ctx, u, params?.name, params?.arguments);
        return rpc(id, { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out });
      } catch (e) {
        if (e instanceof HttpError) {
          if (e.code === 'unknown_tool') return rpcErr(id, -32602, e.message);
          return rpc(id, { content: [{ type: 'text', text: JSON.stringify({ error: e.code, detail: e.message }) }], isError: true });
        }
        throw e;
      }
    }
    case 'resources/list': return rpc(id, { resources: [{ uri: 'inbox://unread', name: 'Unread inbox', description: 'Unread count, pending requests and the latest unacked cursor.', mimeType: 'application/json' }] });
    case 'resources/templates/list': return rpc(id, { resourceTemplates: [] });
    case 'resources/read': {
      if (params?.uri !== 'inbox://unread') return rpcErr(id, -32002, 'resource not found');
      return rpc(id, { contents: [{ uri: 'inbox://unread', mimeType: 'application/json', text: JSON.stringify(await counts(env, u.id)) }] });
    }
    case 'resources/subscribe':
    case 'resources/unsubscribe': {
      if (params?.uri !== 'inbox://unread') return rpcErr(id, -32002, 'resource not found');
      await env.DB.prepare('UPDATE mcp_sessions SET subscribed = ? WHERE id = ?').bind(method === 'resources/subscribe' ? 1 : 0, s.id).run();
      return rpc(id, {});
    }
    case 'prompts/list': return rpc(id, { prompts: [] });
  }
  return rpcErr(id, -32601, `method not found: ${method}`);
}

function stream(env: Env, sid: string, userId: number): Response {
  const enc = new TextEncoder();
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const started = Date.now();
      let last = '';
      let lastPing = Date.now();
      controller.enqueue(enc.encode(': connected\n\n'));
      try {
        while (!closed && Date.now() - started < 10 * 60_000) {
          const s = await env.DB.prepare('SELECT subscribed FROM mcp_sessions WHERE id = ?').bind(sid).first<{ subscribed: number }>();
          if (!s) break;
          const c = await counts(env, userId);
          const key = `${c.latestCursor}/${c.requests}`;
          if (last && key !== last && s.subscribed) {
            controller.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: 'inbox://unread' } })}\n\n`));
          }
          last = key;
          if (Date.now() - lastPing > 15_000) { controller.enqueue(enc.encode(': keepalive\n\n')); lastPing = Date.now(); }
          await new Promise(r => setTimeout(r, 2000));
        }
      } catch { /* client went away */ }
      if (!closed) { try { controller.close(); } catch {} }
    },
    cancel() { closed = true; },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'mcp-session-id': sid } });
}
