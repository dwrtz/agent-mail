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
