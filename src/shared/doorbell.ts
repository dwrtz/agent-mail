// Normalization for doorbell settings (R13): a pasted "Authorization: Bearer …"
// line, or a header name with a trailing colon, is stored as just the value / name.
export function normalizeDoorbellHeader(name: string): string {
  let v = name.trim();
  if (v.endsWith(':')) v = v.slice(0, -1).trim();
  return v;
}

export function normalizeDoorbellValue(value: string, headerName: string): string {
  let v = value.trim();
  const header = normalizeDoorbellHeader(headerName) || 'Authorization';
  const prefix = header + ':';
  if (v.length >= prefix.length && v.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()) {
    v = v.slice(prefix.length).trim();
  }
  return v;
}

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
/** Headers the Worker sets itself, or that make no sense on a webhook POST. */
const RESERVED = new Set(['content-type', 'content-length', 'host', 'connection', 'transfer-encoding', 'cookie']);
export const MAX_EXTRA_HEADERS = 5;

/**
 * Parses the "extra headers" setting: one `Name: value` per line. Returns lower-cased names.
 * Throws an Error with a message for the settings form when a line is not a usable header.
 */
export function parseDoorbellExtra(text: string, mainHeader = 'Authorization'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const i = line.indexOf(':');
    if (i < 1) throw new Error(`"${line.trim().slice(0, 40)}" is not a header line; write Name: value`);
    const name = line.slice(0, i).trim().toLowerCase(), value = line.slice(i + 1).trim();
    if (!HEADER_NAME.test(name)) throw new Error(`header name "${name.slice(0, 40)}": letters, digits and dashes`);
    if (RESERVED.has(name)) throw new Error(`${name} cannot be set here`);
    if (name === (normalizeDoorbellHeader(mainHeader) || 'Authorization').toLowerCase()) throw new Error(`${name} is already the main header`);
    if (!value || value.length > 2000 || /[\r\n]/.test(value)) throw new Error(`header ${name} needs a value`);
    out[name] = value;
  }
  if (Object.keys(out).length > MAX_EXTRA_HEADERS) throw new Error(`at most ${MAX_EXTRA_HEADERS} extra headers`);
  return out;
}
