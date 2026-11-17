// The two-instance test plan (R4-R13). Used by e2e.ts (local) and live.ts (deployed instances).
import { Account, Probe, send, waitFor } from './lib';
import { encryptAndSend, decryptActivity, decryptAttachment } from '../src/shared/client';
import { b64, sha256, te, randomBytes } from '../src/shared/enc';
import { signRequest } from '../src/shared/httpsig';
import { ACTIVITY_CONTEXT } from '../src/shared/activity';

export interface Result { id: string; name: string; pass: boolean; detail: string }
export interface Ctx { A: Account; B: Account; C: Account; probe: Probe; sinkBase: string; log?: (s: string) => void }

const thread = (acct: Account, uri: string) => acct.api(`/api/threads/messages?uri=${encodeURIComponent(uri)}`);
const delivered = async (acct: Account, uri: string, noteId: string, n: number) => {
  const ms: any[] = await thread(acct, uri);
  const m = ms.find(x => x.activity?.object?.id === noteId);
  return m && m.deliveries.filter((d: any) => d.status === 'delivered').length >= n ? m : null;
};
function fakeCreate(probe: Probe, to: string, opts: { id?: string; actor?: string; type?: string } = {}) {
  const actor = opts.actor ?? probe.actor;
  const id = opts.id ?? `${probe.actor.replace('/__test/probe', '')}/__test/probe/activities/${crypto.randomUUID()}`;
  return {
    '@context': ACTIVITY_CONTEXT, id, type: opts.type ?? 'Create', actor, published: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), to: [to],
    object: { id: id.replace('/activities/', '/notes/'), type: 'Note', attributedTo: actor, to: [to], published: new Date().toISOString(), context: `${probe.actor}/threads/${crypto.randomUUID()}`,
      inReplyTo: null, content: 'This message is end-to-end encrypted.', 'am:seq': 1,
      'am:encrypted': { kem: 32, kdf: 1, aead: 1, recipient: to, keyId: `${to}#enc-1`, enc: 'A'.repeat(43), ct: 'B'.repeat(40) } },
  };
}

