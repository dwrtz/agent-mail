// Client-side sealing to several keys (R18): the owner's key plus each agent's client key.
import { describe, it, expect } from 'vitest';
import { encryptAndSend, decryptActivity, newKeyFile, resealHeld, Prepared, Transport } from '../src/shared/client';
import { sealNote } from '../src/shared/e2ee';
import { unb64url } from '../src/shared/enc';

const bob = 'https://b.example/users/bob', alice = 'https://a.example/users/alice';
const key = (actor: string, n: number) => newKeyFile('x@example', actor, `${actor}#enc-${n}`);
const ref = (k: ReturnType<typeof key>) => ({ keyId: k.keyId, publicKey: k.publicKey });

/** A transport that records the send body and builds the activities an instance would. */
function fake(p: Prepared) {
  let body: any = null;
  const t: Transport = { prepare: async () => p, upload: async () => { throw new Error('no files here'); }, send: async b => { body = b; return { status: 'sent' }; } };
  const note = (x: any, recipient: string) => ({ type: 'Create', actor: alice, object: { id: p.noteId, 'am:encrypted': { recipient, keyId: x.keyId, enc: x.enc, ct: x.ct }, ...(x.copies ? { 'am:copies': x.copies } : {}) } });
  return { t, body: () => body, toBob: () => note(body.payloads[0], bob), toSelf: () => note(body.selfPayload, alice) };
}

describe('sealing to client keys', () => {
  const bobMain = key(bob, 3), bobAgent = key(bob, 2), aliceMain = key(alice, 1), aliceAgent = key(alice, 4), stranger = key(bob, 9);
  const prepared: Prepared = {
    noteId: `${alice}/notes/1`, threadId: `${alice}/threads/1`, seq: 1,
    recipients: [{ actor: bob, ...ref(bobMain), alsoKeys: [ref(bobAgent)] }],
    self: { actor: alice, ...ref(aliceMain), alsoKeys: [ref(aliceAgent)] },
  };

  it('every listed key opens the message, and no other key does', async () => {
    const f = fake(prepared);
    await encryptAndSend(f.t, { to: ['bob@b.example'] }, { subject: 'S', text: 'hello', agentName: 'Helper' });
    expect(f.body().payloads[0].copies.map((c: any) => c.keyId)).toEqual([bobAgent.keyId]);
    for (const k of [bobMain, bobAgent]) expect((await decryptActivity([k], f.toBob())).content).toBe('hello');
    for (const k of [aliceMain, aliceAgent]) expect((await decryptActivity([k], f.toSelf())).agent?.name).toBe('Helper');
    await expect(decryptActivity([stranger, aliceMain], f.toBob())).rejects.toThrow(/no key for enc-3, enc-2/);
    await expect(decryptActivity([bobAgent], f.toSelf())).rejects.toThrow(/no key for/);
  });

  it('a recipient without client keys gets no copies, and sensitive is passed on only when asked', async () => {
    const f = fake({ ...prepared, recipients: [{ actor: bob, ...ref(bobMain) }], self: { actor: alice, ...ref(aliceMain) } });
    await encryptAndSend(f.t, { to: ['bob@b.example'] }, { text: 'plain' });
    expect('copies' in f.body().payloads[0]).toBe(false);
    expect('sensitive' in f.body()).toBe(false);
    expect((await decryptActivity([bobMain], f.toBob())).agent).toBeUndefined();
    await encryptAndSend(f.t, { to: ['bob@b.example'] }, { text: 'careful', sensitive: true });
    expect(f.body().sensitive).toBe(true);
  });

  it('a copy sealed for one recipient does not open as another (aad binds the recipient)', async () => {
    const f = fake(prepared);
    await encryptAndSend(f.t, { to: ['bob@b.example'] }, { text: 'bound' });
    const moved = f.toBob(); moved.object['am:encrypted'].recipient = alice;
    await expect(decryptActivity([bobAgent], moved)).rejects.toThrow();
  });

  it('resealHeld delivers what the owner read, whatever the agent sealed for the recipient', async () => {
    const seal = (k: ReturnType<typeof key>, actor: string, text: string) => sealNote(unb64url(k.publicKey), prepared.noteId, actor, { v: 1, summary: null, content: text, attachments: [] });
    // The agent's held send: one text for the owner's eyes, another for bob.
    const forOwner = await seal(aliceMain, alice, 'Lunch on Friday?');
    const held = { type: 'Create', actor: alice, object: { id: prepared.noteId, 'am:encrypted': { recipient: alice, keyId: aliceMain.keyId, ...forOwner } } };
    const r = await resealHeld([aliceMain], held, prepared);
    expect(r.payload.content).toBe('Lunch on Friday?');
    const toBob = { type: 'Create', actor: alice, object: { id: prepared.noteId, 'am:encrypted': { recipient: bob, keyId: r.payloads[0].keyId, enc: r.payloads[0].enc, ct: r.payloads[0].ct }, 'am:copies': r.payloads[0].copies } };
    for (const k of [bobMain, bobAgent]) expect((await decryptActivity([k], toBob)).content).toBe('Lunch on Friday?');
    expect(r.selfPayload.keyId).toBe(aliceMain.keyId);
    await expect(resealHeld([bobMain], held, prepared)).rejects.toThrow(/no key for/); // without the owner's key there is nothing to approve
  });
});
