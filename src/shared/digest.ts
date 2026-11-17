// RFC 9530 Content-Digest (sha-256 only is produced; sha-256 is required on receipt).
import { b64, sha256, unb64 } from './enc';

export async function contentDigest(body: Uint8Array): Promise<string> {
  return `sha-256=:${b64(await sha256(body))}:`;
}

/** Returns the sha-256 value from a Content-Digest header, or null if missing or malformed. */
export function parseSha256(header: string | null): Uint8Array | null {
  if (!header) return null;
  for (const part of splitTopLevel(header)) {
    const m = /^\s*sha-256\s*=\s*:([A-Za-z0-9+/=]*):\s*$/.exec(part);
    if (m) { try { return unb64(m[1]); } catch { return null; } }
  }
  return null;
}

export async function digestMatches(header: string | null, body: Uint8Array): Promise<boolean> {
  const want = parseSha256(header);
  if (!want) return false;
  const got = await sha256(body);
  if (want.length !== got.length) return false;
  let d = 0;
  for (let i = 0; i < got.length; i++) d |= got[i] ^ want[i];
  return d === 0;
}

/** Split a structured-field list/dictionary on top-level commas (not inside quotes). */
export function splitTopLevel(s: string): string[] {
  const out: string[] = []; let cur = ''; let q = false; let paren = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === '\\') { cur += s[++i] ?? ''; } else if (c === '"') q = false; continue; }
    if (c === '"') q = true;
    if (c === '(') paren++;
    if (c === ')') paren--;
    if (c === ',' && paren === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
