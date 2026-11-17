import { describe, it, expect } from 'vitest';
import { validateActivity, threadCreator, ProtoError, MAX_GROUP } from '../src/shared/activity';
import { readFileSync } from 'node:fs';
const V = JSON.parse(readFileSync(new URL('../spec/test-vectors.json', import.meta.url), 'utf8'));
const create = () => JSON.parse(V.signed_post.body_utf8);
const err = (f: () => unknown) => { try { f(); return 'ok'; } catch (e) { return `${(e as ProtoError).status} ${(e as ProtoError).code}`; } };

describe('activity shapes (protocol.md section 4)', () => {
  it('accepts the vector Create', () => expect(validateActivity(create()).type).toBe('Create'));
  it('rejects bad shapes with the protocol codes', () => {
    expect(err(() => validateActivity({ ...create(), type: 'Follow' }))).toBe('422 unsupported_activity');
    expect(err(() => validateActivity({ ...create(), id: 'https://evil.example/x' }))).toBe('400 bad_activity');
    const c = create(); c.object['am:encrypted'].aead = 3;
    expect(err(() => validateActivity(c))).toBe('422 unsupported_encryption');
    const big = create(); big.to = Array.from({ length: MAX_GROUP }, (_, i) => `https://b.example/users/u${i}`);
    expect(err(() => validateActivity(big))).toBe('422 group_too_large');
    const noSeq = create(); delete noSeq.object['am:seq'];
    expect(err(() => validateActivity(noSeq))).toBe('400 bad_activity');
    const att = create(); att.object.attachment[0].url = 'https://other.example/attachments/x';
    expect(err(() => validateActivity(att))).toBe('400 bad_activity');
  });
  it('Add/Remove and Read', () => {
    const base = { '@context': [], id: 'https://a.example/users/alice/activities/1', actor: 'https://a.example/users/alice', to: ['https://b.example/users/bob'], published: '2026-11-17T00:00:00Z' };
    expect(validateActivity({ ...base, type: 'Add', object: 'https://c.example/users/carol', target: 'https://a.example/users/alice/threads/t', 'am:members': ['https://a.example/users/alice'], 'am:seq': 2 }).type).toBe('Add');
    expect(err(() => validateActivity({ ...base, type: 'Remove', object: 'https://c.example/users/carol', target: 'https://a.example/users/alice/threads/t', 'am:seq': 2 }))).toBe('400 bad_activity');
    expect(validateActivity({ ...base, type: 'Read', object: 'https://b.example/users/bob/notes/1' }).type).toBe('Read');
  });
  it('thread creator is the actor before /threads/', () => {
    expect(threadCreator('https://a.example/users/alice/threads/5a4b')).toBe('https://a.example/users/alice');
    expect(threadCreator('https://a.example/x')).toBeNull();
  });
});
