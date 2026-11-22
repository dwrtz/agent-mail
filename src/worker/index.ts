import { Env, HttpError, json, errorResponse, nowIso, origin, host, QueueMsg, Caller } from './env';
import { webfinger, actorResponse, inbox, outboxCollection, attachmentGet, setSelfHandler } from './federation';
import { signup, login, logout, authenticate } from './auth';
import { ownerApi, sendFromApi } from './api';
import { mcp } from './mcp';
import { oauthRoute, resourceMetadataUrl, CORS } from './oauth';
import { consume, requeueStale } from './outbox';
import { setAllowLocalHttp } from '../shared/activity';
import ui from './ui.gen';
import { testRoutes } from './testroutes';
import settings from '../../spekkr.inputs.json';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** The web app's own client-side routes. Any other unknown path is a JSON 404, not the HTML shell. */
const APP_ROUTES = new Set(['/', '/login', '/signup', '/thread', '/compose', '/requests', '/approvals', '/contacts', '/settings', '/oauth/authorize']);
const DOCS = 'https://github.com/dwrtz/agent-mail/blob/main/docs/agents.md';

/** A cookie is sent by the browser on its own, so a state-changing request that relies on one must come from this site. */
function checkOrigin(req: Request, env: Env) {
  // Only a Bearer header makes the request an agent's; with anything else the cookie is what authenticates it.
  if (STATE_CHANGING.has(req.method) && req.headers.get('cookie') && !req.headers.get('authorization')?.startsWith('Bearer ') && req.headers.get('origin') !== origin(env)) {
    throw new HttpError(403, 'bad_origin', 'Origin must be this site');
  }
}

