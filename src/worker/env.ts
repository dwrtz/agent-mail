export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  DELIVERY: Queue<QueueMsg>;
  SITE_URL: string;
  ALLOWED_EMAILS: string;
  ALLOW_SIGNUP: string;
  ALLOW_HTTP_LOCALHOST: string;
  SIGNING_SEED: string;
  /** Seconds an MCP server stream stays open (default 600). Workers Free allows 50 D1 queries per request: set 80 there. */
  STREAM_SECONDS?: string;
  /** "1" lets an owner opt a connector in to a server-held key (R20). Off unless set: the Worker then never sees message text. */
  ALLOW_SERVER_KEYS?: string;
}
export type QueueMsg = { kind: 'deliver'; id: number } | { kind: 'doorbell'; userId: number };

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string, public headers?: Record<string, string>) { super(message ?? code); }
}
export const nowIso = () => new Date().toISOString();
export const isoIn = (s: number) => new Date(Date.now() + s * 1000).toISOString();

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}
export function errorResponse(e: HttpError): Response {
  return json({ error: e.code, detail: e.message }, e.status, e.headers ?? {});
}
export const origin = (env: Env) => env.SITE_URL.replace(/\/+$/, '');
export const host = (env: Env) => new URL(origin(env)).host;
export const actorUrl = (env: Env, handle: string) => `${origin(env)}/users/${handle}`;
export const addressOf = (env: Env, handle: string) => `${handle}@${host(env)}`;

export interface UserRow {
  id: number; handle: string; email: string; name: string; pw_hash: string; pw_salt: string;
  sig_version: number; read_receipts: number; doorbell_url: string | null; doorbell_header: string | null;
  doorbell_value: string | null; doorbell_next_at: string | null; doorbell_pending: number; created_at: string;
  doorbell_extra: string | null;
}

export const SCOPES = ['read', 'send', 'manage'] as const;
export type Scope = typeof SCOPES[number];
/** Things a token must ask the owner before doing (R16). */
export const ASKS = ['first_contact', 'policy', 'members', 'all_sends'] as const;
export type Ask = typeof ASKS[number];
export const DEFAULT_ASK: Ask[] = ['first_contact', 'policy', 'members'];
export interface TokenInfo { id: number; label: string; kind: 'token' | 'oauth'; scopes: Scope[]; ask: Ask[]; /** The instance holds a key for this connector and decrypts for it (R20). */ hosted: boolean }
/** Who is calling: the owner in the web app (session) or an agent holding a connector token. */
export interface Caller { user: UserRow; via: 'session' | 'token'; token?: TokenInfo }
export const serverKeysAllowed = (env: Env) => env.ALLOW_SERVER_KEYS === '1';
export const consumerOf = (c: Caller) => c.token ? `token:${c.token.id}` : 'session';
export const pick = <T extends string>(v: unknown, all: readonly T[]): T[] => {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : [];
  return all.filter(x => list.includes(x));
};
export function requireSession(c: Caller) {
  if (c.via !== 'session') throw new HttpError(403, 'session_required', 'only the owner, signed in to the web app, can do this');
}
export function requireScope(c: Caller, scope: Scope) {
  if (c.token && !c.token.scopes.includes(scope)) throw new HttpError(403, 'insufficient_scope', `this token does not have the ${scope} scope`);
}
export async function userByHandle(env: Env, handle: string): Promise<UserRow | null> {
  return env.DB.prepare('SELECT * FROM users WHERE handle = ?').bind(handle).first<UserRow>();
}
export async function userById(env: Env, id: number): Promise<UserRow | null> {
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
}
export const parseJson = <T = any>(s: string | null | undefined, d: T): T => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
