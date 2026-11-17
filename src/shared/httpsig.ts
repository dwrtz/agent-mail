// RFC 9421 HTTP Message Signatures, the profile agent-mail uses (Ed25519, tag "agent-mail").
import { ed25519 } from '@noble/curves/ed25519.js';
import { b64, randomBytes, b64url, te, unb64 } from './enc';
import { splitTopLevel } from './digest';
import { isUrl } from './activity';

export const SIG_LABEL = 'am';
export const SIG_TAG = 'agent-mail';
export const MAX_SKEW_S = 300;      // created may be at most 300 s in the future or past
export const MAX_LIFETIME_S = 300;  // expires - created
export const POST_COMPONENTS = ['@method', '@target-uri', 'content-type', 'content-digest'];
export const GET_COMPONENTS = ['@method', '@target-uri'];

export interface MessageParts {
  method: string;
  url: string;                       // absolute target URI
  headers: Record<string, string>;   // lower-case names
}

export type SigParams = Record<string, string | number>;

function sfString(v: string): string {
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

export function serializeParams(components: string[], params: SigParams, order?: string[]): string {
  const keys = order ?? Object.keys(params);
  let s = '(' + components.map(c => sfString(c)).join(' ') + ')';
  for (const k of keys) {
    if (!(k in params)) continue;
    const v = params[k];
    s += `;${k}=` + (typeof v === 'number' ? String(v) : sfString(v));
  }
  return s;
}

export function componentValue(name: string, m: MessageParts): string {
  const u = new URL(m.url);
  switch (name) {
    case '@method': return m.method.toUpperCase();
    case '@target-uri': return m.url;
    case '@authority': return u.host.toLowerCase();
    case '@path': return u.pathname;
    case '@query': return u.search || '?';
    case '@scheme': return u.protocol.replace(':', '');
    default: {
      if (name.startsWith('@')) throw new SigError('signature_invalid', `unsupported component ${name}`);
      const v = m.headers[name.toLowerCase()];
      if (v === undefined) throw new SigError('signature_invalid', `covered header ${name} missing`);
      return v.trim();
    }
  }
}

/** The signature base (RFC 9421 section 2.5). `paramsText` is the serialized @signature-params value. */
export function signatureBase(components: string[], paramsText: string, m: MessageParts): string {
  const lines = components.map(c => `"${c}": ${componentValue(c, m)}`);
  lines.push(`"@signature-params": ${paramsText}`);
  return lines.join('\n');
}

export class SigError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export interface SignOptions {
  keyId: string;
  privateKey: Uint8Array;  // Ed25519 32-byte seed
  created?: number;        // unix seconds
  expires?: number;
  nonce?: string;
  components?: string[];
}

/** Signs a request. Returns the headers to add: Signature-Input and Signature. */
export function signRequest(m: MessageParts, o: SignOptions): { 'signature-input': string; signature: string; base: string } {
  const created = o.created ?? Math.floor(Date.now() / 1000);
  const params: SigParams = {
    created,
    expires: o.expires ?? created + MAX_LIFETIME_S,
    nonce: o.nonce ?? b64url(randomBytes(16)),
    keyid: o.keyId,
    alg: 'ed25519',
    tag: SIG_TAG,
  };
  const components = o.components ?? (m.method.toUpperCase() === 'GET' ? GET_COMPONENTS : POST_COMPONENTS);
  const p = serializeParams(components, params);
  const base = signatureBase(components, p, m);
  const sig = ed25519.sign(te.encode(base), o.privateKey);
  return { 'signature-input': `${SIG_LABEL}=${p}`, signature: `${SIG_LABEL}=:${b64(sig)}:`, base };
}

export interface ParsedSignature {
  label: string;
  components: string[];
  params: SigParams;
  paramsText: string;
  signature: Uint8Array;
}

/** Parses Signature-Input and Signature and picks the member tagged "agent-mail". */
export function parseSignature(sigInput: string | undefined, sig: string | undefined, tag = SIG_TAG): ParsedSignature {
  if (!sigInput || !sig) throw new SigError('signature_missing', 'Signature-Input and Signature headers are required');
  const inputs = new Map<string, string>();
  for (const member of splitTopLevel(sigInput)) {
    const i = member.indexOf('=');
    if (i < 1) throw new SigError('signature_invalid', 'malformed Signature-Input');
    inputs.set(member.slice(0, i).trim(), member.slice(i + 1).trim());
  }
  const sigs = new Map<string, string>();
  for (const member of splitTopLevel(sig)) {
    const i = member.indexOf('=');
    if (i < 1) throw new SigError('signature_invalid', 'malformed Signature');
    sigs.set(member.slice(0, i).trim(), member.slice(i + 1).trim());
  }
  for (const [label, text] of inputs) {
    const parsed = parseInnerList(text);
    if (tag && parsed.params.tag !== tag) continue;
    const sv = sigs.get(label);
    const m = sv && /^:([A-Za-z0-9+/=]+):$/.exec(sv);
    if (!m) throw new SigError('signature_invalid', `no signature value for ${label}`);
    return { label, components: parsed.components, params: parsed.params, paramsText: text, signature: unb64(m[1]) };
  }
  throw new SigError('signature_missing', `no signature tagged "${tag}"`);
}

function parseInnerList(text: string): { components: string[]; params: SigParams } {
  const m = /^\(([^)]*)\)(.*)$/.exec(text);
  if (!m) throw new SigError('signature_invalid', 'malformed covered components');
  const components: string[] = [];
  const re = /"([^"\\]*)"/g; let x: RegExpExecArray | null;
  const inner = m[1].trim();
  while ((x = re.exec(inner))) components.push(x[1]);
  if (inner && components.length === 0) throw new SigError('signature_invalid', 'malformed covered components');
  const params: SigParams = {};
  const pre = /;([a-z0-9_.*-]+)=("(?:[^"\\]|\\.)*"|-?\d+)/g;
  while ((x = pre.exec(m[2]))) params[x[1]] = x[2].startsWith('"') ? x[2].slice(1, -1).replace(/\\(.)/g, '$1') : Number(x[2]);
  return { components, params };
}

