// A server-held key (R20) is stored wrapped under a key derived from SIGNING_SEED and bound to its key id.
import { describe, it, expect } from 'vitest';
import { wrapServerKey, unwrapServerKey } from '../src/shared/keys';
import { actorDocument } from '../src/shared/activity';
import { b64url, hex, randomBytes } from '../src/shared/enc';

describe('server-held key wrapping', () => {
  const seed = b64url(randomBytes(32)), keyId = 'https://a.example/users/alice#enc-3', priv = randomBytes(32);

  it('round-trips, and the stored form does not contain the key', async () => {
    const w = await wrapServerKey(seed, keyId, priv);
    expect(hex(await unwrapServerKey(seed, keyId, w))).toBe(hex(priv));
    expect(w).not.toContain(b64url(priv));
    expect(await wrapServerKey(seed, keyId, priv)).not.toBe(w); // a fresh IV every time
  });

  it('needs the instance secret and the same key id', async () => {
    const w = await wrapServerKey(seed, keyId, priv);
    await expect(unwrapServerKey(b64url(randomBytes(32)), keyId, w)).rejects.toThrow();
    await expect(unwrapServerKey(seed, 'https://a.example/users/alice#enc-4', w)).rejects.toThrow();
    await expect(unwrapServerKey(seed, keyId, w.slice(0, -2) + 'AA')).rejects.toThrow();
  });

  it('the actor names server-held keys only when there are some', () => {
    const base = { origin: 'https://a.example', handle: 'alice', name: 'Alice', readReceipts: false, sigKeys: [], encKeys: [] };
    expect('am:serverKeys' in actorDocument(base)).toBe(false);
    expect((actorDocument({ ...base, alsoEncryptTo: [keyId], serverKeys: [keyId] }) as any)['am:serverKeys']).toEqual([keyId]);
  });
});
