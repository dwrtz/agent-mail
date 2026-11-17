import { deriveSigningKey } from '../shared/keys';
import { multikeyEncode } from '../shared/enc';
import { actorDocument, KeyEntry } from '../shared/activity';
import { Env, UserRow, actorUrl, origin } from './env';

export function signingKey(env: Env, u: UserRow) {
  const k = deriveSigningKey(env.SIGNING_SEED, u.handle, u.sig_version);
  return { ...k, keyId: `${actorUrl(env, u.handle)}#sig-${u.sig_version}` };
}

export async function encKeys(env: Env, userId: number): Promise<{ n: number; public_key: string }[]> {
  return (await env.DB.prepare('SELECT n, public_key FROM enc_keys WHERE user_id = ? ORDER BY n').bind(userId).all<{ n: number; public_key: string }>()).results;
}

import { unb64url } from '../shared/enc';
export async function buildActor(env: Env, u: UserRow) {
  const id = actorUrl(env, u.handle);
  const sk = signingKey(env, u);
  const sigKeys: KeyEntry[] = [{ id: sk.keyId, type: 'Multikey', controller: id, publicKeyMultibase: multikeyEncode('ed25519', sk.publicKey) }];
  const enc: KeyEntry[] = (await encKeys(env, u.id)).map(k => ({ id: `${id}#enc-${k.n}`, type: 'Multikey', controller: id, publicKeyMultibase: multikeyEncode('x25519', unb64url(k.public_key)) }));
  return actorDocument({ origin: origin(env), handle: u.handle, name: u.name, sigKeys, encKeys: enc, readReceipts: !!u.read_receipts });
}
