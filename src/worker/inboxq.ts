// Policy (R7), the inbox queue (R8) and the doorbell (R13).
import { Env, HttpError, nowIso, UserRow, userById, addressOf, parseJson } from './env';
import { isUrl } from '../shared/activity';

export async function decide(env: Env, userId: number, actor: string): Promise<'allow' | 'block' | 'request'> {
  const host = new URL(actor).host;
  const rows = (await env.DB.prepare('SELECT subject, action FROM rules WHERE user_id = ? AND subject IN (?, ?)').bind(userId, actor, `domain:${host}`).all<{ subject: string; action: 'allow' | 'block' }>()).results;
  const a = rows.find(r => r.subject === actor) ?? rows.find(r => r.subject === `domain:${host}`);
  return a ? a.action : 'request';
}

export async function onQueued(env: Env, ctx: ExecutionContext, user: UserRow, messageId: number, queued: boolean) {
  if (queued) await env.DB.prepare('INSERT INTO inbox_queue (user_id, message_id, created_at) VALUES (?, ?, ?)').bind(user.id, messageId, nowIso()).run();
  ctx.waitUntil(doorbell(env, ctx, user.id, false).catch(e => console.log('[doorbell] error', String(e))));
}

// Unacked for one consumer (?1 user, ?2 consumer): past its high-water mark and not individually acked.
const UNACKED = `q.user_id = ?1 AND q.cursor > COALESCE((SELECT upto FROM consumers WHERE user_id = ?1 AND consumer = ?2), 0)
  AND NOT EXISTS (SELECT 1 FROM consumer_acks a WHERE a.user_id = ?1 AND a.consumer = ?2 AND a.cursor = q.cursor)`;

/** Queue counts as one consumer sees them ('session' or 'token:<id>'): each agent has its own position. */
export async function counts(env: Env, userId: number, consumer = 'session') {
  const r = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM inbox_queue q WHERE ${UNACKED}) AS unread,
      (SELECT COUNT(*) FROM messages WHERE user_id = ?1 AND direction = 'in' AND state = 'request') AS requests,
      (SELECT COALESCE(MAX(q.cursor), 0) FROM inbox_queue q WHERE ${UNACKED}) AS latestCursor`).bind(userId, consumer).first<{ unread: number; requests: number; latestCursor: number }>();
  return r ?? { unread: 0, requests: 0, latestCursor: 0 };
}

/** What the doorbell reports: the most any of the user's agents has waiting (the owner's own count when there are no tokens). */
async function doorbellCounts(env: Env, userId: number) {
  const r = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM api_tokens WHERE user_id = ?1) AS tokens,
      (SELECT COALESCE(MAX(n), 0) FROM (SELECT (SELECT COUNT(*) FROM inbox_queue q WHERE q.user_id = t.user_id
          AND q.cursor > COALESCE((SELECT upto FROM consumers c WHERE c.user_id = t.user_id AND c.consumer = 'token:' || t.id), 0)
          AND NOT EXISTS (SELECT 1 FROM consumer_acks a WHERE a.user_id = t.user_id AND a.consumer = 'token:' || t.id AND a.cursor = q.cursor)) AS n
        FROM api_tokens t WHERE t.user_id = ?1)) AS unread,
      (SELECT COUNT(*) FROM messages WHERE user_id = ?1 AND direction = 'in' AND state = 'request') AS requests`).bind(userId).first<{ tokens: number; unread: number; requests: number }>();
  if (!r) return { unread: 0, requests: 0 };
  return { unread: r.tokens ? r.unread : (await counts(env, userId)).unread, requests: r.requests };
}

/** Messages the owner has not opened yet (the web app's Inbox badge; separate from the agent queue). */
export async function unreadMessages(env: Env, userId: number): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND direction = 'in' AND type = 'Create' AND state = 'queued' AND read_at IS NULL").bind(userId).first<{ n: number }>();
  return r?.n ?? 0;
}

