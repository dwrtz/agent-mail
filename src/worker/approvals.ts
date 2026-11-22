// Owner approvals (R16). Agents act on their own; what their token says to ask about first is held here
// until the owner approves or denies it in the web app. Only a signed-in owner can decide.
import { Env, HttpError, nowIso, isoIn, Caller, requireScope, UserRow, parseJson, actorUrl } from './env';
import { checkSend, deliver, send, changeMembers, refreshDraft, SendBody } from './outbox';
import { approve, block, decide as policyFor } from './inboxq';
import { isUrl } from '../shared/activity';

const HOLD_SECONDS = 7 * 86400;
type Kind = 'send' | 'approve' | 'block' | 'members';
interface Row { id: number; user_id: number; token_id: number | null; agent: string; kind: Kind; reason: string; ref: string; subject: string; payload: string; status: string; result: string | null; created_at: string; decided_at: string | null; expires_at: string }

const held = (id: number, reason: string, extra: Record<string, unknown> = {}) => ({
  status: 'pending_approval', approvalId: id, reason, ...extra,
  detail: 'Held for the owner to approve in the web app. Do not retry: it is carried out when they approve. list_approvals shows the outcome.',
});

/** Records a held action, or returns the one already waiting for the same thing from this agent. */
async function hold(env: Env, c: Caller, kind: Kind, reason: string, ref: string, subject: unknown, payload: unknown, extra: Record<string, unknown> = {}) {
  // The same request again returns the approval already waiting; a different one about the same thing is its own approval.
  const body = JSON.stringify(payload);
  const prior = await env.DB.prepare("SELECT id, reason FROM approvals WHERE user_id = ? AND kind = ? AND ref = ? AND token_id = ? AND status = 'pending' AND payload = ?")
    .bind(c.user.id, kind, ref, c.token!.id, body).first<{ id: number; reason: string }>();
  if (prior) return held(prior.id, prior.reason, extra);
  const row = await env.DB.prepare('INSERT INTO approvals (user_id, token_id, agent, kind, reason, ref, subject, payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
    .bind(c.user.id, c.token!.id, c.token!.label, kind, reason, ref, JSON.stringify(subject), body, nowIso(), isoIn(HOLD_SECONDS)).first<{ id: number }>();
  return held(row!.id, reason, extra);
}

/** Sending. The owner sends directly; an agent's send is delivered at once unless its token (or the agent itself) says to ask. */
export async function gatedSend(env: Env, ctx: ExecutionContext, c: Caller, body: SendBody) {
  if (!c.token) return send(env, ctx, c.user, body);
  requireScope(c, 'send');
  const r = await checkSend(env, c.user, body);
  if ('sent' in r) return r.sent;
  const ck = r.checked;
  const prior = await env.DB.prepare("SELECT id, reason, status FROM approvals WHERE user_id = ? AND kind = 'send' AND ref = ? ORDER BY id DESC LIMIT 1").bind(c.user.id, ck.noteId).first<{ id: number; reason: string; status: string }>();
  if (prior?.status === 'pending' || prior?.status === 'approving') return held(prior.id, prior.reason, { noteId: ck.noteId, threadId: ck.thread });
  if (prior) return { status: prior.status, approvalId: prior.id, noteId: ck.noteId, threadId: ck.thread, detail: 'The owner did not approve this message. Prepare a new one only if they ask for it.' };
  const ask = c.token.ask;
  const strangers: string[] = [];
  for (const x of ck.recipients) if ((await policyFor(env, c.user.id, x.actor)) !== 'allow') strangers.push(x.actor);
  const reason = body.sensitive === true ? 'agent_flagged' : ask.includes('all_sends') ? 'all_sends' : ask.includes('first_contact') && strangers.length ? 'first_contact' : '';
  // Sent at once. Letting someone new in (an allow rule) is a policy change: an agent's send adds one only
  // when the token could have approved that sender by itself.
  if (!reason) return deliver(env, ctx, c.user, ck, { agent: true, allowNew: c.token.scopes.includes('manage') && !ask.includes('policy') });
  await env.DB.prepare('UPDATE drafts SET expires_at = ? WHERE note_id = ?').bind(isoIn(HOLD_SECONDS), ck.noteId).run();
  const subject = { to: ck.recipients.map(x => x.actor), newContacts: strangers, thread: ck.thread, newThread: ck.newThread, inReplyTo: ck.inReplyTo, attachments: ck.attEntries.length };
  const payload: SendBody = { noteId: body.noteId, payloads: body.payloads, selfPayload: body.selfPayload, attachments: body.attachments ?? [] };
  return hold(env, c, 'send', reason, ck.noteId, subject, payload, { noteId: ck.noteId, threadId: ck.thread });
}

async function gatedPolicy(env: Env, ctx: ExecutionContext, c: Caller, kind: 'approve' | 'block', actor: string) {
  const run = () => kind === 'approve' ? approve(env, ctx, c.user.id, actor) : block(env, c.user.id, actor);
  if (!c.token) return run();
  requireScope(c, 'manage');
  if (!isUrl(actor)) throw new HttpError(400, 'bad_request', 'actor must be an actor URL');
  if (!c.token.ask.includes('policy')) return run();
  const waiting = (await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND direction = 'in' AND state = 'request' AND actor = ?").bind(c.user.id, actor).first<{ n: number }>())?.n ?? 0;
  return hold(env, c, kind, 'policy', actor, { actor, pendingRequests: waiting }, { actor });
}
export const gatedApprove = (env: Env, ctx: ExecutionContext, c: Caller, actor: string) => gatedPolicy(env, ctx, c, 'approve', actor);
export const gatedBlock = (env: Env, ctx: ExecutionContext, c: Caller, actor: string) => gatedPolicy(env, ctx, c, 'block', actor);

export async function gatedMembers(env: Env, ctx: ExecutionContext, c: Caller, body: { uri: string; add?: string[]; remove?: string[] }) {
  if (!c.token) return changeMembers(env, ctx, c.user, body);
  requireScope(c, 'manage');
  if (!c.token.ask.includes('members')) return changeMembers(env, ctx, c.user, body);
  const str = (v: unknown) => Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, 50) : [];
  const b = { uri: String(body?.uri ?? ''), add: str(body?.add), remove: str(body?.remove) };
  if (!isUrl(b.uri) || (!b.add.length && !b.remove.length)) throw new HttpError(400, 'bad_request', 'give uri and add or remove');
  return hold(env, c, 'members', 'members', b.uri, { thread: b.uri, add: b.add, remove: b.remove }, b);
}

const view = (r: Row) => ({
  id: r.id, agent: r.agent, kind: r.kind, reason: r.reason, status: r.status === 'approving' ? 'pending' : r.status, subject: parseJson(r.subject, {}),
  createdAt: r.created_at, decidedAt: r.decided_at, expiresAt: r.expires_at, result: parseJson<unknown>(r.result, null),
});

/**
 * The owner sees every agent's approvals, and for a held message the sender's own ciphertext so the
 * browser can decrypt and show it. An agent sees only what it asked for, without the payload.
 */
export async function listApprovals(env: Env, c: Caller, status: string = 'recent') {
  const since = new Date(Date.now() - HOLD_SECONDS * 1000).toISOString();
  const where = status === 'pending' ? "status IN ('pending', 'approving')" : '(status IN (\'pending\', \'approving\') OR created_at > ?3)';
  const rows = (await env.DB.prepare(`SELECT * FROM approvals WHERE user_id = ?1 AND (?2 IS NULL OR token_id = ?2) AND ${where} ORDER BY id DESC LIMIT 100`)
    .bind(c.user.id, c.token?.id ?? null, ...(status === 'pending' ? [] : [since])).all<Row>()).results;
  const me = actorUrl(env, c.user.handle);
  return {
    items: rows.map(r => {
      const v: Record<string, unknown> = view(r);
      if (!c.token && r.kind === 'send' && (r.status === 'pending' || r.status === 'approving')) {
        const p = parseJson<SendBody | null>(r.payload, null);
        const s = p?.selfPayload;
        if (p && s) v.activity = { type: 'Create', actor: me, object: { id: p.noteId, type: 'Note', 'am:encrypted': { recipient: me, keyId: s.keyId, enc: s.enc, ct: s.ct }, ...(s.copies?.length ? { 'am:copies': s.copies } : {}) } };
      }
      return v;
    }),
  };
}

export async function pendingApprovals(env: Env, userId: number, tokenId: number | null = null): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE user_id = ?1 AND (?2 IS NULL OR token_id = ?2) AND status IN ('pending', 'approving')").bind(userId, tokenId).first<{ n: number }>())?.n ?? 0;
}

