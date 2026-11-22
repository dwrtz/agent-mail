import { deriveSigningKey } from '../shared/keys';
import { multikeyEncode } from '../shared/enc';
import { actorDocument, KeyEntry, MAX_CLIENT_KEYS } from '../shared/activity';
import { Env, UserRow, actorUrl, origin } from './env';

export function signingKey(env: Env, u: UserRow) {
  const k = deriveSigningKey(env.SIGNING_SEED, u.handle, u.sig_version);
  return { ...k, keyId: `${actorUrl(env, u.handle)}#sig-${u.sig_version}` };
}

/** The owner's own encryption keys, oldest first; senders use the last one. */
export async function encKeys(env: Env, userId: number): Promise<{ n: number; public_key: string }[]> {
  return (await env.DB.prepare("SELECT n, public_key FROM enc_keys WHERE user_id = ? AND kind = 'primary' ORDER BY n").bind(userId).all<{ n: number; public_key: string }>()).results;
}
/** Client keys: one per agent. Senders that know am:alsoEncryptTo also encrypt to these. */
export async function clientKeys(env: Env, userId: number): Promise<{ n: number; public_key: string; label: string | null; token_id: number | null }[]> {
  return (await env.DB.prepare("SELECT n, public_key, label, token_id FROM enc_keys WHERE user_id = ? AND kind = 'client' ORDER BY n").bind(userId).all<{ n: number; public_key: string; label: string | null; token_id: number | null }>()).results;
}
/** The number for a new key. Never reused, even after a key is removed: `#enc-<n>` must name one key for ever. */
export async function nextKeyN(env: Env, userId: number): Promise<number> {
  const r = await env.DB.prepare('UPDATE users SET key_seq = MAX(key_seq, (SELECT COALESCE(MAX(n), 0) FROM enc_keys WHERE user_id = ?1)) + 1 WHERE id = ?1 RETURNING key_seq').bind(userId).first<{ key_seq: number }>();
  return r!.key_seq;
}

import { unb64url } from '../shared/enc';
export async function buildActor(env: Env, u: UserRow) {
  const id = actorUrl(env, u.handle);
  const sk = signingKey(env, u);
  const sigKeys: KeyEntry[] = [{ id: sk.keyId, type: 'Multikey', controller: id, publicKeyMultibase: multikeyEncode('ed25519', sk.publicKey) }];
  const entry = (k: { n: number; public_key: string }): KeyEntry => ({ id: `${id}#enc-${k.n}`, type: 'Multikey', controller: id, publicKeyMultibase: multikeyEncode('x25519', unb64url(k.public_key)) });
  const clients = (await clientKeys(env, u.id)).slice(0, MAX_CLIENT_KEYS).map(entry);
  // Client keys come first so that the last entry stays the owner's newest key (what 0.1 senders encrypt to).
  const enc: KeyEntry[] = [...clients, ...(await encKeys(env, u.id)).map(entry)];
  return actorDocument({ origin: origin(env), handle: u.handle, name: u.name, sigKeys, encKeys: enc, readReceipts: !!u.read_receipts, alsoEncryptTo: clients.map(c => c.id) });
}
