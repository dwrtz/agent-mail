// OAuth 2.1 for the MCP connector (R17), so hosted clients can connect without a pasted token:
// protected-resource metadata (RFC 9728), authorization-server metadata (RFC 8414), dynamic client
// registration (RFC 7591), client id metadata documents, authorization code with PKCE S256, refresh tokens.
// A grant is a connector token made through the consent screen: same scopes, same ask rules, revoked the same way.
import { Env, HttpError, json, nowIso, isoIn, origin, UserRow, SCOPES, ASKS, DEFAULT_ASK, pick, parseJson } from './env';
import { createToken } from './auth';
import { federatedFetch } from './federation';
import { isUrl } from '../shared/activity';
import { b64url, hex, randomBytes, sha256 } from '../shared/enc';
import settings from '../../spekkr.inputs.json';

const ACCESS_SECONDS = 3600;
const REFRESH_SECONDS = 90 * 86400;
const CODE_SECONDS = 300;
export const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id',
  'access-control-expose-headers': 'mcp-session-id, www-authenticate',
  'access-control-max-age': '86400',
};
export const resourceMetadataUrl = (env: Env) => `${origin(env)}/.well-known/oauth-protected-resource`;

const oauthError = (error: string, description: string, status = 400) =>
  json({ error, error_description: description }, status, { ...CORS, 'cache-control': 'no-store' });

/** Public OAuth endpoints. Returns null for any other path. */
export async function oauthRoute(req: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response | null> {
  const o = origin(env);
  if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
    return json({ resource: `${o}/mcp`, authorization_servers: [o], scopes_supported: SCOPES, bearer_methods_supported: ['header'], resource_name: settings.app_name }, 200, CORS);
  }
  if (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/oauth-authorization-server/mcp') {
    return json({
      issuer: o, authorization_endpoint: `${o}/oauth/authorize`, token_endpoint: `${o}/oauth/token`, registration_endpoint: `${o}/oauth/register`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'], scopes_supported: SCOPES,
      client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true,
    }, 200, CORS);
  }
  if (path === '/oauth/register' && req.method === 'POST') return register(req, env);
  if (path === '/oauth/token' && req.method === 'POST') return token(req, env);
  return null;
}

// ---- clients ----
interface Client { client_id: string; name: string; redirect_uris: string[] }
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const BAD_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'about:', 'blob:', 'ws:', 'wss:']);

/** https anywhere, http only on loopback, or an app's own scheme. Never a fragment. */
function okRedirect(uri: unknown): uri is string {
  if (typeof uri !== 'string' || uri.length > 2000) return false;
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash || BAD_SCHEMES.has(u.protocol)) return false;
  if (u.protocol === 'http:') return LOOPBACK.has(u.hostname);
  return true;
}
/** Exact match, except that a loopback redirect may use any port (RFC 8252 section 7.3). */
function redirectMatches(registered: string, asked: string): boolean {
  if (registered === asked) return true;
  try {
    const a = new URL(registered), b = new URL(asked);
    if (a.protocol !== 'http:' || b.protocol !== 'http:' || !LOOPBACK.has(a.hostname) || !LOOPBACK.has(b.hostname)) return false;
    a.port = ''; b.port = '';
    return a.href === b.href;
  } catch { return false; }
}
const cleanName = (v: unknown, fallback: string) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) : '') || fallback;

async function register(req: Request, env: Env): Promise<Response> {
  const text = await req.text();
  if (text.length > 16384) return oauthError('invalid_client_metadata', 'registration body is too large');
  const b = parseJson<any>(text, null);
  if (!b || !Array.isArray(b.redirect_uris) || b.redirect_uris.length < 1 || b.redirect_uris.length > 10) return oauthError('invalid_redirect_uri', 'redirect_uris must list 1 to 10 URIs');
  if (!b.redirect_uris.every(okRedirect)) return oauthError('invalid_redirect_uri', 'each redirect URI must be https, http on loopback, or an app scheme, without a fragment');
  if (b.token_endpoint_auth_method && b.token_endpoint_auth_method !== 'none') return oauthError('invalid_client_metadata', 'only public clients (token_endpoint_auth_method "none") are supported');
  const client_id = 'amc_' + b64url(randomBytes(18));
  const name = cleanName(b.client_name, 'MCP client');
  await env.DB.prepare("INSERT INTO oauth_clients (client_id, name, redirect_uris, source, created_at, fetched_at) VALUES (?, ?, ?, 'registered', ?, ?)")
    .bind(client_id, name, JSON.stringify(b.redirect_uris), nowIso(), nowIso()).run();
  return json({
    client_id, client_name: name, redirect_uris: b.redirect_uris, token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], client_id_issued_at: Math.floor(Date.now() / 1000),
  }, 201, { ...CORS, 'cache-control': 'no-store' });
}

