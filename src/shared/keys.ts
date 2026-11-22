// Per-user Ed25519 signing keys derived from the instance secret SIGNING_SEED with HKDF-SHA256 (RFC 5869).
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { te, b64url, unb64url } from './enc';

export function deriveSigningKey(seedB64url: string, handle: string, version: number): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const ikm = unb64url(seedB64url);
  if (ikm.length < 32) throw new Error('SIGNING_SEED must be at least 32 bytes');
  const privateKey = hkdf(sha256, ikm, te.encode('agent-mail/0.1'), te.encode(`sig:${handle}:${version}`), 32);
  return { privateKey, publicKey: ed25519.getPublicKey(privateKey) };
}

// A server-held key (R20) is stored wrapped: AES-256-GCM under a key derived from SIGNING_SEED, bound to the
// key's own id. The database alone does not give the private key away; the Worker's secret is needed too.
async function wrappingKey(seedB64url: string, keyId: string): Promise<CryptoKey> {
  const ikm = unb64url(seedB64url);
  if (ikm.length < 32) throw new Error('SIGNING_SEED must be at least 32 bytes');
  const raw = hkdf(sha256, ikm, te.encode('agent-mail/0.2 server-key'), te.encode(`wrap:${keyId}`), 32);
  return crypto.subtle.importKey('raw', raw.slice().buffer as ArrayBuffer, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
const buf = (u: Uint8Array) => u.slice().buffer as ArrayBuffer;
export async function wrapServerKey(seedB64url: string, keyId: string, privateKey: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(te.encode(keyId)) }, await wrappingKey(seedB64url, keyId), buf(privateKey)));
  return `${b64url(iv)}.${b64url(ct)}`;
}
export async function unwrapServerKey(seedB64url: string, keyId: string, wrapped: string): Promise<Uint8Array> {
  const [iv, ct] = wrapped.split('.');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(unb64url(iv)), additionalData: buf(te.encode(keyId)) }, await wrappingKey(seedB64url, keyId), buf(unb64url(ct))));
}
