// Sending (R5), group membership changes (R9), read receipts (R11) and the delivery queue consumer.
import { Env, HttpError, nowIso, isoIn, actorUrl, UserRow, userById, parseJson, QueueMsg } from './env';
import { resolveAddress, encKeyFromDoc, fetchActor, getThread, signedFetch, ActorDoc, SEND_MAX_AGE_MS } from './federation';
import { ACTIVITY_CONTEXT, ENCRYPTED_PLACEHOLDER, MAX_GROUP, MAX_ATTACHMENTS, MAX_CLIENT_KEYS, MAX_INBOX_BODY, isUrl } from '../shared/activity';
import { HPKE_IDS, HPKE_INFO } from '../shared/e2ee';
import { b64url, te } from '../shared/enc';
import { encKeys, clientKeys } from './keys';

const uuid = () => crypto.randomUUID();

interface KeyRef { keyId: string; publicKey: string }
export async function resolveMany(env: Env, ctx: ExecutionContext, to: string[]) {
  if (!Array.isArray(to) || to.length === 0) throw new HttpError(400, 'bad_request', 'to must list at least one handle or actor URL');
  const out = [];
  for (const t of to) {
    if (typeof t !== 'string') throw new HttpError(400, 'bad_request', 'to entries must be strings');
    const doc = await resolveAddress(env, ctx, t, SEND_MAX_AGE_MS);
    const k = encKeyFromDoc(doc);
    out.push({
      actor: doc.id, handle: `${doc.preferredUsername ?? ''}@${new URL(doc.id).host}`, name: doc.name ?? doc.preferredUsername ?? '', inbox: doc.inbox,
      keyId: k?.keyId ?? null, publicKey: k ? b64url(k.publicKey) : null,
      alsoKeys: (k?.also ?? []).map(a => ({ keyId: a.keyId, publicKey: b64url(a.publicKey) })) as KeyRef[],
    });
  }
  return out;
}

/** The user's own key for the sender's copy, plus their agents' client keys. */
async function myEncKey(env: Env, u: UserRow) {
  const ks = await encKeys(env, u.id);
  if (!ks.length) throw new HttpError(422, 'no_encryption_key', 'set up your encryption key first');
  const actor = actorUrl(env, u.handle);
  const k = ks[ks.length - 1];
  const alsoKeys: KeyRef[] = (await clientKeys(env, u.id)).slice(0, MAX_CLIENT_KEYS).map(c => ({ keyId: `${actor}#enc-${c.n}`, publicKey: c.public_key }));
  return { actor, keyId: `${actor}#enc-${k.n}`, publicKey: k.public_key, alsoKeys };
}

/** Takes this user's next am:seq in a thread. Numbers are handed out when an activity is actually sent, so a held or abandoned draft leaves no gap. */
async function takeSeq(env: Env, u: UserRow, thread: string): Promise<number> {
  const r = await env.DB.prepare('INSERT INTO seqs (user_id, thread, actor, last) VALUES (?, ?, ?, 1) ON CONFLICT(user_id, thread, actor) DO UPDATE SET last = last + 1 RETURNING last')
    .bind(u.id, thread, actorUrl(env, u.handle)).first<{ last: number }>();
  return r!.last;
}

