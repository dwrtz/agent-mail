import { deriveSigningKey } from '../shared/keys';
import { multikeyEncode } from '../shared/enc';
import { actorDocument, KeyEntry, MAX_CLIENT_KEYS } from '../shared/activity';
import { Env, UserRow, HttpError, actorUrl, origin, serverKeysAllowed } from './env';

export function signingKey(env: Env, u: UserRow) {
  const k = deriveSigningKey(env.SIGNING_SEED, u.handle, u.sig_version);
  return { ...k, keyId: `${actorUrl(env, u.handle)}#sig-${u.sig_version}` };
}

/** The owner's own encryption keys, oldest first; senders use the last one. */
export async function encKeys(env: Env, userId: number): Promise<{ n: number; public_key: string }[]> {
  return (await env.DB.prepare("SELECT n, public_key FROM enc_keys WHERE user_id = ? AND kind = 'primary' ORDER BY n").bind(userId).all<{ n: number; public_key: string }>()).results;
}
export interface ClientKeyRow { n: number; public_key: string; label: string | null; token_id: number | null; hosted: number }
/** Client keys: one per agent. Senders that know am:alsoEncryptTo also encrypt to these. */
export async function clientKeys(env: Env, userId: number): Promise<ClientKeyRow[]> {
  return (await env.DB.prepare("SELECT n, public_key, label, token_id, hosted FROM enc_keys WHERE user_id = ? AND kind = 'client' ORDER BY n").bind(userId).all<ClientKeyRow>()).results;
}
/** The number for a new key. Never reused, even after a key is removed: `#enc-<n>` must name one key for ever. */
export async function nextKeyN(env: Env, userId: number): Promise<number> {
  const r = await env.DB.prepare('UPDATE users SET key_seq = MAX(key_seq, (SELECT COALESCE(MAX(n), 0) FROM enc_keys WHERE user_id = ?1)) + 1 WHERE id = ?1 RETURNING key_seq').bind(userId).first<{ key_seq: number }>();
  return r!.key_seq;
}

import { unb64url, b64url } from '../shared/enc';
import { wrapServerKey, unwrapServerKey } from '../shared/keys';
import { x25519Generate } from '../shared/e2ee';
import type { KeyFile } from '../shared/client';

/**
 * The opt-in of R20: makes a key for one connector whose private half stays on the instance, so the
 * instance can decrypt and encrypt for a hosted app that cannot hold a key. Only ever called for the
 * owner (their session, or a consent they gave); the caller checks that the instance allows it.
 */
export async function createServerKey(env: Env, u: UserRow, tokenId: number, label: string): Promise<{ n: number; keyId: string }> {
  if (!serverKeysAllowed(env)) throw new HttpError(403, 'server_keys_disabled', 'this instance does not hold keys for connectors');
  if ((await clientKeys(env, u.id)).length >= MAX_CLIENT_KEYS) throw new HttpError(400, 'too_many_keys', `at most ${MAX_CLIENT_KEYS} agent keys; remove one first`);
  const n = await nextKeyN(env, u.id);
  const keyId = `${actorUrl(env, u.handle)}#enc-${n}`;
  const k = x25519Generate();
  await env.DB.prepare("INSERT INTO enc_keys (user_id, n, public_key, created_at, kind, label, token_id, hosted, private_enc) VALUES (?, ?, ?, ?, 'client', ?, ?, 1, ?)")
    .bind(u.id, n, b64url(k.publicKey), new Date().toISOString(), label.slice(0, 60) || null, tokenId, await wrapServerKey(env.SIGNING_SEED, keyId, k.privateKey)).run();
  return { n, keyId };
}

/** The server-held key of a connector, unwrapped for this request, or null when the owner did not opt it in. */
export async function serverKeyFor(env: Env, u: UserRow, tokenId: number): Promise<KeyFile | null> {
  if (!serverKeysAllowed(env)) return null; // turning the switch off stops all server-side decryption at once
  const r = await env.DB.prepare("SELECT n, public_key, private_enc FROM enc_keys WHERE user_id = ? AND token_id = ? AND kind = 'client' AND hosted = 1 ORDER BY n DESC LIMIT 1").bind(u.id, tokenId).first<{ n: number; public_key: string; private_enc: string | null }>();
  if (!r?.private_enc) return null;
  const actor = actorUrl(env, u.handle), keyId = `${actor}#enc-${r.n}`;
  return { type: 'agent-mail-key', v: 1, address: `${u.handle}@${new URL(actor).host}`, actor, keyId, privateKey: b64url(await unwrapServerKey(env.SIGNING_SEED, keyId, r.private_enc)), publicKey: r.public_key };
}

export async function buildActor(env: Env, u: UserRow) {
  const id = actorUrl(env, u.handle);
  const sk = signingKey(env, u);
  const sigKeys: KeyEntry[] = [{ id: sk.keyId, type: 'Multikey', controller: id, publicKeyMultibase: multikeyEncode('ed25519', sk.publicKey) }];
  const entry = (k: { n: number; public_key: string }): KeyEntry => ({ id: `${id}#enc-${k.n}`, type: 'Multikey', controller: id, publicKeyMultibase: multikeyEncode('x25519', unb64url(k.public_key)) });
  const rows = (await clientKeys(env, u.id)).slice(0, MAX_CLIENT_KEYS);
  const clients = rows.map(entry);
  // Client keys come first so that the last entry stays the owner's newest key (what 0.1 senders encrypt to).
  const enc: KeyEntry[] = [...clients, ...(await encKeys(env, u.id)).map(entry)];
  return actorDocument({ origin: origin(env), handle: u.handle, name: u.name, sigKeys, encKeys: enc, readReceipts: !!u.read_receipts, alsoEncryptTo: clients.map(c => c.id), serverKeys: rows.filter(r => r.hosted).map(r => `${id}#enc-${r.n}`) });
}