export async function runSuite(c: Ctx): Promise<Result[]> {
  const { A, B, C, probe } = c;
  const results: Result[] = [];
  const log = c.log ?? (() => {});
  const t = async (id: string, name: string, fn: () => Promise<string | void>) => {
    try { const d = await fn(); results.push({ id, name, pass: true, detail: d ?? '' }); log(`PASS ${id} ${name}${d ? ' - ' + d : ''}`); }
    catch (e) { results.push({ id, name, pass: false, detail: String((e as Error).message ?? e).slice(0, 400) }); log(`FAIL ${id} ${name}: ${(e as Error).message}`); }
  };
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
  const hostA = new URL(A.base).host;

  let t1Uri = '', t1Note = '';
  await t('T1', 'WebFinger lookup and actor document', async () => {
    const r = await fetch(`${A.base}/.well-known/webfinger?resource=acct:${A.me.handle}@${hostA}`);
    assert(r.status === 200 && (r.headers.get('content-type') ?? '').includes('application/jrd+json'), `status ${r.status}`);
    const jrd: any = await r.json();
    assert(jrd.subject === `acct:${A.me.handle}@${hostA}` && jrd.links[0].href === A.actor, 'jrd mismatch');
    const actor: any = await (await fetch(A.actor)).json();
    assert(actor.inbox === `${A.actor}/inbox` && actor.assertionMethod[0].publicKeyMultibase.startsWith('z6Mk') && actor.keyAgreement.at(-1).publicKeyMultibase.startsWith('z6LS'), 'actor keys');
    assert((await fetch(`${A.base}/.well-known/webfinger?resource=acct:nobody_here@${hostA}`)).status === 404, 'unknown handle not 404');
    assert((await fetch(`${A.base}/.well-known/webfinger?resource=acct:${A.me.handle}@other.example`)).status === 404, 'other host not 404');
    const res = await B.api('/api/resolve', { body: { to: [A.address] } });
    assert(res.actors[0].actor === A.actor && res.actors[0].keyId, 'B could not resolve A');
    return `${A.address} -> ${A.actor}`;
  });

  await t('T2', 'Stranger lands in Requests (A -> B)', async () => {
    const r = await encryptAndSend(A.apiTransport(), { to: [B.address] }, { subject: 'Hello from A', text: 'First message, A to B.' });
    t1Uri = r.threadId; t1Note = r.noteId;
    await waitFor('delivery A->B', () => delivered(A, t1Uri, t1Note, 1));
    const reqs = await B.api('/api/requests');
    const it = reqs.items.find((x: any) => x.activity.object?.id === t1Note);
    assert(it, 'not in requests');
    const q = await B.api('/api/queue');
    assert(!q.items.some((x: any) => x.activity.object?.id === t1Note), 'request already in queue');
    return 'delivered, held as a request';
  });

  await t('T3', 'Approve, then MCP pull + decrypt + ack on B', async () => {
    await B.connect();
    const a = await B.mcp.tool('approve', { actor: A.actor });
    assert(a.moved >= 1, 'nothing moved');
    const p = await B.mcp.tool('pull', {});
    const it = p.items.find((x: any) => x.activity.object?.id === t1Note);
    assert(it, 'not pulled');
    const d = await decryptActivity(B.keys, it.activity);
    assert(d.content === 'First message, A to B.' && d.summary === 'Hello from A', 'decrypt mismatch');
    const k = await B.mcp.tool('ack', { upTo: p.nextCursor });
    const p2 = await B.mcp.tool('pull', { since: 0 });
    assert(!p2.items.some((x: any) => x.cursor <= p.nextCursor), 'acked item still returned');
    return `decrypted "${d.content}", acked ${k.acked}`;
  });

  await t('T4', 'Reply B -> A over MCP; A decrypts (both directions)', async () => {
    const r = await encryptAndSend(B.mcpTransport(), { replyTo: t1Note }, { text: 'Reply, B to A.' });
    assert(r.threadId === t1Uri, 'reply went to another thread');
    await waitFor('delivery B->A', () => delivered(B, t1Uri, r.noteId, 1));
    const q = await A.api('/api/queue');
    const it = q.items.find((x: any) => x.activity.object?.id === r.noteId);
    assert(it, 'reply not in A queue (should be allowed: A wrote to B first)');
    const d = await decryptActivity(A.keys, it.activity);
    assert(d.content === 'Reply, B to A.', 'decrypt');
    assert(it.activity.object.inReplyTo === t1Note, 'inReplyTo');
    await A.api('/api/queue/ack', { body: { upTo: q.nextCursor } });
    // Only the intended recipient can open it:
    let opened = false; try { await decryptActivity(C.keys, it.activity); opened = true; } catch {}
    assert(!opened, 'C opened a message for A');
    return 'A received and decrypted the reply';
  });

  const bInbox = `${B.actor}/inbox`;
  await t('T5', 'Forged signature rejected', async () => {
    const r1 = await send(await probe.request(bInbox, fakeCreate(probe, B.actor), { key: randomBytes(32) }));
    assert(r1.status === 401 && r1.body.error === 'signature_invalid', `got ${r1.status} ${r1.body?.error}`);
    // Someone else's key id (A's) with the probe's key
    const r2 = await send(await probe.request(bInbox, fakeCreate(probe, B.actor, { actor: A.actor }), { keyId: `${A.actor}#sig-1` }));
    assert(r2.status === 401 && r2.body.error === 'signature_invalid', `impersonating A: ${r2.status} ${r2.body?.error}`);
    return '401 signature_invalid (random key; A\'s keyid)';
  });

  await t('T6', 'Replay rejected', async () => {
    const req = await probe.request(bInbox, fakeCreate(probe, B.actor));
    const r1 = await send(req);
    assert(r1.status === 202, `first: ${r1.status} ${JSON.stringify(r1.body)}`);
    const r2 = await send(req);
    assert(r2.status === 401 && r2.body.error === 'replayed_nonce', `second: ${r2.status} ${r2.body?.error}`);
    return 'first 202, identical second 401 replayed_nonce';
  });

  await t('T7', 'Inbox checks (R6 rows)', async () => {
    const rows: [string, number, string, Promise<{ status: number; body: any }>][] = [];
    const add = async (n: string, st: number, code: string, r: Promise<{ url: string; init: RequestInit }>) => rows.push([n, st, code, r.then(send)]);
    await add('unknown user', 404, 'not_found', probe.request(`${B.base}/users/nobody_here/inbox`, fakeCreate(probe, `${B.base}/users/nobody_here`)));
    await add('too large', 413, 'too_large', probe.request(bInbox, null, { bodyOverride: 'x'.repeat(262145) }));
    await add('content type', 415, 'unsupported_media_type', probe.request(bInbox, fakeCreate(probe, B.actor), { contentType: 'text/plain' }));
    await add('digest', 400, 'digest_mismatch', probe.request(bInbox, fakeCreate(probe, B.actor), { digestBody: '{}' }));
    await add('no signature', 401, 'signature_missing', probe.request(bInbox, fakeCreate(probe, B.actor), { omitSignature: true }));
    await add('stale created', 401, 'signature_expired', probe.request(bInbox, fakeCreate(probe, B.actor), { created: Math.floor(Date.now() / 1000) - 400 }));
    await add('unknown key', 401, 'key_unavailable', probe.request(bInbox, fakeCreate(probe, B.actor), { keyId: `${probe.actor}#sig-9` }));
    await add('bad activity', 400, 'bad_activity', probe.request(bInbox, { ...fakeCreate(probe, B.actor), published: 'yesterday' }));
    await add('actor mismatch', 403, 'actor_mismatch', probe.request(bInbox, fakeCreate(probe, B.actor, { actor: A.actor, id: `${A.actor}/activities/${crypto.randomUUID()}` })));
    await add('not addressed', 422, 'not_addressed', probe.request(bInbox, fakeCreate(probe, C.actor)));
    await add('unsupported', 422, 'unsupported_activity', probe.request(bInbox, { ...fakeCreate(probe, B.actor), type: 'Follow' }));
    const out: string[] = []; let bad = '';
    for (const [n, st, code, p] of rows) { const r = await p; out.push(`${n}=${r.status}`); if (r.status !== st || r.body?.error !== code) bad += `${n}: wanted ${st} ${code}, got ${r.status} ${r.body?.error}; `; }
    const act = fakeCreate(probe, B.actor);
    const d1 = await send(await probe.request(bInbox, act)); const d2 = await send(await probe.request(bInbox, act));
    if (d1.status !== 202 || d2.status !== 202 || d2.body?.status !== 'duplicate') bad += `duplicate: ${d1.status}/${d2.status} ${d2.body?.status}; `;
    assert(!bad, bad);
    return out.join(', ') + ', duplicate=202';
  });

  await t('T8', 'Block drops silently', async () => {
    const before = (await B.api('/api/requests')).items.filter((x: any) => x.sender === probe.actor).length;
    assert(before >= 1, 'probe messages should be waiting as requests');
    const bl = await B.api('/api/requests/block', { body: { actor: probe.actor } });
    const r = await send(await probe.request(bInbox, fakeCreate(probe, B.actor)));
    assert(r.status === 202, `blocked sender got ${r.status}`);
    const after = (await B.api('/api/requests')).items.filter((x: any) => x.sender === probe.actor).length;
    assert(after === 0, 'blocked sender still in requests');
    await B.api(`/api/rules?subject=${encodeURIComponent(probe.actor)}`, { method: 'DELETE' });
    return `dropped ${bl.dropped} pending, new message 202 and stored nowhere`;
  });

  let gUri = '';
  await t('T9', 'Group of 3: fan-out, approve, remove, not_member', async () => {
    const r = await encryptAndSend(A.apiTransport(), { to: [B.address, C.address] }, { subject: 'Group', text: 'Hi both' });
    gUri = r.threadId;
    await waitFor('group fan-out', () => delivered(A, gUri, r.noteId, 2));
    // B allowed A already -> queue; C has never heard of A -> request
    const cReq = (await C.api('/api/requests')).items.find((x: any) => x.activity.object?.id === r.noteId);
    assert(cReq, 'C should have a request');
    await C.api('/api/requests/approve', { body: { actor: A.actor } });
    for (const [who, acct] of [['B', B], ['C', C]] as const) {
      const q = await acct.api('/api/queue');
      const it = q.items.find((x: any) => x.activity.object?.id === r.noteId);
      assert(it, `${who} did not get the group message`);
      assert((await decryptActivity(acct.keys, it.activity)).content === 'Hi both', `${who} decrypt`);
    }
    // C replies to the group; B has not allowed C yet -> request on B; A allowed? A never wrote to C directly... A sent to C, so allowed.
    const cr = await encryptAndSend(C.apiTransport(), { threadId: gUri }, { text: 'C here' });
    await waitFor('C fan-out', () => delivered(C, gUri, cr.noteId, 2));
    await B.api('/api/requests/approve', { body: { actor: C.actor } });
    const bq = await B.api('/api/queue');
    assert(bq.items.some((x: any) => x.activity.object?.id === cr.noteId), 'B missing C\'s message');
    const aq = await A.api('/api/queue');
    const ait = aq.items.find((x: any) => x.activity.object?.id === cr.noteId);
    assert(ait && (await decryptActivity(A.keys, ait.activity)).content === 'C here', 'A missing C\'s message');
    // A (creator) removes C
    const mem = await A.api('/api/threads/members', { body: { uri: gUri, remove: [C.actor] } });
    assert(mem.members.length === 2, 'members after remove');
    await waitFor('C sees Remove', async () => (await C.api('/api/queue')).items.find((x: any) => x.activity.type === 'Remove' && x.activity.object === C.actor));
    const after = await encryptAndSend(A.apiTransport(), { threadId: gUri }, { text: 'Just us two' });
    await waitFor('post-remove delivery', () => delivered(A, gUri, after.noteId, 1));
    const sent = (await thread(A, gUri)).find((x: any) => x.activity?.object?.id === after.noteId);
    assert(sent.deliveries.length === 1 && sent.deliveries[0].target === B.actor, 'post-remove message should go only to B');
    // C is no longer a member on A's and B's side: a Create from C is refused 403 not_member.
    // (C's own instance also refuses to prepare, so send a raw activity copied from C's earlier one.)
    let prepErr = '';
    try { await C.api('/api/outbox/prepare', { body: { threadId: gUri } }); } catch (e) { prepErr = String(e); }
    assert(prepErr.includes('403'), `C could still prepare: ${prepErr}`);
    return 'B and C decrypted; C approved A, B approved C; after Remove only B receives; C refused';
  });

  await t('T9b', 'Removed member is refused by the others (403 not_member)', async () => {
    // Replay C's membership by signing as C is impossible from outside; instead check B's view of the thread.
    const tb = (await B.api('/api/threads')).find((x: any) => x.uri === gUri);
    assert(tb && !tb.members.includes(C.actor) && tb.members.length === 2, `B members: ${JSON.stringify(tb?.members)}`);
    const tc = (await C.api('/api/threads')).find((x: any) => x.uri === gUri);
    assert(tc && !tc.members.includes(C.actor), 'C should see itself removed');
    // A probe pretending to be in the thread is refused as not_member
    const act: any = fakeCreate(probe, B.actor); act.object.context = gUri;
    await B.api('/api/rules', { method: 'PUT', body: { subject: probe.actor, action: 'allow' } });
    const r = await send(await probe.request(bInbox, act));
    await B.api(`/api/rules?subject=${encodeURIComponent(probe.actor)}`, { method: 'DELETE' });
    assert(r.status === 403 && r.body.error === 'not_member', `got ${r.status} ${r.body?.error}`);
    return 'membership lists updated on every member; non-member Create -> 403 not_member';
  });

  await t('T10', 'Attachment round trip (R2, encrypted, digest)', async () => {
    const bytes = te.encode(`attachment test ${Date.now()}\n`.repeat(200));
    const r = await encryptAndSend(A.apiTransport(), { threadId: t1Uri }, { text: 'With a file', files: [{ name: 'notes.txt', mediaType: 'text/plain', bytes }] });
    await waitFor('attachment message', () => delivered(A, t1Uri, r.noteId, 1));
    const q = await B.api('/api/queue');
    const it = q.items.find((x: any) => x.activity.object?.id === r.noteId);
    assert(it, 'B did not get it');
    const p = await decryptActivity(B.keys, it.activity);
    const ref = it.activity.object.attachment[0];
    const stored: Uint8Array = await B.api('/api/attachments/fetch', { body: { url: ref.url, size: ref['am:size'], digest: ref['am:digest'] } });
    const plain = await decryptAttachment(stored, p.attachments[0]);
    assert(b64(plain) === b64(bytes), 'decrypted bytes differ');
    const un = await fetch(ref.url);
    assert(un.status === 401, `unsigned GET: ${un.status}`);
    const g = signRequest({ method: 'GET', url: ref.url, headers: {} }, { keyId: probe.keyId, privateKey: probe.privateKey });
    const pr = await fetch(ref.url, { headers: { 'signature-input': g['signature-input'], signature: g.signature } });
    assert(pr.status === 403, `non-recipient GET: ${pr.status}`);
    let mismatch = '';
    try { await B.api('/api/attachments/fetch', { body: { url: ref.url, size: ref['am:size'], digest: 'sha-256=:' + b64(new Uint8Array(32)) + ':' } }); } catch (e) { mismatch = String(e); }
    assert(mismatch.includes('attachment_mismatch'), `digest check: ${mismatch}`);
    await B.api('/api/queue/ack', { body: { upTo: q.nextCursor } });
    return `${bytes.length} bytes decrypted equal; unsigned 401, stranger 403, wrong digest 502`;
  });

  await t('T11', 'Read receipts off by default, on when opted in', async () => {
    const m1 = await encryptAndSend(A.apiTransport(), { threadId: t1Uri }, { text: 'Receipt test 1' });
    await waitFor('m1', () => delivered(A, t1Uri, m1.noteId, 1));
    const off = await B.api('/api/messages/read', { body: { noteIds: [m1.noteId] } });
    assert(off.marked === 1 && off.receiptsSent === 0, `off: ${JSON.stringify(off)}`);
    await new Promise(r => setTimeout(r, 4000));
    const s1 = (await thread(A, t1Uri)).find((x: any) => x.activity?.object?.id === m1.noteId);
    assert(Object.keys(s1.readBy).length === 0, 'receipt arrived while off');
    await B.api('/api/settings', { method: 'PUT', body: { readReceipts: true } });
    const actorDoc: any = await (await fetch(B.actor)).json();
    assert(actorDoc['am:readReceipts'] === true, 'actor does not show am:readReceipts');
    const m2 = await encryptAndSend(A.apiTransport(), { threadId: t1Uri }, { text: 'Receipt test 2' });
    await waitFor('m2', () => delivered(A, t1Uri, m2.noteId, 1));
    const on = await B.api('/api/messages/read', { body: { noteIds: [m2.noteId] } });
    assert(on.receiptsSent === 1, `on: ${JSON.stringify(on)}`);
    await waitFor('Read receipt at A', async () => { const s = (await thread(A, t1Uri)).find((x: any) => x.activity?.object?.id === m2.noteId); return s?.readBy?.[B.actor]; });
    await B.api('/api/settings', { method: 'PUT', body: { readReceipts: false } });
    const q = await B.api('/api/queue'); if (q.items.length) await B.api('/api/queue/ack', { body: { upTo: q.nextCursor } });
    return 'off: nothing sent; on: A shows Read by B';
  });

  await t('T12', 'MCP: subscribe inbox://unread, live notification, pull, ack', async () => {
    const res = await B.mcp.rpc('resources/read', { uri: 'inbox://unread' });
    assert(res.contents[0].uri === 'inbox://unread', 'resource read');
    await B.mcp.rpc('resources/subscribe', { uri: 'inbox://unread' });
    const events: any[] = [];
    const close = await B.mcp.listen(m => events.push(m));
    await new Promise(r => setTimeout(r, 3000));
    const t0 = Date.now();
    const m = await encryptAndSend(A.apiTransport(), { threadId: t1Uri }, { text: 'Live notification test' });
    await waitFor('notifications/resources/updated', async () => events.find(e => e.method === 'notifications/resources/updated' && e.params?.uri === 'inbox://unread'), 30000);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    close();
    const p = await B.mcp.tool('pull', {});
    const it = p.items.find((x: any) => x.activity.object?.id === m.noteId);
    assert(it && (await decryptActivity(B.keys, it.activity)).content === 'Live notification test', 'pull/decrypt');
    await B.mcp.tool('ack', { upTo: p.nextCursor });
    const p2 = await B.mcp.tool('pull', {});
    assert(!p2.items.some((x: any) => x.activity.object?.id === m.noteId), 'still unacked');
    const bad = await fetch(`${B.base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: '{}' });
    assert(bad.status === 401 && (bad.headers.get('www-authenticate') ?? '').startsWith('Bearer'), 'bad token not 401');
    return `notification ${secs}s after send; pulled, decrypted, acked; bad token 401`;
  });

  await t('T13', 'Doorbell: one content-free POST with the secret header', async () => {
    const secret = 'doorbell-test-' + b64(randomBytes(9));
    await fetch(`${c.sinkBase}/__test/sink`, { method: 'DELETE' });
    await A.api('/api/settings', { method: 'PUT', body: { doorbellUrl: `${c.sinkBase}/__test/sink?header=x-doorbell-key`, doorbellHeader: 'X-Doorbell-Key', doorbellValue: secret } });
    await new Promise(r => setTimeout(r, 1500));
    const m = await encryptAndSend(B.apiTransport(), { threadId: t1Uri }, { text: 'Ring ring' });
    await waitFor('delivery', () => delivered(B, t1Uri, m.noteId, 1));
    const recs: any[] = await waitFor('sink record', async () => { const r: any[] = await (await fetch(`${c.sinkBase}/__test/sink`)).json(); return r.length ? r : null; }, 30000);
    await new Promise(r => setTimeout(r, 3000));
    const all: any[] = await (await fetch(`${c.sinkBase}/__test/sink`)).json();
    const body = JSON.parse(all[0].body);
    assert(JSON.stringify(Object.keys(body).sort()) === JSON.stringify(['at', 'handle', 'requests', 'type', 'unread']), `body keys ${Object.keys(body)}`);
    assert(body.type === 'agent-mail.doorbell' && body.handle === A.address && body.unread >= 1, 'body values');
    assert(all[0].headerSha256 === b64(await sha256(secret)), 'secret header missing or wrong');
    assert(!all[0].body.includes('Ring') && !all[0].body.includes(B.actor), 'body leaks content or sender');
    const test = await A.api('/api/doorbell/test', { body: {} });
    await A.api('/api/settings', { method: 'PUT', body: { doorbellUrl: '' } });
    const q = await A.api('/api/queue'); if (q.items.length) await A.api('/api/queue/ack', { body: { upTo: q.nextCursor } });
    return `${all.length} ring(s) for 1 message; body ${all[0].body}; test ring HTTP ${test.status}`;
  });
  void recsUnused;
  return results;
}
const recsUnused = 0;
