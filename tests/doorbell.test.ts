import { describe, it, expect } from 'vitest';
import { normalizeDoorbellHeader, normalizeDoorbellValue } from '../src/shared/doorbell';

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
});
