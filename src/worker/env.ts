export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  DELIVERY: Queue<QueueMsg>;
  SITE_URL: string;
  ALLOWED_EMAILS: string;
  ALLOW_SIGNUP: string;
  ALLOW_HTTP_LOCALHOST: string;
  SIGNING_SEED: string;
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
}
export async function userByHandle(env: Env, handle: string): Promise<UserRow | null> {
  return env.DB.prepare('SELECT * FROM users WHERE handle = ?').bind(handle).first<UserRow>();
}
export async function userById(env: Env, id: number): Promise<UserRow | null> {
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
}
export const parseJson = <T = any>(s: string | null | undefined, d: T): T => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
