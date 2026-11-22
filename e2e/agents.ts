// The agent test plan (R12, R13, R16-R19): what makes an instance safe and usable for an unattended agent.
// Runs after suite.ts against the same accounts. Used by e2e.ts (local) and live.ts (deployed instances).
import { Account, send, waitFor } from './lib';
import { Ctx, Result } from './suite';
import { McpClient } from '../cli/src/mcp-client';
import { main as cli } from '../cli/src/cli';
import { encryptAndSend, decryptActivity, newKeyFile, Transport } from '../src/shared/client';
import { b64, b64url, sha256, randomBytes } from '../src/shared/enc';
import { ACTIVITY_CONTEXT } from '../src/shared/activity';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const enc = encodeURIComponent;

/** A request with only a bearer token: what an agent can reach. */
async function bearer(base: string, token: string, path: string, o: { method?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, { method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'), headers: { authorization: `Bearer ${token}`, ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}
/** A transport that remembers the last send body, to repeat exactly the same call. */
function capturing(t: Transport) { const c = { last: null as any, t: { ...t, send: (b: unknown) => { c.last = b; return t.send(b); } } as Transport }; return c; }

export async function runAgentSuite(c: Ctx): Promise<Result[]> {
  const { A, B, C, probe } = c;
  const results: Result[] = [];
  const log = c.log ?? (() => {});
  const t = async (id: string, name: string, fn: () => Promise<string | void>) => {
    try { const d = await fn(); results.push({ id, name, pass: true, detail: d ?? '' }); log(`PASS ${id} ${name}${d ? ' - ' + d : ''}`); }
    catch (e) { results.push({ id, name, pass: false, detail: String((e as Error).message ?? e).slice(0, 500) }); log(`FAIL ${id} ${name}: ${(e as Error).message}`); }
  };
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
  const threadOf = (acct: Account, uri: string) => acct.api(`/api/threads/messages?uri=${enc(uri)}`);
  const delivered = async (acct: Account, uri: string, noteId: string, n = 1) => {
    const m = (await threadOf(acct, uri) as any[]).find(x => x.activity?.object?.id === noteId);
    return m && m.deliveries.filter((d: any) => d.status === 'delivered').length >= n ? m : null;
  };
  const inQueue = async (acct: Account, noteId: string) => (await acct.api('/api/queue?limit=100')).items.find((x: any) => x.activity.object?.id === noteId);

  await t('T14', 'MCP conformance and discovery', async () => {
    const list = await B.mcp.rpc('tools/list');
    const names: string[] = list.tools.map((x: any) => x.name);
    for (const n of ['whoami', 'pull', 'thread_messages', 'get_message', 'upload_attachment', 'send_message', 'change_members', 'list_approvals', 'cancel_approval']) assert(names.includes(n), `tool ${n} missing`);
    assert(list.tools.every((x: any) => x.annotations && typeof x.annotations.readOnlyHint === 'boolean' && x.title && !('scope' in x)), 'every tool needs annotations and a title');
    for (const [name, args] of [['whoami', {}], ['pull', {}], ['list_requests', {}], ['list_threads', {}], ['list_approvals', {}]] as const) {
      const r = await B.mcp.rpc('tools/call', { name, arguments: args });
      assert(!r.isError && r.structuredContent && typeof r.structuredContent === 'object' && !Array.isArray(r.structuredContent), `${name}: structuredContent must be an object`);
    }
    const threads = (await B.mcp.tool('list_threads')).threads;
    assert(Array.isArray(threads) && threads.length >= 1, 'list_threads.threads');
    const hist = await B.mcp.tool('thread_messages', { threadId: threads[0].uri, limit: 2 });
    assert(hist.messages.length >= 1 && hist.messages.length <= 2, 'thread_messages limit');
    const noteId = hist.messages.find((x: any) => x.type === 'Create')?.activity.object.id;
    if (noteId) assert((await B.mcp.tool('get_message', { noteId })).activity.object.id === noteId, 'get_message');
    const init = await (await fetch(`${B.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${B.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) })).json() as any;
    assert(init.result.protocolVersion === '2025-11-25', `protocol ${init.result.protocolVersion}`);
    const un = await fetch(`${B.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert(un.status === 401 && /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource"/.test(un.headers.get('www-authenticate') ?? ''), 'the 401 must point at the resource metadata');
    const pre = await fetch(`${B.base}/mcp`, { method: 'OPTIONS', headers: { origin: 'https://client.example', 'access-control-request-method': 'POST' } });
    assert(pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*', 'CORS preflight on /mcp');
    const checks: [string, RequestInit, number, string][] = [
      ['/.well-known/oauth-protected-resource', {}, 200, 'application/json'], ['/.well-known/oauth-authorization-server', {}, 200, 'application/json'],
      ['/.well-known/openid-configuration', {}, 404, 'application/json'], ['/nonexistent.json', {}, 404, 'application/json'], ['/some/page', { headers: { accept: 'text/html' } }, 404, 'application/json'],
      ['/robots.txt', {}, 200, 'text/plain'], ['/llms.txt', {}, 200, 'text/plain'], ['/', { headers: { accept: 'text/markdown' } }, 200, 'text/markdown'],
      ['/', { headers: { accept: 'text/html' } }, 200, 'text/html'], ['/settings', {}, 200, 'text/html'], ['/oauth/authorize', {}, 200, 'text/html'],
    ];
    for (const [p, init2, status, type] of checks) {
      const r = await fetch(B.base + p, init2);
      assert(r.status === status && (r.headers.get('content-type') ?? '').startsWith(type), `${p}: wanted ${status} ${type}, got ${r.status} ${r.headers.get('content-type')}`);
    }
    assert((await (await fetch(`${B.base}/llms.txt`)).text()).includes(`${B.base}/mcp`), 'llms.txt names the MCP endpoint');
    return `${names.length} tools, all results are objects; unknown paths 404 JSON; discovery files served`;
  });

  await t('T15', 'A connector token cannot administer the account; scopes limit the rest', async () => {
    const tok = B.token;
    const admin: [string, string, unknown][] = [
      ['POST', '/api/tokens', { label: 'minted-by-agent' }], ['GET', '/api/tokens', undefined], ['DELETE', `/api/tokens/${B.tokenId}`, undefined],
      ['PUT', '/api/keys/encryption', { publicKey: b64url(randomBytes(32)) }], ['PUT', '/api/keys/client', { publicKey: b64url(randomBytes(32)) }],
      ['PUT', '/api/settings', { doorbellUrl: 'https://collector.example/ring' }], ['POST', '/api/doorbell/test', {}],
      ['PUT', '/api/rules', { subject: 'domain:anyone.example', action: 'allow' }], ['DELETE', `/api/rules?subject=${enc(A.actor)}`, undefined],
      ['POST', '/api/approvals/1/approve', {}], ['POST', '/api/approvals/1/deny', {}], ['POST', '/api/oauth/approve', { allow: true, params: {} }],
    ];
    let bad = '';
    for (const [method, path, body] of admin) {
      const r = await bearer(B.base, tok, path, { method, body });
      if (r.status !== 403 || r.body?.error !== 'session_required') bad += `${method} ${path}: ${r.status} ${r.body?.error}; `;
    }
    assert(!bad, bad);
    const actor: any = await (await fetch(B.actor)).json();
    assert(actor.keyAgreement.length === 1, 'a token must not be able to publish a key');
    const ro = await B.agent({ label: 'read-only', scopes: ['read'] });
    const roTools: string[] = (await ro.mcp.rpc('tools/list')).tools.map((x: any) => x.name);
    assert(roTools.includes('pull') && !roTools.includes('send_message') && !roTools.includes('approve'), `read-only tools: ${roTools}`);
    const call = await ro.mcp.rpc('tools/call', { name: 'prepare_message', arguments: { to: [A.address] } });
    assert(call.isError && call.content[0].text.includes('insufficient_scope'), 'prepare_message with a read-only token');
    const rest = await bearer(B.base, ro.token, '/api/outbox/prepare', { body: { to: [A.address] } });
    assert(rest.status === 403 && rest.body.error === 'insufficient_scope', `REST prepare: ${rest.status}`);
    const appr = await bearer(B.base, ro.token, '/api/requests/approve', { body: { actor: A.actor } });
    assert(appr.status === 403 && appr.body.error === 'insufficient_scope', `REST approve: ${appr.status}`);
    const me = await bearer(B.base, ro.token, '/api/me');
    assert(me.status === 200 && me.body.user.token.scopes.join() === 'read' && !('email' in me.body.user), 'a token sees its own scopes and not the email');
    await B.api(`/api/tokens/${ro.id}`, { method: 'DELETE' });
    assert((await bearer(B.base, ro.token, '/api/me')).status === 401, 'a revoked token must stop working');
    return `${admin.length} admin routes answer 403 session_required; read-only token cannot send or approve`;
  });

  let agentsThread = '', ping = '';
  await t('T16', 'Agents act alone; sensitive actions wait for the owner', async () => {
    const ag = await B.agent({ label: 'Asker', ask: ['first_contact', 'policy', 'members'] });
    const cap = capturing(ag.transport);
    // C becomes someone B has no rule for.
    await B.api(`/api/rules?subject=${enc(C.actor)}`, { method: 'DELETE' });
    const held = await encryptAndSend(cap.t, { to: [C.address] }, { subject: 'Intro', text: 'Hello C, from B\'s agent.' });
    assert(held.status === 'pending_approval' && held.reason === 'first_contact' && held.approvalId, `first contact: ${JSON.stringify(held)}`);
    const again = await ag.mcp.tool('send_message', cap.last);
    assert(again.approvalId === held.approvalId, 'repeating a held send must return the same approval');
    await sleep(1500);
    assert(!(await inQueue(C, held.noteId)) && !(await C.api('/api/requests')).items.some((x: any) => x.activity.object?.id === held.noteId), 'a held message was delivered');
    const item = (await B.api('/api/approvals')).items.find((x: any) => x.id === held.approvalId);
    assert(item && item.kind === 'send' && item.status === 'pending' && item.agent === 'Asker' && item.subject.newContacts.includes(C.actor), `owner view: ${JSON.stringify(item)?.slice(0, 200)}`);
    assert((await decryptActivity(B.keys, item.activity)).content === 'Hello C, from B\'s agent.', 'the owner must be able to read what they approve');
    const mine = (await ag.mcp.tool('list_approvals')).items.find((x: any) => x.id === held.approvalId);
    assert(mine && mine.status === 'pending' && !mine.activity, 'agent view of its approval');
    assert((await B.api('/api/me')).user.approvals >= 1, 'the owner badge counts pending approvals');
    const done = await B.api(`/api/approvals/${held.approvalId}/approve`, { body: {} });
    assert(done.status === 'approved' && done.result.status === 'sent', `approve: ${JSON.stringify(done)}`);
    await waitFor('approved message at C', async () => (await inQueue(C, held.noteId)) || (await C.api('/api/requests')).items.find((x: any) => x.activity.object?.id === held.noteId));
    assert((await ag.mcp.tool('list_approvals')).items.find((x: any) => x.id === held.approvalId).status === 'approved', 'the agent sees the outcome');
    const twice = await B.api(`/api/approvals/${held.approvalId}/approve`, { body: {}, expect: 409 });
    assert(twice.error === 'already_decided', 'deciding twice');

    // To someone the owner already allows, the agent sends without asking.
    const m = await encryptAndSend(A.apiTransport(), { to: [B.address] }, { subject: 'Agents', text: 'Ping for the agent' });
    agentsThread = m.threadId; ping = m.noteId;
    await waitFor('ping delivered', () => delivered(A, agentsThread, ping));
    const r = await encryptAndSend(ag.transport, { replyTo: ping }, { text: 'Pong, sent without asking.' });
    assert(r.status === 'sent', `autonomous reply: ${JSON.stringify(r)}`);
    // ...unless the agent itself says the message is sensitive.
    const s = await encryptAndSend(cap.t, { replyTo: ping }, { text: 'I will wire the money today.', sensitive: true });
    assert(s.status === 'pending_approval' && s.reason === 'agent_flagged', `sensitive: ${JSON.stringify(s)}`);
    const denied = await B.api(`/api/approvals/${s.approvalId}/deny`, { body: {} });
    assert(denied.status === 'denied', 'deny');
    assert((await ag.mcp.tool('send_message', cap.last)).status === 'denied', 'a denied message must not be sent by asking again');
    const r2 = await encryptAndSend(ag.transport, { replyTo: ping }, { text: 'After the denied one.' });
    const got = await waitFor('reply after denial at A', () => inQueue(A, r2.noteId));
    assert(got.gapBefore === 0, `a denied message must not leave a sequence gap (gapBefore ${got.gapBefore})`);
    assert(!(await inQueue(A, s.noteId)), 'the denied message reached A');

    // Letting a stranger in is the owner's call.
    const act = { '@context': ACTIVITY_CONTEXT, id: `${probe.actor}/activities/${crypto.randomUUID()}`, type: 'Create', actor: probe.actor, published: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), to: [B.actor],
      object: { id: `${probe.actor}/notes/${crypto.randomUUID()}`, type: 'Note', attributedTo: probe.actor, to: [B.actor], published: new Date().toISOString(), context: `${probe.actor}/threads/${crypto.randomUUID()}`, inReplyTo: null,
        content: 'This message is end-to-end encrypted.', 'am:seq': 1, 'am:encrypted': { kem: 32, kdf: 1, aead: 1, recipient: B.actor, keyId: `${B.actor}#enc-1`, enc: 'A'.repeat(43), ct: 'B'.repeat(40) } } };
    assert((await send(await probe.request(`${B.actor}/inbox`, act))).status === 202, 'probe request');
    const ap = await ag.mcp.tool('approve', { actor: probe.actor });
    assert(ap.status === 'pending_approval' && ap.reason === 'policy', `approve by agent: ${JSON.stringify(ap)}`);
    assert((await B.api('/api/requests')).items.some((x: any) => x.sender === probe.actor), 'the request must still be waiting');
    const cancelled = await ag.mcp.tool('cancel_approval', { id: ap.approvalId });
    assert(cancelled.status === 'cancelled', 'cancel');
    const ap2 = await ag.mcp.tool('block', { actor: probe.actor });
    const blocked = await B.api(`/api/approvals/${ap2.approvalId}/approve`, { body: {} });
    assert(blocked.status === 'approved' && blocked.result.dropped >= 1, `block after approval: ${JSON.stringify(blocked)}`);
    await B.api(`/api/rules?subject=${enc(probe.actor)}`, { method: 'DELETE' });
    const mem = await ag.mcp.tool('change_members', { threadId: agentsThread, remove: [B.actor] });
    assert(mem.status === 'pending_approval' && mem.reason === 'members', 'leaving a thread is held');
    await B.api(`/api/approvals/${mem.approvalId}/deny`, { body: {} });
    await B.api(`/api/tokens/${ag.id}`, { method: 'DELETE' });
    return 'first contact held then delivered on approval; allowed contact sent at once; sensitive denied, no gap; approve/block/members held';
  });

  await t('T17', 'Each agent has its own queue; a repeated send goes out once; agent messages are marked', async () => {
    const one = await B.agent({ label: 'One' }), two = await B.agent({ label: 'Two' });
    assert((await one.mcp.tool('pull')).items.length === 0, 'a new agent starts at the end of the queue');
    const m = await encryptAndSend(A.apiTransport(), { threadId: agentsThread }, { text: 'For both agents' });
    await waitFor('delivered', () => delivered(A, agentsThread, m.noteId));
    const has = async (mcp: McpClient) => (await mcp.tool('pull')).items.find((x: any) => x.noteId === m.noteId);
    const it1 = await has(one.mcp), it2 = await has(two.mcp);
    assert(it1 && it2, 'both agents must see the message');
    const a1 = await one.mcp.tool('ack', { upTo: it1.cursor });
    assert(a1.acked >= 1 && a1.unread === 0, `ack: ${JSON.stringify(a1)}`);
    assert(!(await has(one.mcp)), 'acked item still in the first agent\'s queue');
    assert(await has(two.mcp), 'one agent\'s ack must not empty the other\'s queue');
    assert(await inQueue(B, m.noteId), 'nor the owner\'s');
    const far = await two.mcp.tool('ack', { upTo: 999999999 });
    const later = await encryptAndSend(A.apiTransport(), { threadId: agentsThread }, { text: 'After a far ack' });
    await waitFor('delivered', () => delivered(A, agentsThread, later.noteId));
    assert((await two.mcp.tool('pull')).items.some((x: any) => x.noteId === later.noteId), `acking beyond the end must not swallow later mail (${JSON.stringify(far)})`);
    assert((await two.mcp.tool('ack', { ids: [(await two.mcp.tool('pull')).items[0].cursor] })).acked === 1, 'ack by ids');

    const cap = capturing(one.transport);
    const sent = await encryptAndSend(cap.t, { replyTo: m.noteId }, { text: 'Sent once.', agentName: 'One' });
    const repeat = await one.mcp.tool('send_message', cap.last);
    assert(sent.status === 'sent' && repeat.duplicate === true && repeat.noteId === sent.noteId, `repeat: ${JSON.stringify(repeat)}`);
    await waitFor('reply at A', () => inQueue(A, sent.noteId));
    await sleep(1500);
    const copies = (await A.api('/api/queue?limit=100')).items.filter((x: any) => x.activity.object?.id === sent.noteId);
    assert(copies.length === 1, `delivered ${copies.length} times`);
    assert(copies[0].agent === true && copies[0].activity.object['am:agent'] === true, 'a message sent with a token carries am:agent');
    assert((await decryptActivity(A.keys, copies[0].activity)).agent?.name === 'One', 'the agent name travels inside the ciphertext');
    const human = await encryptAndSend(B.apiTransport(), { threadId: agentsThread }, { text: 'From the owner.' });
    const h = await waitFor('owner message at A', () => inQueue(A, human.noteId));
    assert(h.agent === false && !('am:agent' in h.activity.object), 'a message the owner sent must not be marked');
    for (const x of [one, two]) await B.api(`/api/tokens/${x.id}`, { method: 'DELETE' });
    for (const acct of [A, B]) { const q = await acct.api('/api/queue?limit=100'); if (q.items.length) await acct.api('/api/queue/ack', { body: { upTo: q.items.at(-1).cursor } }); }
    return 'two agents, separate positions; repeated send_message delivered once; am:agent set for tokens only';
  });

  await t('T18', 'An agent with its own key reads mail without the owner\'s key', async () => {
    const tok = await B.api('/api/tokens', { body: { label: 'Keyed', ask: [] } });
    const key = newKeyFile(B.address, B.actor, '');
    const reg = await B.api('/api/keys/client', { method: 'PUT', body: { publicKey: key.publicKey, label: 'Keyed', tokenId: tok.id } });
    key.keyId = reg.keyId;
    const actor: any = await (await fetch(B.actor)).json();
    assert(actor.keyAgreement.at(-1).id === B.keys.at(-1)!.keyId, 'the owner\'s key must stay last (0.1 senders use the last key)');
    assert(actor['am:alsoEncryptTo']?.includes(key.keyId) && actor.keyAgreement.some((k: any) => k.id === key.keyId), 'the client key must be listed');
    await waitFor('A sees the new key', async () => (await A.api('/api/resolve', { body: { to: [B.address] } })).actors[0].alsoKeys.some((k: any) => k.keyId === key.keyId && k.publicKey === key.publicKey), 40000);
    const m = await encryptAndSend(A.apiTransport(), { threadId: agentsThread }, { subject: 'Keys', text: 'Readable with the agent\'s own key.' });
    await waitFor('delivered', () => delivered(A, agentsThread, m.noteId));
    const mcp = new McpClient(`${B.base}/mcp`, tok.token); await mcp.init();
    const it = (await mcp.tool('pull')).items.find((x: any) => x.noteId === m.noteId);
    assert(it && it.activity.object['am:copies']?.some((x: any) => x.keyId === key.keyId), 'no copy for the client key');
    assert((await decryptActivity([key], it.activity)).content === 'Readable with the agent\'s own key.', 'the agent key must open it');
    assert((await decryptActivity(B.keys, it.activity)).content === 'Readable with the agent\'s own key.', 'the owner key must still open it');
    let opened = false; try { await decryptActivity(C.keys, it.activity); opened = true; } catch {}
    assert(!opened, 'another user opened it');
    // What the agent sends is readable by the agent afterwards (its own copy).
    const transport: Transport = { prepare: a => mcp.tool('prepare_message', a), upload: b => B.api('/api/attachments', { raw: b }), send: b => mcp.tool('send_message', b) };
    const r = await encryptAndSend(transport, { replyTo: m.noteId }, { text: 'Reply sealed to my own client key too.' });
    const mine = (await mcp.tool('thread_messages', { threadId: agentsThread })).messages.find((x: any) => x.activity?.object?.id === r.noteId);
    assert(mine && (await decryptActivity([key], mine.activity)).content === 'Reply sealed to my own client key too.', 'the agent cannot read its own sent message');
    await B.api(`/api/tokens/${tok.id}`, { method: 'DELETE' });
    const after: any = await (await fetch(B.actor)).json();
    assert(!after.keyAgreement.some((k: any) => k.id === key.keyId) && !after['am:alsoEncryptTo'], 'revoking the token must remove its key');
    const next = await B.api('/api/keys/client', { method: 'PUT', body: { publicKey: newKeyFile(B.address, B.actor, '').publicKey, label: 'Next' } });
    assert(next.keyId !== key.keyId, 'a key id must never be reused for another key');
    await B.api(`/api/keys/client/${next.n}`, { method: 'DELETE' });
    return `client key ${key.keyId.split('#')[1]} listed in am:alsoEncryptTo, decrypts copies; removed with the token`;
  });

  await t('T19', 'OAuth: register, consent, PKCE token, refresh, revoke', async () => {
    const meta: any = await (await fetch(`${B.base}/.well-known/oauth-protected-resource`)).json();
    assert(meta.resource === `${B.base}/mcp` && meta.authorization_servers[0] === B.base, 'resource metadata');
    const as: any = await (await fetch(`${B.base}/.well-known/oauth-authorization-server`)).json();
    assert(as.issuer === B.base && as.code_challenge_methods_supported.includes('S256') && as.registration_endpoint && as.client_id_metadata_document_supported === true, 'server metadata');
    const reg = await fetch(as.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'E2E Client', redirect_uris: ['http://localhost:9/callback'] }) });
    const client: any = await reg.json();
    assert(reg.status === 201 && client.client_id, `register: ${reg.status}`);
    const badReg = await fetch(as.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['javascript:alert(1)'] }) });
    assert(badReg.status === 400, 'a javascript: redirect must be refused');
    const verifier = b64url(randomBytes(32)), challenge = b64url(await sha256(verifier));
    const params = { response_type: 'code', client_id: client.client_id, redirect_uri: 'http://localhost:9/callback', code_challenge: challenge, code_challenge_method: 'S256', state: 'st4te', scope: 'read send', resource: `${B.base}/mcp` };
    const info = await B.api(`/api/oauth/client?${new URLSearchParams(params)}`);
    assert(info.name === 'E2E Client' && info.redirectHost === 'localhost:9' && info.scopes.join(' ') === 'read send', `consent info: ${JSON.stringify(info)}`);
    await B.api(`/api/oauth/client?${new URLSearchParams({ ...params, redirect_uri: 'https://evil.example/cb' })}`, { expect: 400 });
    await B.api(`/api/oauth/client?${new URLSearchParams({ ...params, code_challenge_method: 'plain' })}`, { expect: 400 });
    const code = async (scopes: string[]) => new URL((await B.api('/api/oauth/approve', { body: { allow: true, params, scopes, ask: [] } })).redirect).searchParams;
    const back = await code(['read']);
    assert(back.get('code') && back.get('state') === 'st4te' && back.get('iss') === B.base, 'redirect carries code, state and iss');
    const no = new URL((await B.api('/api/oauth/approve', { body: { allow: false, params } })).redirect).searchParams;
    assert(no.get('error') === 'access_denied' && !no.get('code'), 'deny');
    const tokenReq = async (p: Record<string, string>) => { const r = await fetch(as.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(p) }); return { status: r.status, body: await r.json() as any }; };
    const wrong = await tokenReq({ grant_type: 'authorization_code', code: (await code(['read'])).get('code')!, code_verifier: b64url(randomBytes(32)), client_id: client.client_id });
    assert(wrong.status === 400 && wrong.body.error === 'invalid_grant', 'a wrong code_verifier must fail');
    const tk = await tokenReq({ grant_type: 'authorization_code', code: back.get('code')!, code_verifier: verifier, client_id: client.client_id, redirect_uri: params.redirect_uri });
    assert(tk.status === 200 && tk.body.access_token && tk.body.refresh_token && tk.body.token_type === 'Bearer' && tk.body.scope === 'read', `token: ${JSON.stringify(tk.body)}`);
    const reuse = await tokenReq({ grant_type: 'authorization_code', code: back.get('code')!, code_verifier: verifier, client_id: client.client_id });
    assert(reuse.body.error === 'invalid_grant', 'a code works once');
    const mcp = new McpClient(`${B.base}/mcp`, tk.body.access_token); await mcp.init();
    const who = await mcp.tool('whoami');
    const tools: string[] = (await mcp.rpc('tools/list')).tools.map((x: any) => x.name);
    assert(who.address === B.address && who.agent === 'E2E Client' && who.scopes.join() === 'read' && tools.includes('pull') && !tools.includes('send_message'), `whoami over OAuth: ${JSON.stringify(who)}`);
    assert((await bearer(B.base, tk.body.access_token, '/api/tokens')).status === 403, 'an OAuth token is not an owner session');
    const fresh = await tokenReq({ grant_type: 'refresh_token', refresh_token: tk.body.refresh_token, client_id: client.client_id });
    assert(fresh.status === 200 && fresh.body.access_token !== tk.body.access_token, 'refresh');
    assert((await tokenReq({ grant_type: 'refresh_token', refresh_token: tk.body.refresh_token })).body.error === 'invalid_grant', 'a refresh token works once');
    assert((await bearer(B.base, fresh.body.access_token, '/api/me')).status === 200 && (await bearer(B.base, tk.body.access_token, '/api/me')).status === 401, 'the new access token works, the old one does not');
    const grant = (await B.api('/api/tokens')).tokens.find((x: any) => x.kind === 'oauth' && x.label === 'E2E Client');
    assert(grant && grant.scopes.join() === 'read', 'the grant is listed with the owner\'s other agents');
    await B.api(`/api/tokens/${grant.id}`, { method: 'DELETE' });
    assert((await bearer(B.base, fresh.body.access_token, '/api/me')).status === 401, 'revoking the grant must end access');
    assert((await tokenReq({ grant_type: 'refresh_token', refresh_token: fresh.body.refresh_token })).body.error === 'invalid_grant', 'and refreshing');
    // A client identified by the URL of its metadata document (needs the test routes, so only on that instance).
    const S = [A, B, C].find(x => x.base === c.sinkBase)!;
    const idUrl = `${c.sinkBase}/__test/oauth-client`;
    const byUrl = await S.api(`/api/oauth/client?${new URLSearchParams({ ...params, client_id: idUrl })}`);
    assert(byUrl.name === 'Metadata Test Client' && byUrl.clientId === idUrl, 'client id metadata document');
    return 'metadata, registration, consent, PKCE, single-use code, rotating refresh, revoke, client id by URL';
  });

  await t('T20', 'Doorbell: extra headers (what a two-header webhook needs)', async () => {
    const S = [A, B, C].find(x => x.base === c.sinkBase)!; // the sink is on this instance; ring from one of its own users
    const secret = 'doorbell-two-' + b64(randomBytes(9));
    await fetch(`${c.sinkBase}/__test/sink`, { method: 'DELETE' });
    const saved = await S.api('/api/settings', { method: 'PUT', body: {
      doorbellUrl: `${c.sinkBase}/__test/sink?header=authorization,anthropic-version,x-extra`,
      doorbellHeader: 'Authorization', doorbellValue: `Bearer ${secret}`, doorbellExtra: 'anthropic-version: 2023-06-01\nX-Extra: one two',
    } });
    assert(saved.user.doorbell.extra.join() === 'anthropic-version,x-extra', `extra header names: ${saved.user.doorbell.extra}`);
    const test = await S.api('/api/doorbell/test', { body: {} });
    const recs: any[] = await waitFor('sink record', async () => { const r: any[] = await (await fetch(`${c.sinkBase}/__test/sink`)).json(); return r.length ? r : null; }, 15000);
    const h = recs[0].headers;
    assert(h.authorization === b64(await sha256(`Bearer ${secret}`)) && h['anthropic-version'] === b64(await sha256('2023-06-01')) && h['x-extra'] === b64(await sha256('one two')), `headers received: ${JSON.stringify(h)}`);
    assert(recs[0].contentType === 'application/json', 'content type');
    for (const bad of ['no colon here', 'Content-Type: text/plain', 'Authorization: again', 'a: 1\nb: 2\nc: 3\nd: 4\ne: 5\nf: 6']) await S.api('/api/settings', { method: 'PUT', body: { doorbellExtra: bad }, expect: 400 });
    const cleared = await S.api('/api/settings', { method: 'PUT', body: { doorbellUrl: '', doorbellExtra: '' } });
    assert(cleared.user.doorbell.extra.length === 0, 'clearing extra headers');
    return `test ring HTTP ${test.status} with Authorization and two extra headers`;
  });

  await t('T21', 'Unattended agent: doorbell, wake, pull, decrypt, reply (own key, read+send token)', async () => {
    const S = [A, B, C].find(x => x.base === c.sinkBase)!;     // the owner whose agent we run (the sink is on its instance)
    const peer = S === A ? B : A;                              // someone S already allows
    // The owner sets the agent up: a token that can read and send, its own key, a doorbell.
    const tok = await S.api('/api/tokens', { body: { label: 'Night Shift', scopes: ['read', 'send'] } });
    assert(tok.ask.join() === 'first_contact,policy,members', `default ask: ${tok.ask}`);
    const key = newKeyFile(S.address, S.actor, '');
    key.keyId = (await S.api('/api/keys/client', { method: 'PUT', body: { publicKey: key.publicKey, label: 'Night Shift', tokenId: tok.id } })).keyId;
    const agentFile = JSON.stringify({ type: 'agent-mail-agent', v: 1, url: S.base, token: tok.token, name: 'Night Shift', keys: [key] });
    await fetch(`${c.sinkBase}/__test/sink`, { method: 'DELETE' });
    await S.api('/api/settings', { method: 'PUT', body: { doorbellUrl: `${c.sinkBase}/__test/sink?header=x-doorbell-key`, doorbellHeader: 'X-Doorbell-Key', doorbellValue: 'wake' } });
    await waitFor('peer sees the agent key', async () => (await peer.api('/api/resolve', { body: { to: [S.address] } })).actors[0].alsoKeys.some((k: any) => k.keyId === key.keyId && k.publicKey === key.publicKey), 40000);
    await sleep(1500);
    // Mail arrives while nobody is watching.
    const q = await encryptAndSend(peer.apiTransport(), { to: [S.address] }, { subject: 'Question', text: 'What is 6 x 7?' });
    // The doorbell is the only signal. It carries no content, so the woken agent has to ask.
    const ring: any = await waitFor('doorbell', async () => { const r: any[] = await (await fetch(`${c.sinkBase}/__test/sink`)).json(); return r.length ? JSON.parse(r[0].body) : null; }, 40000);
    assert(ring.type === 'agent-mail.doorbell' && ring.unread >= 1 && !JSON.stringify(ring).includes('6 x 7'), `ring: ${JSON.stringify(ring)}`);
    // From here on, only the agent file is used: no session, no owner key.
    const env = { AGENT_MAIL_CONFIG: agentFile };
    const quiet = () => {};
    const pulled = await cli(['pull'], env, quiet);
    const item = pulled.items.find((x: any) => x.noteId === q.noteId);
    assert(item?.decrypted?.content === 'What is 6 x 7?', `the agent could not read the question: ${JSON.stringify(item?.decrypted)}`);
    const reply = await cli(['reply', q.noteId, 'It is 42.'], env, quiet);
    assert(reply.status === 'sent', `reply: ${JSON.stringify(reply)}`);
    const acked = await cli(['ack', String(item.cursor)], env, quiet);
    assert(acked.unread === 0, `ack: ${JSON.stringify(acked)}`);
    const got = await waitFor('answer at the peer', () => inQueue(peer, reply.noteId));
    const text = await decryptActivity(peer.keys, got.activity);
    assert(text.content === 'It is 42.' && text.agent?.name === 'Night Shift' && got.agent === true && got.activity.object.inReplyTo === q.noteId, 'the answer');
    // The same agent cannot go beyond its job.
    const stranger = [A, B, C].find(x => x !== S && x !== peer)!;
    await S.api(`/api/rules?subject=${enc(stranger.actor)}`, { method: 'DELETE' });
    const cold = await cli(['send', '--to', stranger.address, 'Hello, we have not met.'], env, quiet);
    assert(cold.status === 'pending_approval' && cold.reason === 'first_contact', `cold send: ${JSON.stringify(cold)}`);
    let refused = ''; try { await cli(['approve', peer.actor], env, quiet); } catch (e) { refused = String(e); }
    assert(refused.includes('insufficient_scope'), `approve without the manage scope: ${refused}`);
    assert((await bearer(S.base, tok.token, '/api/tokens', { body: { label: 'x' } })).status === 403, 'mint a token');
    await S.api(`/api/approvals/${cold.approvalId}/deny`, { body: {} });
    await S.api('/api/settings', { method: 'PUT', body: { doorbellUrl: '' } });
    await S.api(`/api/tokens/${tok.id}`, { method: 'DELETE' });
    for (const acct of [A, B, C]) { const z = await acct.api('/api/queue?limit=100'); if (z.items.length) await acct.api('/api/queue/ack', { body: { upTo: z.items.at(-1).cursor } }); }
    return 'rang content-free; agent read with its own key, answered, acked; first contact held; no manage, no admin';
  });

  return results;
}
