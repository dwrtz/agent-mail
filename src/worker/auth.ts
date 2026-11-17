// Accounts, sessions and connector tokens (R2, R12).
import { Env, HttpError, nowIso, isoIn, UserRow, origin } from './env';
import { b64url, hex, randomBytes, sha256, te, unb64url } from '../shared/enc';
import { HANDLE_RE } from '../shared/activity';

const ITER = 100_000;
async function pbkdf2(password: string, salt: Uint8Array) {
  const key = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: ITER }, key, 256));
}
const eq = (a: Uint8Array, b: Uint8Array) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; };

export function allowedEmail(env: Env, email: string) {
  const list = (env.ALLOWED_EMAILS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return list.length === 0 || list.includes(email.trim().toLowerCase());
}

const cookie = (token: string, maxAge: number, env: Env) =>
  `am_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${origin(env).startsWith('https:') ? '; Secure' : ''}`;

async function newSession(env: Env, userId: number) {
  const token = b64url(randomBytes(32));
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(hex(await sha256(token)), userId, isoIn(30 * 86400)).run();
  return cookie(token, 30 * 86400, env);
}

export async function signup(env: Env, body: any) {
  const email = String(body?.email ?? '').trim();
  const password = String(body?.password ?? '');
  const handle = String(body?.handle ?? '').trim().toLowerCase();
  const name = String(body?.name ?? '').trim().slice(0, 80) || handle;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'bad_request', 'enter a valid email');
  if (!allowedEmail(env, email)) throw new HttpError(403, 'email_not_allowed', 'This instance is private.');
  if (env.ALLOW_SIGNUP === '0') throw new HttpError(403, 'signup_closed', 'Sign-up is closed on this instance.');
  if (password.length < 10) throw new HttpError(400, 'bad_request', 'password must be at least 10 characters');
  if (!HANDLE_RE.test(handle)) throw new HttpError(400, 'bad_request', 'handle: 1-32 of a-z, 0-9, _');
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt);
  const r = await env.DB.prepare('INSERT OR IGNORE INTO users (handle, email, name, pw_hash, pw_salt, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
    .bind(handle, email, name, b64url(hash), b64url(salt), nowIso()).first<{ id: number }>();
  if (!r) throw new HttpError(409, 'taken', 'that handle or email is already used');
  return { userId: r.id, cookie: await newSession(env, r.id) };
}

export async function login(env: Env, body: any) {
  const email = String(body?.email ?? '').trim();
  const password = String(body?.password ?? '');
  if (!allowedEmail(env, email)) throw new HttpError(403, 'email_not_allowed', 'This instance is private.');
  const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<UserRow>();
  const hash = await pbkdf2(password, u ? unb64url(u.pw_salt) : new Uint8Array(16));
  if (!u || !eq(hash, unb64url(u.pw_hash))) throw new HttpError(401, 'bad_credentials', 'wrong email or password');
  return { userId: u.id, cookie: await newSession(env, u.id) };
}

export async function logout(env: Env, req: Request) {
  const t = readCookie(req);
  if (t) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hex(await sha256(t))).run();
  return cookie('', 0, env);
}

const readCookie = (req: Request) => /(?:^|;\s*)am_session=([A-Za-z0-9_-]+)/.exec(req.headers.get('cookie') ?? '')?.[1] ?? null;

/** Returns the signed-in user (session cookie or bearer token), and how. */
export async function authenticate(env: Env, req: Request): Promise<{ user: UserRow; via: 'session' | 'token' } | null> {
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) {
    const h = hex(await sha256(auth.slice(7).trim()));
    const t = await env.DB.prepare('SELECT user_id FROM api_tokens WHERE token_hash = ?').bind(h).first<{ user_id: number }>();
    if (!t) return null;
    await env.DB.prepare('UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?').bind(nowIso(), h).run();
    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(t.user_id).first<UserRow>();
    return user && allowedEmail(env, user.email) ? { user, via: 'token' } : null;
  }
  const c = readCookie(req);
  if (!c) return null;
  const s = await env.DB.prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?').bind(hex(await sha256(c)), nowIso()).first<{ user_id: number }>();
  if (!s) return null;
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(s.user_id).first<UserRow>();
  return user && allowedEmail(env, user.email) ? { user, via: 'session' } : null;
}

export async function createToken(env: Env, userId: number, label: string) {
  const token = 'am_' + b64url(randomBytes(32));
  await env.DB.prepare('INSERT INTO api_tokens (user_id, label, token_hash, created_at) VALUES (?, ?, ?, ?)').bind(userId, (label || 'connector').slice(0, 60), hex(await sha256(token)), nowIso()).run();
  return token;
}