/** What this instance is and how an agent uses it, for agents that land on it (also served for `Accept: text/markdown`). */
function llmsTxt(env: Env): string {
  const o = origin(env), h = host(env);
  return `# ${settings.app_name} at ${h}

> Federated, end-to-end encrypted messaging for people and their AI agents. This is one instance: it hosts addresses like name@${h}. The server stores only ciphertext.

## If you act for an account on this instance

- MCP endpoint (Streamable HTTP): ${o}/mcp
- Sign in with OAuth 2.1 (metadata: ${o}/.well-known/oauth-protected-resource), or send a connector token as \`Authorization: Bearer <token>\`. The owner creates agents and tokens under Settings.
- Message text is encrypted to the account's keys, so the MCP endpoint returns ciphertext. Decrypt and encrypt on your side with the agent file the owner gave you. The agent-mail CLI does both, and \`agent-mail mcp\` runs a local MCP server with plaintext tools (read_inbox, reply, send).
- You work on your own. Calls that answer \`{"status":"pending_approval"}\` wait for the owner; do not retry them.
- Setup guide: ${DOCS}

## If you want to write to someone here

- Find an address: GET ${o}/.well-known/webfinger?resource=acct:name@${h}
- The \`self\` link is the actor document: its inbox and its signing and encryption keys.
- Deliver a signed (RFC 9421), HPKE-encrypted \`Create\` to that inbox. Wire format: https://spekkr.com/dwrtz/agent-mail/
`;
}

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
    // Browser-based MCP clients call these cross-origin. Nothing here trusts a cookie, so any origin may ask.
    if (m === 'OPTIONS' && (path === '/mcp' || path.startsWith('/oauth/') || path.startsWith('/.well-known/'))) return new Response(null, { status: 204, headers: CORS });
    const um = /^\/users\/([a-z0-9_]{1,32})(\/inbox|\/outbox)?$/.exec(path);
    if (um) {
      const [, h, sub] = um;
      if (!sub && m === 'GET') return await actorResponse(env, h);
      if (sub === '/inbox' && m === 'POST') return await inbox(req, env, ctx, h);
      if (sub === '/outbox' && m === 'GET') { await actorResponse(env, h); return outboxCollection(env, h); }
      if (sub === '/outbox' && m === 'POST') {
        checkOrigin(req, env);
        const c = await requireCaller(env, req);
        if (c.user.handle !== h) throw new HttpError(403, 'forbidden', 'not your outbox');
        return await sendFromApi(env, ctx, c, req);
      }
      throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    }
    const am = /^\/attachments\/([^/]+)$/.exec(path);
    if (am && m === 'GET') {
      const a = req.headers.get('signature-input') ? null : await authenticate(env, req);
      return await attachmentGet(req, env, ctx, am[1], a?.user.id ?? null);
    }
    const oauth = await oauthRoute(req, env, ctx, path);
    if (oauth) return oauth;
    if (path === '/mcp') {
      const c = req.headers.get('authorization')?.startsWith('Bearer ') ? await authenticate(env, req) : null;
      if (!c?.token) {
        return json({ error: 'unauthorized', detail: 'Authorization: Bearer <connector token or OAuth access token> required' }, 401,
          { ...CORS, 'www-authenticate': `Bearer resource_metadata="${resourceMetadataUrl(env)}"` });
      }
      const r = await mcp(req, env, ctx, c);
      const headers = new Headers(r.headers);
      for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
      return new Response(r.body, { status: r.status, headers });
    }
    if (path.startsWith('/api/')) {
      checkOrigin(req, env);
      if (path === '/api/auth/signup' && m === 'POST') { const r = await signup(env, await req.json().catch(() => ({}))); return json({ ok: true }, 200, { 'set-cookie': r.cookie }); }
      if (path === '/api/auth/login' && m === 'POST') { const r = await login(env, await req.json().catch(() => ({}))); return json({ ok: true }, 200, { 'set-cookie': r.cookie }); }
      if (path === '/api/auth/logout' && m === 'POST') return json({}, 200, { 'set-cookie': await logout(env, req) });
      if (path === '/api/config' && m === 'GET') return json({ host: host(env), origin: origin(env) });
      return await ownerApi(req, env, ctx, await requireCaller(env, req), path);
    }
    if (m === 'GET' || m === 'HEAD') {
      if (path === '/app.js') return new Response(ui.js, { headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' } });
      if (path === '/app.css') return new Response(ui.css, { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' } });
      if (path === '/robots.txt') return new Response('User-agent: *\nAllow: /$\nAllow: /llms.txt\nDisallow: /\n', { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'max-age=3600' } });
      if (path === '/llms.txt') return new Response(llmsTxt(env), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'max-age=300', 'access-control-allow-origin': '*' } });
      if (APP_ROUTES.has(path)) {
        // An agent that asks for Markdown gets the description of the instance instead of a JavaScript app.
        const accept = req.headers.get('accept') ?? '';
        if (path === '/' && accept.includes('text/markdown') && !accept.includes('text/html')) {
          return new Response(llmsTxt(env), { headers: { 'content-type': 'text/markdown; charset=utf-8', vary: 'accept', 'cache-control': 'max-age=300' } });
        }
        return new Response(ui.html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin', vary: 'accept',
          link: '</llms.txt>; rel="describedby"; type="text/plain"',
          'content-security-policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'" } });
      }
    }
    throw new HttpError(404, 'not_found', 'no such route');
  } catch (e) {
    if (e instanceof HttpError) return errorResponse(e);
    console.log('[error]', path, String((e as Error)?.stack ?? e).slice(0, 500));
    return json({ error: 'internal', detail: 'internal error' }, 500);
  }
}

async function requireCaller(env: Env, req: Request): Promise<Caller> {
  const c = await authenticate(env, req);
  if (!c) throw new HttpError(401, 'unauthorized', 'sign in or send a connector token');
  return c;
}

setSelfHandler(handle);

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
      env.DB.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').bind(now),
      env.DB.prepare('DELETE FROM oauth_tokens WHERE refresh_expires_at < ?').bind(now),
      // A registered client is forgotten when nothing was granted to it and it was never used (after a week) or not used for 90 days.
      env.DB.prepare(`DELETE FROM oauth_clients WHERE source = 'registered' AND client_id NOT IN (SELECT client_id FROM api_tokens WHERE client_id IS NOT NULL)
          AND ((fetched_at = created_at AND created_at < ?) OR fetched_at < ?)`).bind(ago(7 * 86400), ago(90 * 86400)),
      env.DB.prepare("UPDATE approvals SET status = 'expired', decided_at = ? WHERE status = 'pending' AND expires_at < ?").bind(now, now),
      env.DB.prepare("DELETE FROM approvals WHERE status NOT IN ('pending', 'approving') AND created_at < ?").bind(ago(90 * 86400)),
    ]);
    await requeueStale(env);
  },
} satisfies ExportedHandler<Env, QueueMsg>;
