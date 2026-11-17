// Per-user Ed25519 signing keys derived from the instance secret SIGNING_SEED with HKDF-SHA256 (RFC 5869).
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { te, unb64url } from './enc';

export function deriveSigningKey(seedB64url: string, handle: string, version: number): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const ikm = unb64url(seedB64url);
  if (ikm.length < 32) throw new Error('SIGNING_SEED must be at least 32 bytes');
  const privateKey = hkdf(sha256, ikm, te.encode('agent-mail/0.1'), te.encode(`sig:${handle}:${version}`), 32);
  return { privateKey, publicKey: ed25519.getPublicKey(privateKey) };
}