/** A registered client, or one whose client_id is the https URL of its metadata document. */
async function getClient(env: Env, ctx: ExecutionContext, clientId: string): Promise<Client | null> {
  if (!clientId || clientId.length > 2000) return null;
  const row = await env.DB.prepare('SELECT client_id, name, redirect_uris, source, fetched_at FROM oauth_clients WHERE client_id = ?').bind(clientId).first<{ client_id: string; name: string; redirect_uris: string; source: string; fetched_at: string }>();
  const fromRow = () => ({ client_id: row!.client_id, name: row!.name, redirect_uris: parseJson<string[]>(row!.redirect_uris, []) });
  if (row && (row.source === 'registered' || Date.parse(row.fetched_at) > Date.now() - 86400_000)) return fromRow();
  if (!isUrl(clientId) || new URL(clientId).pathname === '/') return row ? fromRow() : null;
  let doc: any = null;
  try {
    const res = await federatedFetch(env, ctx, clientId, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
    const buf = res.status === 200 ? new Uint8Array(await res.arrayBuffer()) : null;
    if (buf && buf.length <= 65536) doc = parseJson<any>(new TextDecoder().decode(buf), null);
  } catch { /* unreachable */ }
  if (!doc || doc.client_id !== clientId || !Array.isArray(doc.redirect_uris) || doc.redirect_uris.length > 10 || !doc.redirect_uris.every(okRedirect)) return row ? fromRow() : null;
  const name = cleanName(doc.client_name, new URL(clientId).host);
  await env.DB.prepare(`INSERT INTO oauth_clients (client_id, name, redirect_uris, source, created_at, fetched_at) VALUES (?, ?, ?, 'metadata', ?, ?)
      ON CONFLICT(client_id) DO UPDATE SET name = excluded.name, redirect_uris = excluded.redirect_uris, fetched_at = excluded.fetched_at`)
    .bind(clientId, name, JSON.stringify(doc.redirect_uris), nowIso(), nowIso()).run();
  return { client_id: clientId, name, redirect_uris: doc.redirect_uris };
}

// ---- the authorization request (checked for the consent screen, and again when the owner allows it) ----
interface AuthRequest { client: Client; redirectUri: string; state: string; challenge: string; scopes: string[] }
async function authRequest(env: Env, ctx: ExecutionContext, get: (k: string) => string): Promise<AuthRequest> {
  const bad = (m: string) => new HttpError(400, 'invalid_request', m);
  const client = await getClient(env, ctx, get('client_id'));
  if (!client) throw bad('Unknown client. The app that sent you here is not registered with this instance.');
  const redirectUri = get('redirect_uri') || (client.redirect_uris.length === 1 ? client.redirect_uris[0] : '');
  if (!okRedirect(redirectUri) || !client.redirect_uris.some(r => redirectMatches(r, redirectUri))) throw bad('The redirect address does not belong to this app.');
  if (get('response_type') !== 'code') throw bad('Only response_type=code is supported.');
  const challenge = get('code_challenge');
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge) || get('code_challenge_method') !== 'S256') throw bad('PKCE with code_challenge_method=S256 is required.');
  const resource = get('resource');
  if (resource && !resource.startsWith(origin(env))) throw new HttpError(400, 'invalid_target', 'This instance only issues tokens for its own MCP endpoint.');
  const asked = pick(get('scope'), SCOPES);
  return { client, redirectUri, state: get('state').slice(0, 2000), challenge, scopes: asked.length ? asked : [...SCOPES] };
}

/** What the consent screen shows. */
export async function oauthClientInfo(env: Env, ctx: ExecutionContext, q: URLSearchParams) {
  const r = await authRequest(env, ctx, k => q.get(k) ?? '');
  let redirectHost = r.redirectUri;
  try { const u = new URL(r.redirectUri); redirectHost = u.host || u.protocol; } catch { /* keep */ }
  return { clientId: r.client.client_id, name: r.client.name, redirectUri: r.redirectUri, redirectHost, state: r.state, scopes: r.scopes, defaultAsk: DEFAULT_ASK, resource: `${origin(env)}/mcp` };
}