export async function prepare(env: Env, ctx: ExecutionContext, u: UserRow, body: { to?: string[]; replyTo?: string; threadId?: string }) {
  const me = actorUrl(env, u.handle);
  const self = await myEncKey(env, u);
  let thread: string; let members: string[]; let inReplyTo: string | null = null; let newThread = false;
  let recipientDocs: Awaited<ReturnType<typeof resolveMany>>;
  if (body?.replyTo || body?.threadId) {
    if (body.replyTo) {
      const m = await env.DB.prepare('SELECT thread FROM messages WHERE user_id = ? AND note_id = ?').bind(u.id, body.replyTo).first<{ thread: string }>();
      if (!m) throw new HttpError(404, 'not_found', 'no such message');
      thread = m.thread; inReplyTo = body.replyTo;
    } else thread = body.threadId!;
    const t = await getThread(env, u.id, thread);
    if (!t) throw new HttpError(404, 'not_found', 'no such thread');
    if (!t.list.includes(me)) throw new HttpError(403, 'not_member', 'you are no longer a member of this thread');
    members = t.list;
    recipientDocs = await resolveMany(env, ctx, members.filter(x => x !== me));
  } else {
    recipientDocs = await resolveMany(env, ctx, body?.to ?? []);
    thread = `${me}/threads/${uuid()}`; newThread = true;
    members = [me, ...new Set(recipientDocs.map(r => r.actor).filter(a => a !== me))];
  }
  recipientDocs = recipientDocs.filter((r, i, a) => r.actor !== me && a.findIndex(x => x.actor === r.actor) === i);
  if (members.length > MAX_GROUP) throw new HttpError(422, 'group_too_large', `a thread has at most ${MAX_GROUP} members`);
  if (!recipientDocs.length) throw new HttpError(422, 'unknown_recipient', 'no recipients besides you');
  const missing = recipientDocs.filter(r => !r.keyId);
  if (missing.length) throw new HttpError(422, 'no_encryption_key', `${missing.map(m => m.handle).join(', ')} has not set up encryption yet`);
  const noteId = `${me}/notes/${uuid()}`;
  const activityId = `${me}/activities/${uuid()}`;
  const last = (await env.DB.prepare('SELECT last FROM seqs WHERE user_id = ? AND thread = ? AND actor = ?').bind(u.id, thread, me).first<{ last: number }>())?.last ?? 0;
  const seq = last + 1; // provisional: the real number is taken when the message is sent
  const recipients = recipientDocs.map(r => ({ actor: r.actor, handle: r.handle, inbox: r.inbox, keyId: r.keyId!, publicKey: r.publicKey!, alsoKeys: r.alsoKeys }));
  const stored = recipients.map(r => ({ actor: r.actor, inbox: r.inbox, keyId: r.keyId, also: r.alsoKeys.map(k => k.keyId) }));
  await env.DB.prepare('INSERT INTO drafts (note_id, user_id, thread, in_reply_to, recipients, members, seq, new_thread, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(noteId, u.id, thread, inReplyTo, JSON.stringify({ activityId, recipients: stored }), JSON.stringify(members), seq, newThread ? 1 : 0, isoIn(3600)).run();
  return {
    noteId, activityId, threadId: thread, inReplyTo, seq, members,
    recipients: recipients.map(r => ({ actor: r.actor, handle: r.handle, keyId: r.keyId, publicKey: r.publicKey, alsoKeys: r.alsoKeys })),
    self, info: HPKE_INFO, aadFormat: '<noteId>\\n<recipient actor>', suite: HPKE_IDS,
  };
}

interface Copy { keyId: string; enc: string; ct: string }
interface Payload { recipient?: string; keyId: string; enc: string; ct: string; copies?: Copy[] }
export interface SendBody { noteId: string; payloads: Payload[]; selfPayload: Payload; attachments?: { url: string; size: number; digest: string }[]; sensitive?: boolean }
interface DraftRecipient { actor: string; inbox: string; keyId: string; also?: string[] }
/** A send that passed every check and is ready to deliver. */
export interface Checked {
  noteId: string; thread: string; inReplyTo: string | null; newThread: boolean; membersJson: string; activityId: string;
  recipients: DraftRecipient[]; byRecipient: Map<string, Payload>; selfPayload: Payload;
  attEntries: { id: string; ref: Record<string, unknown> }[];
}

const okBlock = (p: any) => p && typeof p.enc === 'string' && /^[A-Za-z0-9_-]{43}$/.test(p.enc) && typeof p.ct === 'string' && /^[A-Za-z0-9_-]{22,200000}$/.test(p.ct);
/** Copies must be sealed to keys the target actually lists; any subset (or none) is accepted. */
function okCopies(p: Payload, allowed: string[]): boolean {
  if (p.copies === undefined) return true;
  if (!Array.isArray(p.copies) || p.copies.length > MAX_CLIENT_KEYS) return false;
  const seen = new Set<string>();
  for (const c of p.copies) { if (!okBlock(c) || !allowed.includes(c.keyId) || seen.has(c.keyId)) return false; seen.add(c.keyId); }
  return true;
}

function noteActivity(me: string, c: Checked, p: Payload, recipient: string, o: { seq: number; published: string; agent: boolean }) {
  const to = (JSON.parse(c.membersJson) as string[]).filter(m => m !== me);
  return {
    '@context': ACTIVITY_CONTEXT, id: c.activityId, type: 'Create', actor: me, published: o.published, to,
    object: {
      id: c.noteId, type: 'Note', attributedTo: me, to, published: o.published, context: c.thread, inReplyTo: c.inReplyTo,
      content: ENCRYPTED_PLACEHOLDER, 'am:seq': o.seq,
      'am:encrypted': { kem: HPKE_IDS.kem, kdf: HPKE_IDS.kdf, aead: HPKE_IDS.aead, recipient, keyId: p.keyId, enc: p.enc, ct: p.ct },
      ...(p.copies?.length ? { 'am:copies': p.copies.map(x => ({ keyId: x.keyId, enc: x.enc, ct: x.ct })) } : {}),
      ...(o.agent ? { 'am:agent': true } : {}),
      ...(c.attEntries.length ? { attachment: c.attEntries.map(a => a.ref) } : {}),
    },
  };
}

/**
 * Checks a send against its draft. Returns the earlier answer when this draft was already sent
 * (so a retry after a lost response does not send twice), else everything needed to deliver it.
 */
export async function checkSend(env: Env, u: UserRow, body: SendBody): Promise<{ sent: any } | { checked: Checked }> {
  const me = actorUrl(env, u.handle);
  const d = await env.DB.prepare('SELECT * FROM drafts WHERE note_id = ? AND user_id = ?').bind(body?.noteId ?? '', u.id).first<any>();
  if (!d) throw new HttpError(404, 'not_found', 'no such draft; call prepare first');
  if (d.sent_result === 'sending') throw new HttpError(409, 'send_in_progress', 'this message is being sent; ask again in a moment');
  if (d.sent_result) return { sent: { ...parseJson<any>(d.sent_result, {}), duplicate: true } };
  if (d.expires_at < nowIso()) throw new HttpError(410, 'draft_expired', 'the draft expired; prepare again');
  const { activityId, recipients } = JSON.parse(d.recipients) as { activityId: string; recipients: DraftRecipient[] };
  if (!Array.isArray(body.payloads) || body.payloads.length !== recipients.length) throw new HttpError(400, 'bad_request', 'one payload per recipient is required');
  const byRecipient = new Map<string, Payload>();
  for (const p of body.payloads) {
    const r = recipients.find(x => x.actor === p?.recipient);
    if (!r || !okBlock(p) || p.keyId !== r.keyId || !okCopies(p, r.also ?? [])) throw new HttpError(400, 'bad_request', `bad payload for ${p?.recipient}`);
    byRecipient.set(r.actor, p);
  }
  const self = await myEncKey(env, u);
  if (!okBlock(body.selfPayload) || body.selfPayload.keyId !== self.keyId) throw new HttpError(400, 'bad_request', 'selfPayload must be encrypted to your latest key');
  if (!okCopies(body.selfPayload, self.alsoKeys.map(k => k.keyId))) throw new HttpError(400, 'bad_request', 'selfPayload copies must be sealed to your own client keys');
  const atts = body.attachments ?? [];
  if (!Array.isArray(atts) || atts.length > MAX_ATTACHMENTS) throw new HttpError(400, 'bad_request', `at most ${MAX_ATTACHMENTS} attachments`);
  const attEntries: Checked['attEntries'] = [];
  for (const a of atts) {
    const id = typeof a?.url === 'string' && a.url.startsWith(`${new URL(me).origin}/attachments/`) ? a.url.split('/').pop()! : '';
    const row = await env.DB.prepare('SELECT size, digest FROM attachments WHERE id = ? AND user_id = ?').bind(id, u.id).first<{ size: number; digest: string }>();
    if (!row || row.size !== a.size || row.digest !== a.digest) throw new HttpError(400, 'bad_request', `unknown attachment ${a?.url}`);
    attEntries.push({ id, ref: { type: 'Document', url: a.url, mediaType: 'application/octet-stream', 'am:size': row.size, 'am:digest': row.digest } });
  }
  const checked: Checked = { noteId: d.note_id, thread: d.thread, inReplyTo: d.in_reply_to ?? null, newThread: !!d.new_thread, membersJson: d.members, activityId, recipients, byRecipient, selfPayload: body.selfPayload, attEntries };
  // Every receiving inbox takes at most 256 KiB; copies for several keys can push a long message over.
  for (const r of recipients) {
    const size = te.encode(JSON.stringify(noteActivity(me, checked, byRecipient.get(r.actor)!, r.actor, { seq: 99999999, published: '2026-01-01T00:00:00Z', agent: true }))).length;
    if (size > MAX_INBOX_BODY) throw new HttpError(413, 'too_large', `the message is too large to deliver to ${r.actor} (${size} bytes with ${byRecipient.get(r.actor)!.copies?.length ?? 0} key copies); shorten it or send the text as an attachment`);
  }
  return { checked };
}

/** Delivers a checked send: stores the sender's copy and queues one signed POST per recipient. */
export async function deliver(env: Env, ctx: ExecutionContext, u: UserRow, c: Checked, o: { agent?: boolean } = {}) {
  const me = actorUrl(env, u.handle);
  // Claim the draft so that two calls racing on the same note deliver once.
  const claim = await env.DB.prepare("UPDATE drafts SET sent_result = 'sending' WHERE note_id = ? AND user_id = ? AND sent_result IS NULL").bind(c.noteId, u.id).run();
  if (!claim.meta.changes) throw new HttpError(409, 'send_in_progress', 'this message is already being sent');
  try {
    const now = nowIso();
    const published = now.replace(/\.\d{3}Z$/, 'Z');
    const seq = await takeSeq(env, u, c.thread);
    const make = (p: Payload, recipient: string) => noteActivity(me, c, p, recipient, { seq, published, agent: !!o.agent });
    if (c.newThread) {
      await env.DB.prepare('INSERT OR IGNORE INTO threads (user_id, uri, creator, members, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(u.id, c.thread, me, c.membersJson, now, now).run();
    } else await env.DB.prepare('UPDATE threads SET updated_at = ? WHERE user_id = ? AND uri = ?').bind(now, u.id, c.thread).run();
    const msg = await env.DB.prepare(`INSERT INTO messages (user_id, direction, activity_id, type, note_id, thread, actor, activity, published, state, received_at)
        VALUES (?, 'out', ?, 'Create', ?, ?, ?, ?, ?, 'sent', ?) RETURNING id`)
      .bind(u.id, c.activityId, c.noteId, c.thread, me, JSON.stringify(make(c.selfPayload, me)), published, now).first<{ id: number }>();
    const deliveries = [];
    for (const r of c.recipients) {
      for (const a of c.attEntries) await env.DB.prepare('INSERT OR IGNORE INTO attachment_grants (attachment_id, actor) VALUES (?, ?)').bind(a.id, r.actor).run();
      await env.DB.prepare('INSERT OR IGNORE INTO rules (user_id, subject, action, created_at) VALUES (?, ?, \'allow\', ?)').bind(u.id, r.actor, now).run();
      deliveries.push(await queueDelivery(env, u.id, msg!.id, r.actor, r.inbox, JSON.stringify(make(c.byRecipient.get(r.actor)!, r.actor))));
    }
    const result = { status: 'sent', noteId: c.noteId, threadId: c.thread, deliveries };
    // Keep the draft for an hour as the record a retried send is answered from.
    await env.DB.prepare('UPDATE drafts SET sent_result = ?, expires_at = ? WHERE note_id = ?').bind(JSON.stringify(result), isoIn(3600), c.noteId).run();
    return result;
  } catch (e) {
    await env.DB.prepare("UPDATE drafts SET sent_result = NULL WHERE note_id = ? AND sent_result = 'sending'").bind(c.noteId).run();
    throw e;
  }
}

/** Check and deliver in one step (the owner in the web app, or an approved held send). */
export async function send(env: Env, ctx: ExecutionContext, u: UserRow, body: SendBody, o: { agent?: boolean } = {}) {
  const r = await checkSend(env, u, body);
  return 'sent' in r ? r.sent : deliver(env, ctx, u, r.checked, o);
}

async function queueDelivery(env: Env, userId: number, messageId: number, target: string, inbox: string, body: string) {
  const row = await env.DB.prepare("INSERT INTO deliveries (user_id, message_id, target, inbox, body, status, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?) RETURNING id")
    .bind(userId, messageId, target, inbox, body, nowIso()).first<{ id: number }>();
  await env.DELIVERY.send({ kind: 'deliver', id: row!.id });
  return { target, status: 'queued' };
}

/** Add / Remove members (creator), or leave (anyone). Signed, unencrypted, fanned out. */
export async function changeMembers(env: Env, ctx: ExecutionContext, u: UserRow, body: { uri: string; add?: string[]; remove?: string[] }) {
  const me = actorUrl(env, u.handle);
  const t = await getThread(env, u.id, body?.uri ?? '');
  if (!t) throw new HttpError(404, 'not_found', 'no such thread');
  if (!t.list.includes(me)) throw new HttpError(403, 'not_member', 'you are not a member');
  let members = [...t.list];
  const changes: { type: 'Add' | 'Remove'; object: string; extra: string[] }[] = [];
  for (const a of body.add ?? []) {
    if (t.creator !== me) throw new HttpError(403, 'not_thread_owner', 'only the creator can add members');
    const doc = await resolveAddress(env, ctx, a);
    if (members.includes(doc.id)) continue;
    if (members.length + 1 > MAX_GROUP) throw new HttpError(422, 'group_too_large', `a thread has at most ${MAX_GROUP} members`);
    members = [...members, doc.id];
    changes.push({ type: 'Add', object: doc.id, extra: [] });
  }
  for (const r of body.remove ?? []) {
    const id = isUrl(r) ? r : (await resolveAddress(env, ctx, r)).id;
    if (id !== me && t.creator !== me) throw new HttpError(403, 'not_thread_owner', 'only the creator can remove others');
    if (!members.includes(id)) continue;
    members = members.filter(m => m !== id);
    changes.push({ type: 'Remove', object: id, extra: [id] });
  }
  const published = nowIso().replace(/\.\d{3}Z$/, 'Z');
  const now = nowIso();
  let running = [...t.list];
  for (const c of changes) {
    running = c.type === 'Add' ? [...running, c.object] : running.filter(m => m !== c.object);
    const to = [...new Set([...running.filter(m => m !== me), ...c.extra.filter(x => x !== me)])];
    const seq = await takeSeq(env, u, t.uri);
    const act = { '@context': ACTIVITY_CONTEXT, id: `${me}/activities/${uuid()}`, type: c.type, actor: me, object: c.object, target: t.uri, to, 'am:members': running, 'am:seq': seq, published };
    const msg = await env.DB.prepare(`INSERT INTO messages (user_id, direction, activity_id, type, note_id, thread, actor, activity, published, state, received_at)
        VALUES (?, 'out', ?, ?, NULL, ?, ?, ?, ?, 'sent', ?) RETURNING id`).bind(u.id, act.id, c.type, t.uri, me, JSON.stringify(act), published, now).first<{ id: number }>();
    for (const target of to) {
      const doc = await fetchActor(env, ctx, target);
      await queueDelivery(env, u.id, msg!.id, target, doc.inbox, JSON.stringify(act));
    }
  }
  await env.DB.prepare('UPDATE threads SET members = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(members), now, t.id).run();
  return { members };
}

export async function markRead(env: Env, ctx: ExecutionContext, u: UserRow, noteIds: string[]) {
  if (!Array.isArray(noteIds)) throw new HttpError(400, 'bad_request', 'noteIds must be an array');
  const me = actorUrl(env, u.handle);
  let marked = 0, receiptsSent = 0;
  for (const n of noteIds.slice(0, 200)) {
    const m = await env.DB.prepare("SELECT id, actor FROM messages WHERE user_id = ? AND direction = 'in' AND note_id = ? AND type = 'Create' AND read_at IS NULL").bind(u.id, n).first<{ id: number; actor: string }>();
    if (!m) continue;
    await env.DB.prepare('UPDATE messages SET read_at = ? WHERE id = ?').bind(nowIso(), m.id).run();
    marked++;
    if (u.read_receipts) {
      const doc = await fetchActor(env, ctx, m.actor).catch(() => null as ActorDoc | null);
      if (!doc) continue;
      const act = { '@context': ACTIVITY_CONTEXT, id: `${me}/activities/${uuid()}`, type: 'Read', actor: me, object: n, to: [m.actor], published: nowIso().replace(/\.\d{3}Z$/, 'Z') };
      await queueDelivery(env, u.id, m.id, m.actor, doc.inbox, JSON.stringify(act));
      receiptsSent++;
    }
  }
  return { marked, receiptsSent };
}

const RETRYABLE = (s: number) => s >= 500 || s === 408 || s === 429;

export async function consume(batch: MessageBatch<QueueMsg>, env: Env, ctx: ExecutionContext) {
  for (const m of batch.messages) {
    const body = m.body;
    try {
      if (body.kind === 'doorbell') {
        const { doorbell } = await import('./inboxq');
        await doorbell(env, ctx, body.userId, true);
        m.ack(); continue;
      }
      const d = await env.DB.prepare('SELECT * FROM deliveries WHERE id = ?').bind(body.id).first<any>();
      if (!d || d.status !== 'queued') { m.ack(); continue; }
      const u = await userById(env, d.user_id);
      if (!u) { m.ack(); continue; }
      const attempts = d.attempts + 1;
      let status = 0, err = '';
      try {
        const res = await signedFetch(env, ctx, u, 'POST', d.inbox, d.body);
        status = res.status;
        if (status >= 300) err = `${status} ${(await res.text()).slice(0, 300)}`;
      } catch (e) { err = String(e).slice(0, 300); }
      if (status >= 200 && status < 300) {
        await env.DB.prepare("UPDATE deliveries SET status = 'delivered', attempts = ?, last_error = NULL, updated_at = ? WHERE id = ?").bind(attempts, nowIso(), d.id).run();
        m.ack();
      } else if ((status === 0 || RETRYABLE(status)) && attempts < 8) {
        await env.DB.prepare('UPDATE deliveries SET attempts = ?, last_error = ?, updated_at = ? WHERE id = ?').bind(attempts, err, nowIso(), d.id).run();
        m.retry({ delaySeconds: Math.min(30 * 2 ** (attempts - 1), 3600) });
      } else {
        await env.DB.prepare("UPDATE deliveries SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?").bind(attempts, err, nowIso(), d.id).run();
        console.log(`[deliver] ${d.id} failed: ${err.slice(0, 120)}`);
        m.ack();
      }
    } catch (e) {
      console.log('[queue] error', String(e).slice(0, 200));
      m.retry({ delaySeconds: 60 });
    }
  }
}