export async function pull(env: Env, userId: number, consumer: string, since = 0, limit = 50) {
  limit = Math.max(1, Math.min(100, Math.floor(limit) || 50));
  since = Math.max(0, Math.floor(since) || 0);
  const rows = (await env.DB.prepare(`SELECT q.cursor, q.created_at, m.type, m.actor, m.thread, m.note_id, m.activity, m.gap_before, m.received_at
      FROM inbox_queue q JOIN messages m ON m.id = q.message_id
      WHERE ${UNACKED} AND q.cursor > ?3 ORDER BY q.cursor LIMIT ?4`).bind(userId, consumer, since, limit + 1).all<any>()).results;
  const more = rows.length > limit;
  const items = rows.slice(0, limit).map(r => {
    const activity = JSON.parse(r.activity);
    return {
      cursor: r.cursor, kind: r.type === 'Create' ? 'message' : 'membership', sender: r.actor, thread: r.thread, noteId: r.note_id ?? null,
      agent: activity?.object?.['am:agent'] === true, receivedAt: r.received_at, gapBefore: r.gap_before, activity,
    };
  });
  return { items, nextCursor: items.length ? items[items.length - 1].cursor : since, more };
}

/** Acks for one consumer only: another agent's queue is untouched. */
export async function ack(env: Env, userId: number, consumer: string, body: { upTo?: number; ids?: number[] }) {
  if (!Number.isInteger(body?.upTo) && !Array.isArray(body?.ids)) throw new HttpError(400, 'bad_request', 'give upTo or ids');
  let acked = 0;
  if (Number.isInteger(body.upTo)) {
    const max = (await env.DB.prepare('SELECT COALESCE(MAX(cursor), 0) AS m FROM inbox_queue WHERE user_id = ?').bind(userId).first<{ m: number }>())?.m ?? 0;
    const upTo = Math.min(body.upTo!, max); // never ack items that do not exist yet
    acked += (await env.DB.prepare(`SELECT COUNT(*) AS n FROM inbox_queue q WHERE ${UNACKED} AND q.cursor <= ?3`).bind(userId, consumer, upTo).first<{ n: number }>())?.n ?? 0;
    await env.DB.batch([
      env.DB.prepare('INSERT INTO consumers (user_id, consumer, upto) VALUES (?, ?, ?) ON CONFLICT(user_id, consumer) DO UPDATE SET upto = MAX(upto, excluded.upto)').bind(userId, consumer, upTo),
      env.DB.prepare('DELETE FROM consumer_acks WHERE user_id = ? AND consumer = ? AND cursor <= ?').bind(userId, consumer, upTo),
    ]);
  }
  if (Array.isArray(body.ids) && body.ids.length) {
    for (const id of body.ids.filter(Number.isInteger).slice(0, 500)) {
      acked += (await env.DB.prepare(`INSERT OR IGNORE INTO consumer_acks (user_id, consumer, cursor) SELECT ?1, ?2, q.cursor FROM inbox_queue q WHERE ${UNACKED} AND q.cursor = ?3`).bind(userId, consumer, id).run()).meta.changes;
    }
  }
  return { acked, unread: (await counts(env, userId, consumer)).unread };
}

/** How many requests one sender can have waiting. More are accepted and dropped, as for a blocked sender. */
export const MAX_REQUESTS_PER_SENDER = 20;

/** The oldest pending requests, at most `limit` (1-100), with `more` when there are more. */
export async function listRequests(env: Env, userId: number, limit = 100) {
  limit = Math.max(1, Math.min(100, Math.floor(limit) || 100));
  const rows = (await env.DB.prepare("SELECT id, actor, thread, activity, received_at FROM messages WHERE user_id = ? AND direction = 'in' AND state = 'request' ORDER BY id LIMIT ?").bind(userId, limit + 1).all<any>()).results;
  return { items: rows.slice(0, limit).map(r => ({ id: r.id, sender: r.actor, thread: r.thread, receivedAt: r.received_at, activity: JSON.parse(r.activity) })), more: rows.length > limit };
}