/** For a held message: the current keys of its recipients, so the owner's client can seal what the owner read. */
export async function prepareApproval(env: Env, ctx: ExecutionContext, user: UserRow, id: number) {
  const a = await env.DB.prepare("SELECT ref, kind, status FROM approvals WHERE id = ? AND user_id = ?").bind(id, user.id).first<{ ref: string; kind: Kind; status: string }>();
  if (!a) throw new HttpError(404, 'not_found', 'no such approval');
  if (a.kind !== 'send') throw new HttpError(400, 'bad_request', 'only a held message needs preparing');
  if (a.status !== 'pending') throw new HttpError(409, 'already_decided', `this was already ${a.status}`);
  return refreshDraft(env, ctx, user, a.ref);
}

const STALE_MS = 2 * 60_000;
/** A failed send that the owner can simply try again (their sealing did not fit the draft, or it was mid-send). */
const RETRYABLE = new Set(['bad_request', 'send_in_progress', 'too_large', 'no_encryption_key']);

/**
 * The owner's decision. Approving carries the held action out as the user.
 * A held message is never sent as the agent sealed it: the server cannot see whether the copy the owner
 * read and the copies for the recipients say the same thing. The owner's client opens the agent's copy
 * and seals that plaintext again for every key (`sealed`), and only those ciphertexts are delivered.
 */
