import { Env, HttpError, json, errorResponse, nowIso, origin, QueueMsg } from './env';
import { webfinger, actorResponse, inbox, outboxCollection, attachmentGet, setSelfHandler } from './federation';
import { signup, login, logout, authenticate } from './auth';
import { ownerApi, sendFromApi, meInfo } from './api';
import { mcp } from './mcp';
import { consume } from './outbox';
import { setAllowLocalHttp } from '../shared/activity';
import ui from './ui.gen';
import { testRoutes } from './testroutes';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function handle(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  setAllowLocalHttp(env.ALLOW_HTTP_LOCALHOST === '1');
  const url = new URL(req.url);
  const path = url.pathname;
  const m = req.method;
  try {
    if ((env as any).TEST_ROUTES === '1' && path.startsWith('/__test/')) {
      const r = await testRoutes(req, env, path);
      if (r) return r;
    }
    if (path === '/.well-known/webfinger') {
      if (m === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET' } });
      return await webfinger(req, env);
    }
    const um = /^\/users\/([a-z0-9_]{1,32})(\/inbox|\/outbox)?$/.exec(path);
    if (um) {
      const [, h, sub] = um;
      if (!sub && m === 'GET') return await actorResponse(env, h);
      if (sub === '/inbox' && m === 'POST') return await inbox(req, env, ctx, h);
      if (sub === '/outbox' && m === 'GET') { await actorResponse(env, h); return outboxCollection(env, h); }
      if (sub === '/outbox' && m === 'POST') {
        const a = await requireUser(env, req);
        if (a.handle !== h) throw new HttpError(403, 'forbidden', 'not your outbox');
        return await sendFromApi(env, ctx, a, req);
      }
      throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    }
    const am = /^\/attachments\/([^/]+)$/.exec(path);
    if (am && m === 'GET') {
      const a = req.headers.get('signature-input') ? null : await authenticate(env, req);
      return await attachmentGet(req, env, ctx, am[1], a?.user.id ?? null);
    }
    if (path === '/mcp') {
      const a = req.headers.get('authorization')?.startsWith('Bearer ') ? await authenticate(env, req) : null;
      if (!a) return json({ error: 'unauthorized', detail: 'Authorization: Bearer <connector token> required' }, 401, { 'www-authenticate': 'Bearer' });
      return await mcp(req, env, ctx, a.user);
    }
    if (path.startsWith('/api/')) {
      if (STATE_CHANGING.has(m) && req.headers.get('cookie') && !req.headers.get('authorization')) {
        if (req.headers.get('origin') !== origin(env)) throw new HttpError(403, 'bad_origin', 'Origin must be this site');
      }
      if (path === '/api/auth/signup' && m === 'POST') { const r = await signup(env, await req.json().catch(() => ({}))); return json({ ok: true }, 200, { 'set-cookie': r.cookie }); }
      if (path === '/api/auth/login' && m === 'POST') { const r = await login(env, await req.json().catch(() => ({}))); return json({ ok: true }, 200, { 'set-cookie': r.cookie }); }
      if (path === '/api/auth/logout' && m === 'POST') return json({}, 200, { 'set-cookie': await logout(env, req) });
      if (path === '/api/config' && m === 'GET') return json({ host: new URL(origin(env)).host, origin: origin(env) });
      const u = await requireUser(env, req);
      return await ownerApi(req, env, ctx, u, path);
    }
    if (m === 'GET' || m === 'HEAD') {
      if (path === '/app.js') return new Response(ui.js, { headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' } });
      if (path === '/app.css') return new Response(ui.css, { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' } });
      if (path === '/favicon.ico') return new Response(null, { status: 404 });
      return new Response(ui.html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin',
        'content-security-policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'" } });
    }
    throw new HttpError(404, 'not_found', 'no such route');
  } catch (e) {
    if (e instanceof HttpError) return errorResponse(e);
    console.log('[error]', path, String((e as Error)?.stack ?? e).slice(0, 500));
    return json({ error: 'internal', detail: 'internal error' }, 500);
  }
}

async function requireUser(env: Env, req: Request) {
  const a = await authenticate(env, req);
  if (!a) throw new HttpError(401, 'unauthorized', 'sign in or send a connector token');
  return a.user;
}

setSelfHandler(handle);
void meInfo;

export default {
  fetch: handle,
  async queue(batch: MessageBatch<QueueMsg>, env: Env, ctx: ExecutionContext) {
    setAllowLocalHttp(env.ALLOW_HTTP_LOCALHOST === '1');
    await consume(batch, env, ctx);
  },
  async scheduled(_c: ScheduledController, env: Env) {
    const now = nowIso();
    const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM nonces WHERE expires_at < ?').bind(now),
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
      env.DB.prepare('DELETE FROM drafts WHERE expires_at < ?').bind(now),
      env.DB.prepare('DELETE FROM rate WHERE minute < ?').bind(ago(120).slice(0, 16)),
      env.DB.prepare('DELETE FROM actor_cache WHERE fetched_at < ?').bind(ago(86400)),
      env.DB.prepare('DELETE FROM mcp_sessions WHERE last_seen_at < ?').bind(ago(86400)),
    ]);
  },
} satisfies ExportedHandler<Env, QueueMsg>;