export interface VerifyOptions {
  now: number;                                 // unix seconds
  requiredComponents: string[];
  lookupKey: (keyId: string) => Promise<Uint8Array>; // returns Ed25519 public key or throws SigError
}

/** Verifies a request's agent-mail signature. Throws SigError with the protocol error code. */
export async function verifyRequest(m: MessageParts, o: VerifyOptions): Promise<{ keyId: string; nonce: string; created: number; expires: number }> {
  const p = parseSignature(m.headers['signature-input'], m.headers['signature']);
  for (const c of o.requiredComponents) {
    if (!p.components.includes(c)) throw new SigError('signature_invalid', `signature must cover ${c}`);
  }
  const { created, expires, nonce, keyid, alg } = p.params;
  if (typeof created !== 'number' || typeof expires !== 'number') throw new SigError('signature_invalid', 'created and expires are required');
  if (typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 64) throw new SigError('signature_invalid', 'nonce of 16-64 characters is required');
  if (typeof keyid !== 'string' || !isUrl(keyid)) throw new SigError('signature_invalid', 'keyid must be an https URL');
  if (alg !== undefined && alg !== 'ed25519') throw new SigError('signature_invalid', 'alg must be ed25519');
  if (created > o.now + MAX_SKEW_S) throw new SigError('signature_expired', 'created is in the future');
  if (created < o.now - MAX_SKEW_S) throw new SigError('signature_expired', 'created is too old');
  if (expires <= o.now) throw new SigError('signature_expired', 'signature has expired');
  if (expires < created || expires - created > MAX_LIFETIME_S) throw new SigError('signature_invalid', 'expires must be within 300 s of created');
  let base: string;
  try { base = signatureBase(p.components, p.paramsText, m); } catch (e) { throw e instanceof SigError ? e : new SigError('signature_invalid', String(e)); }
  const pub = await o.lookupKey(keyid);
  let ok = false;
  try { ok = ed25519.verify(p.signature, te.encode(base), pub); } catch { ok = false; }
  if (!ok) throw new SigError('signature_invalid', 'signature does not verify');
  return { keyId: keyid, nonce, created, expires };
}