/** The owner allowed (or denied) the request: returns where to send the browser. */
export async function oauthApprove(env: Env, ctx: ExecutionContext, u: UserRow, b: any) {
  const p = b?.params && typeof b.params === 'object' ? b.params : {};
  const r = await authRequest(env, ctx, k => typeof p[k] === 'string' ? p[k] : '');
  const back = new URL(r.redirectUri);
  if (r.state) back.searchParams.set('state', r.state);
  back.searchParams.set('iss', origin(env));
  if (b.allow !== true) { back.searchParams.set('error', 'access_denied'); return { redirect: back.href }; }
  const scopes = b.scopes === undefined ? r.scopes : pick(b.scopes, SCOPES).filter(s => r.scopes.includes(s));
  if (!scopes.length) throw new HttpError(400, 'bad_request', 'allow at least one scope');
  const ask = b.ask === undefined ? DEFAULT_ASK : pick(b.ask, ASKS);
  const code = 'amz_' + b64url(randomBytes(32));
  await env.DB.prepare('INSERT INTO oauth_codes (code_hash, user_id, client_id, client_name, redirect_uri, challenge, scopes, ask, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(hex(await sha256(code)), u.id, r.client.client_id, r.client.name, r.redirectUri, r.challenge, scopes.join(' '), ask.join(' '), isoIn(CODE_SECONDS)).run();
  back.searchParams.set('code', code);
  return { redirect: back.href };
}

// ---- the token endpoint ----
async function issue(env: Env, tokenId: number, clientId: string, scopes: string) {
  const access = 'amo_' + b64url(randomBytes(32)), refresh = 'amr_' + b64url(randomBytes(32));
  await env.DB.prepare('INSERT INTO oauth_tokens (access_hash, refresh_hash, token_id, client_id, access_expires_at, refresh_expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(hex(await sha256(access)), hex(await sha256(refresh)), tokenId, clientId, isoIn(ACCESS_SECONDS), isoIn(REFRESH_SECONDS)).run();
  return json({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: scopes }, 200, { ...CORS, 'cache-control': 'no-store', pragma: 'no-cache' });
}

async function token(req: Request, env: Env): Promise<Response> {
  let p: Record<string, string> = {};
  const text = await req.text();
  if (text.length > 16384) return oauthError('invalid_request', 'body is too large');
  if ((req.headers.get('content-type') ?? '').includes('application/json')) {
    const j = parseJson<Record<string, unknown>>(text, {});
    for (const [k, v] of Object.entries(j)) if (typeof v === 'string') p[k] = v;
  } else p = Object.fromEntries(new URLSearchParams(text));
  if (p.grant_type === 'authorization_code') {
    if (!p.code || !p.code_verifier) return oauthError('invalid_request', 'code and code_verifier are required');
    // Single use: the row is deleted as it is read.
    const c = await env.DB.prepare('DELETE FROM oauth_codes WHERE code_hash = ? RETURNING *').bind(hex(await sha256(p.code))).first<{ user_id: number; client_id: string; client_name: string; redirect_uri: string; challenge: string; scopes: string; ask: string; expires_at: string }>();
    if (!c || c.expires_at < nowIso()) return oauthError('invalid_grant', 'the authorization code is unknown, used or expired');
    if (p.client_id !== c.client_id) return oauthError('invalid_grant', 'the code was issued to another client');
    if (p.redirect_uri && !redirectMatches(c.redirect_uri, p.redirect_uri)) return oauthError('invalid_grant', 'redirect_uri does not match the authorization request');
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(p.code_verifier) || b64url(await sha256(p.code_verifier)) !== c.challenge) return oauthError('invalid_grant', 'code_verifier does not match the code challenge');
    const t = await createToken(env, c.user_id, { kind: 'oauth', label: c.client_name, scopes: c.scopes, ask: c.ask, clientId: c.client_id });
    return issue(env, t.id, c.client_id, c.scopes);
  }
  if (p.grant_type === 'refresh_token') {
    if (!p.refresh_token) return oauthError('invalid_request', 'refresh_token is required');
    // Rotation: the old pair is deleted as it is read, so a refresh token works once.
    const r = await env.DB.prepare('DELETE FROM oauth_tokens WHERE refresh_hash = ? RETURNING token_id, client_id, refresh_expires_at').bind(hex(await sha256(p.refresh_token))).first<{ token_id: number; client_id: string; refresh_expires_at: string }>();
    if (!r || r.refresh_expires_at < nowIso()) return oauthError('invalid_grant', 'the refresh token is unknown, used or expired');
    if (p.client_id && p.client_id !== r.client_id) return oauthError('invalid_grant', 'the refresh token was issued to another client');
    const grant = await env.DB.prepare('SELECT scopes FROM api_tokens WHERE id = ?').bind(r.token_id).first<{ scopes: string }>();
    if (!grant) return oauthError('invalid_grant', 'access was revoked');
    return issue(env, r.token_id, r.client_id, grant.scopes);
  }
  return oauthError('unsupported_grant_type', 'use authorization_code or refresh_token');
}
