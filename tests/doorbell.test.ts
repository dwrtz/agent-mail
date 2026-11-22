import { describe, it, expect } from 'vitest';
import { normalizeDoorbellHeader, normalizeDoorbellValue, parseDoorbellExtra } from '../src/shared/doorbell';

describe('doorbell settings normalization (R13)', () => {
  it('trims the header name and strips a trailing colon', () => {
    expect(normalizeDoorbellHeader('Authorization')).toBe('Authorization');
    expect(normalizeDoorbellHeader('  Authorization:  ')).toBe('Authorization');
    expect(normalizeDoorbellHeader('X-Doorbell-Key:')).toBe('X-Doorbell-Key');
    expect(normalizeDoorbellHeader('   ')).toBe('');
  });

  it('strips a "<header>:" prefix from a pasted full header line', () => {
    expect(normalizeDoorbellValue('  Bearer secret  ', 'Authorization')).toBe('Bearer secret');
    expect(normalizeDoorbellValue('Authorization: Bearer secret', 'Authorization')).toBe('Bearer secret');
    expect(normalizeDoorbellValue('authorization: Bearer secret', 'Authorization')).toBe('Bearer secret');
    expect(normalizeDoorbellValue('  AUTHORIZATION:   Bearer secret  ', 'Authorization')).toBe('Bearer secret');
    expect(normalizeDoorbellValue('Authorization:Bearer secret', 'Authorization')).toBe('Bearer secret');
  });

  it('uses the configured header name, or Authorization when it is empty', () => {
    expect(normalizeDoorbellValue('X-Doorbell-Key: doorbell-test-abc', 'X-Doorbell-Key:')).toBe('doorbell-test-abc');
    expect(normalizeDoorbellValue('Authorization: Bearer secret', 'X-Doorbell-Key')).toBe('Authorization: Bearer secret');
    expect(normalizeDoorbellValue('Authorization: Bearer secret', '  ')).toBe('Bearer secret');
    expect(normalizeDoorbellValue('Authorization:', 'Authorization')).toBe('');
  });

  it('parses extra headers, one "Name: value" per line', () => {
    expect(parseDoorbellExtra('anthropic-version: 2023-06-01\n\n  X-Extra:  one two  \r\n')).toEqual({ 'anthropic-version': '2023-06-01', 'x-extra': 'one two' });
    expect(parseDoorbellExtra('')).toEqual({});
    expect(parseDoorbellExtra('X-Url: https://a.example/x:y')).toEqual({ 'x-url': 'https://a.example/x:y' });
  });

  it('refuses lines that are not usable headers', () => {
    expect(() => parseDoorbellExtra('no colon here')).toThrow(/not a header line/);
    expect(() => parseDoorbellExtra('Content-Type: text/plain')).toThrow(/cannot be set/);
    expect(() => parseDoorbellExtra('Authorization: again')).toThrow(/already the main header/);
    expect(parseDoorbellExtra('Authorization: Bearer x', 'X-Key')).toEqual({ authorization: 'Bearer x' });
    expect(() => parseDoorbellExtra('X-Empty:')).toThrow(/needs a value/);
    expect(() => parseDoorbellExtra('bad name: x')).toThrow(/letters, digits and dashes/);
    expect(() => parseDoorbellExtra('a: 1\nb: 2\nc: 3\nd: 4\ne: 5\nf: 6')).toThrow(/at most 5/);
  });
});
