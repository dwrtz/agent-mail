// Byte and text helpers. Web APIs only (Workers, browsers and Node 20+).
import { base58 } from '@scure/base';

export const te = new TextEncoder();
export const td = new TextDecoder();

export function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const b64url = (bytes: Uint8Array) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function unb64url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
  const p = s.replace(/-/g, '+').replace(/_/g, '/');
  return unb64(p + '='.repeat((4 - (p.length % 4)) % 4));
}
export const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
export const unhex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], x => parseInt(x, 16));

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? te.encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

// Multikey (W3C Controlled Identifiers / FEP-521a): 'z' + base58btc(multicodec prefix || raw public key).
const ED25519_PUB = [0xed, 0x01];
const X25519_PUB = [0xec, 0x01];
export function multikeyEncode(kind: 'ed25519' | 'x25519', pub: Uint8Array): string {
  if (pub.length !== 32) throw new Error('public key must be 32 bytes');
  return 'z' + base58.encode(concat(Uint8Array.from(kind === 'ed25519' ? ED25519_PUB : X25519_PUB), pub));
}
export function multikeyDecode(s: string): { kind: 'ed25519' | 'x25519'; key: Uint8Array } {
  if (typeof s !== 'string' || s[0] !== 'z') throw new Error('multikey must start with z');
  const b = base58.decode(s.slice(1));
  if (b.length !== 34) throw new Error('multikey length');
  if (b[0] === 0xed && b[1] === 0x01) return { kind: 'ed25519', key: b.slice(2) };
  if (b[0] === 0xec && b[1] === 0x01) return { kind: 'x25519', key: b.slice(2) };
  throw new Error('unsupported multikey type');
}
