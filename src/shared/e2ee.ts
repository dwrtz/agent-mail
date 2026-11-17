// HPKE (RFC 9180) base mode, DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM (ids 0x0020/0x0001/0x0001),
// via hpke-js (@hpke/core + @hpke/dhkem-x25519). Attachments: AES-256-GCM.
import { Aes128Gcm, CipherSuite, HkdfSha256 } from '@hpke/core';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';
import { x25519 } from '@noble/curves/ed25519.js';
import { b64url, randomBytes, sha256, te, td, unb64url } from './enc';

export const HPKE_IDS = { kem: 0x0020, kdf: 0x0001, aead: 0x0001 } as const;
export const HPKE_INFO = 'agent-mail/0.1 note';

const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });

const ab = (u: Uint8Array) => u.slice().buffer as ArrayBuffer;

export function aadFor(noteId: string, recipientActor: string): Uint8Array {
  return te.encode(`${noteId}\n${recipientActor}`);
}

export function x25519Generate(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = randomBytes(32);
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}
export const x25519Public = (sk: Uint8Array) => x25519.getPublicKey(sk);

export interface Sealed { enc: string; ct: string }

/** Seals plaintext to an X25519 public key. `ikmE` makes the ephemeral key deterministic (test vectors only). */
export async function seal(recipientPublic: Uint8Array, plaintext: Uint8Array, aad: Uint8Array, ikmE?: Uint8Array): Promise<Sealed> {
  const pk = await suite.kem.deserializePublicKey(ab(recipientPublic));
  const sender = await suite.createSenderContext({ recipientPublicKey: pk, info: ab(te.encode(HPKE_INFO)), ...(ikmE ? { ekm: ab(ikmE) } : {}) });
  const ct = new Uint8Array(await sender.seal(ab(plaintext), ab(aad)));
  return { enc: b64url(new Uint8Array(sender.enc)), ct: b64url(ct) };
}

export async function open(recipientPrivate: Uint8Array, sealed: Sealed, aad: Uint8Array): Promise<Uint8Array> {
  const sk = await suite.kem.deserializePrivateKey(ab(recipientPrivate));
  const r = await suite.createRecipientContext({ recipientKey: sk, enc: ab(unb64url(sealed.enc)), info: ab(te.encode(HPKE_INFO)) });
  return new Uint8Array(await r.open(ab(unb64url(sealed.ct)), ab(aad)));
}

/** The decrypted Note payload. */
export interface NotePayload {
  v: 1;
  summary: string | null;
  content: string;
  attachments: { url: string; name: string; mediaType: string; size: number; key: string; iv: string }[];
}

export async function sealNote(recipientPublic: Uint8Array, noteId: string, recipientActor: string, payload: NotePayload, ikmE?: Uint8Array) {
  return seal(recipientPublic, te.encode(JSON.stringify(payload)), aadFor(noteId, recipientActor), ikmE);
}
export async function openNote(recipientPrivate: Uint8Array, noteId: string, recipientActor: string, sealed: Sealed): Promise<NotePayload> {
  const pt = await open(recipientPrivate, sealed, aadFor(noteId, recipientActor));
  const p = JSON.parse(td.decode(pt));
  if (p?.v !== 1 || typeof p.content !== 'string' || !Array.isArray(p.attachments)) throw new Error('bad note payload');
  return p;
}

// Attachments: AES-256-GCM, 12-byte IV, no AAD. Stored bytes = ciphertext || 16-byte tag.
export async function encryptFile(plain: Uint8Array, key = randomBytes(32), iv = randomBytes(12)) {
  const k = await crypto.subtle.importKey('raw', ab(key), 'AES-GCM', false, ['encrypt']);
  const stored = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ab(iv) }, k, ab(plain)));
  return { stored, key: b64url(key), iv: b64url(iv), digest: await sha256(stored) };
}
export async function decryptFile(stored: Uint8Array, key: string, iv: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', ab(unb64url(key)), 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ab(unb64url(iv)) }, k, ab(stored)));
}