export async function decideApproval(env: Env, ctx: ExecutionContext, user: UserRow, id: number, yes: boolean, sealed: { payloads?: unknown; selfPayload?: unknown } = {}) {
  const a = await env.DB.prepare('SELECT * FROM approvals WHERE id = ? AND user_id = ?').bind(id, user.id).first<Row>();
  if (!a) throw new HttpError(404, 'not_found', 'no such approval');
  const now = nowIso();
  if (a.status === 'pending' && a.expires_at < now) {
    await env.DB.prepare("UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'").bind(now, id).run();
    throw new HttpError(410, 'approval_expired', 'this request expired');
  }
  if (yes && a.kind === 'send' && (!Array.isArray(sealed.payloads) || !sealed.selfPayload || typeof sealed.selfPayload !== 'object')) {
    throw new HttpError(400, 'reseal_required', 'approving a message needs payloads and selfPayload sealed by the owner (POST /api/approvals/<id>/prepare gives the keys)');
  }
  // Claim it. A claim older than two minutes is one whose request died: it can be taken over (every action here is safe to repeat).
  const claim = await env.DB.prepare("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND (status = 'pending' OR (status = 'approving' AND decided_at < ?))")
    .bind(yes ? 'approving' : 'denied', now, id, new Date(Date.now() - STALE_MS).toISOString()).run();
  if (!claim.meta.changes) throw new HttpError(409, 'already_decided', `this was already ${a.status === 'approving' ? 'approved and is being carried out' : a.status}`);
  const finish = async (status: string, result: unknown) => {
    await env.DB.prepare('UPDATE approvals SET status = ?, result = ?, decided_at = ? WHERE id = ?').bind(status, result === null ? null : JSON.stringify(result), nowIso(), id).run();
    return { id, status, result };
  };
  if (!yes) return finish('denied', null);
  const p = parseJson<any>(a.payload, {});
  try {
    const result = a.kind === 'send' ? await send(env, ctx, user, { noteId: p.noteId, payloads: sealed.payloads as SendBody['payloads'], selfPayload: sealed.selfPayload as SendBody['selfPayload'], attachments: p.attachments ?? [] }, { agent: true, allowNew: true })
      : a.kind === 'approve' ? await approve(env, ctx, user.id, p.actor)
      : a.kind === 'block' ? await block(env, user.id, p.actor)
      : await changeMembers(env, ctx, user, p);
    return finish('approved', result);
  } catch (e) {
    if (e instanceof HttpError && a.kind === 'send' && RETRYABLE.has(e.code)) {
      await env.DB.prepare("UPDATE approvals SET status = 'pending', decided_at = NULL WHERE id = ? AND status = 'approving'").bind(id).run();
      throw e;
    }
    if (!(e instanceof HttpError)) { await finish('failed', { error: 'internal', detail: 'internal error' }); throw e; }
    return finish('failed', { error: e.code, detail: e.message });
  }
}

/** An agent withdraws something it asked for. */
export async function cancelApproval(env: Env, c: Caller, id: number) {
  const r = await env.DB.prepare("UPDATE approvals SET status = 'cancelled', decided_at = ? WHERE id = ? AND user_id = ? AND (?4 IS NULL OR token_id = ?4) AND status = 'pending'")
    .bind(nowIso(), id, c.user.id, c.token?.id ?? null).run();
  if (!r.meta.changes) throw new HttpError(404, 'not_found', 'no pending approval with that id');
  return { id, status: 'cancelled' };
}