export async function setRule(env: Env, userId: number, subject: string, action: 'allow' | 'block') {
  if (!(isUrl(subject) || /^domain:[a-z0-9.-]+(:\d+)?$/i.test(subject))) throw new HttpError(400, 'bad_request', 'subject must be an actor URL or domain:host');
  if (action !== 'allow' && action !== 'block') throw new HttpError(400, 'bad_request', 'action must be allow or block');
  await env.DB.prepare('INSERT INTO rules (user_id, subject, action, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, subject) DO UPDATE SET action = excluded.action')
    .bind(userId, subject.startsWith('domain:') ? subject.toLowerCase() : subject, action, nowIso()).run();
}

export async function approve(env: Env, ctx: ExecutionContext, userId: number, actor: string) {
  await setRule(env, userId, actor, 'allow');
  const rows = (await env.DB.prepare("SELECT id FROM messages WHERE user_id = ? AND direction = 'in' AND state = 'request' AND actor = ? ORDER BY id").bind(userId, actor).all<{ id: number }>()).results;
  const now = nowIso();
  for (const r of rows) {
    await env.DB.batch([
      env.DB.prepare("UPDATE messages SET state = 'queued' WHERE id = ?").bind(r.id),
      env.DB.prepare('INSERT INTO inbox_queue (user_id, message_id, created_at) VALUES (?, ?, ?)').bind(userId, r.id, now),
    ]);
  }
  if (rows.length) ctx.waitUntil(doorbell(env, ctx, userId, false).catch(() => {}));
  return { moved: rows.length };
}

export async function block(env: Env, userId: number, actor: string) {
  await setRule(env, userId, actor, 'block');
  const r = await env.DB.prepare("DELETE FROM messages WHERE user_id = ? AND direction = 'in' AND state = 'request' AND actor = ?").bind(userId, actor).run();
  return { dropped: r.meta.changes };
}

const WINDOW_MS = 30_000;

/** Rings the doorbell at most once per 30 s; an arrival inside the window schedules one ring at its end. */
export async function doorbell(env: Env, ctx: ExecutionContext, userId: number, fromQueue: boolean, test = false): Promise<number | null> {
  const u = await userById(env, userId);
  if (!u?.doorbell_url) return null;
  const now = Date.now();
  if (!test) {
    if (fromQueue) {
      await env.DB.prepare('UPDATE users SET doorbell_pending = 0 WHERE id = ?').bind(userId).run();
    } else {
      const next = u.doorbell_next_at ? Date.parse(u.doorbell_next_at) : 0;
      if (now < next) {
        if (!u.doorbell_pending) {
          const claimed = await env.DB.prepare('UPDATE users SET doorbell_pending = 1 WHERE id = ? AND doorbell_pending = 0').bind(userId).run();
          if (claimed.meta.changes) await env.DELIVERY.send({ kind: 'doorbell', userId }, { delaySeconds: Math.max(1, Math.ceil((next - now) / 1000)) });
        }
        return null;
      }
    }
    await env.DB.prepare('UPDATE users SET doorbell_next_at = ? WHERE id = ?').bind(new Date(now + WINDOW_MS).toISOString(), userId).run();
  }
  const c = await doorbellCounts(env, userId);
  const body = JSON.stringify({ type: 'agent-mail.doorbell', handle: addressOf(env, u.handle), unread: c.unread, requests: c.requests, at: new Date().toISOString() });
  const headers: Record<string, string> = { ...parseJson<Record<string, string>>(u.doorbell_extra, {}), 'content-type': 'application/json' };
  if (u.doorbell_value) headers[(u.doorbell_header || 'Authorization').toLowerCase()] = u.doorbell_value;
  try {
    const res = await fetch(u.doorbell_url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
    console.log(`[doorbell] user ${userId} -> ${res.status}`);
    return res.status;
  } catch (e) {
    console.log(`[doorbell] user ${userId} failed: ${String(e).slice(0, 200)}`);
    return 0;
  }
}
