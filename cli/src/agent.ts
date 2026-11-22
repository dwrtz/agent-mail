// What an agent does with an inbox, with the crypto done here: the instance only ever sees ciphertext.
// Used by the CLI commands and by the local MCP server (`agent-mail mcp`).
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { McpClient } from './mcp-client';
import { checkKeyFile, encryptAndSend, decryptActivity, decryptAttachment, Transport, KeyFile, OutFile } from '../../src/shared/client';
import { unb64 } from '../../src/shared/enc';

export interface Config { url: string; token: string; name?: string; keys: KeyFile[] }

/**
 * Reads the agent's settings from the environment:
 *   AGENT_MAIL_CONFIG   an agent file (from Settings, "Add an agent"): a path, or the JSON itself
 * or
 *   AGENT_MAIL_URL, AGENT_MAIL_TOKEN, and AGENT_MAIL_KEY (key file path(s), comma-separated, or the JSON itself)
 * AGENT_MAIL_NAME overrides the name put on messages this agent writes.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const inline = (v: string) => /^\s*[[{]/.test(v);
  const json = (v: string, what: string) => { try { return JSON.parse(inline(v) ? v : readFileSync(v.trim(), 'utf8')); } catch (e) { throw new Error(`${what}: ${(e as Error).message}`); } };
  let cfg: Config;
  if (env.AGENT_MAIL_CONFIG) {
    const f = json(env.AGENT_MAIL_CONFIG, 'AGENT_MAIL_CONFIG');
    if (f?.type !== 'agent-mail-agent' || typeof f.url !== 'string' || typeof f.token !== 'string' || !Array.isArray(f.keys)) throw new Error('AGENT_MAIL_CONFIG is not an agent file');
    cfg = { url: f.url, token: f.token, name: f.name, keys: f.keys.map(checkKeyFile) };
  } else {
    if (!env.AGENT_MAIL_URL || !env.AGENT_MAIL_TOKEN) throw new Error('set AGENT_MAIL_CONFIG (an agent file), or AGENT_MAIL_URL and AGENT_MAIL_TOKEN');
    const k = env.AGENT_MAIL_KEY ?? '';
    const keys = !k.trim() ? [] : inline(k) ? [json(k, 'AGENT_MAIL_KEY')].flat() : k.split(',').filter(s => s.trim()).map(p => json(p, `AGENT_MAIL_KEY ${p.trim()}`));
    cfg = { url: env.AGENT_MAIL_URL, token: env.AGENT_MAIL_TOKEN, keys: keys.map(checkKeyFile) };
  }
  cfg.url = cfg.url.replace(/\/+$/, '');
  if (env.AGENT_MAIL_NAME) cfg.name = env.AGENT_MAIL_NAME;
  return cfg;
}

const short = (actor: string) => { try { const u = new URL(actor); return `${u.pathname.split('/').pop()}@${u.host}`; } catch { return actor; } };

/** A message as an agent wants to see it: decrypted, with who sent it and whether an agent wrote it. */
export interface MessageView {
  cursor?: number; kind: 'message' | 'membership'; direction: 'in' | 'out';
  noteId: string | null; thread: string; from: string; fromActor: string; fromAgent: boolean; agentName?: string;
  inReplyTo?: string | null; sentAt: string; subject?: string | null; text?: string | null;
  attachments?: { index: number; name: string; mediaType: string; size: number }[];
  event?: string; gapBefore?: number; error?: string;
}
export interface Counts { unread: number; requests: number; latestCursor: number; pendingApprovals: number }

export class Agent {
  mcp: McpClient;
  private closeStream: (() => void) | null = null;
  private wake: (() => void) | null = null;
  constructor(public cfg: Config) { this.mcp = new McpClient(`${cfg.url}/mcp`, cfg.token); }
  async connect() { await this.mcp.init(); return this; }
  close() { this.closeStream?.(); this.closeStream = null; }

  transport(): Transport {
    return {
      prepare: a => this.mcp.tool('prepare_message', a),
      upload: async bytes => {
        const res = await fetch(`${this.cfg.url}/api/attachments`, { method: 'POST', headers: { authorization: `Bearer ${this.cfg.token}`, 'content-type': 'application/octet-stream' }, body: bytes as BodyInit });
        if (!res.ok) throw new Error(`upload: ${res.status} ${await res.text()}`);
        return res.json() as any;
      },
      send: b => this.mcp.tool('send_message', b),
    };
  }
  files(paths: string[]): OutFile[] {
    return paths.map(p => ({ name: basename(p), mediaType: 'application/octet-stream', bytes: new Uint8Array(readFileSync(p)) }));
  }
  /** Encrypts to every recipient key (and their agents' keys) and sends. The answer is `sent` or `pending_approval`. */
  send(target: { to?: string[]; replyTo?: string; threadId?: string }, msg: { subject?: string | null; text: string; attach?: string[]; sensitive?: boolean }) {
    return encryptAndSend(this.transport(), target, { subject: msg.subject, text: msg.text, files: this.files(msg.attach ?? []), sensitive: msg.sensitive, agentName: this.cfg.name });
  }

  async decrypt(activity: any) { try { return await decryptActivity(this.cfg.keys, activity); } catch (e) { return { error: (e as Error).message }; } }

  /** Turns a stored activity into a MessageView. */
  async view(activity: any, extra: Partial<MessageView> = {}): Promise<MessageView> {
    const base = { direction: 'in' as const, fromActor: activity.actor, from: short(activity.actor), sentAt: activity.published, ...extra };
    if (activity.type !== 'Create') {
      const who = short(activity.actor), whom = short(activity.object);
      const event = activity.object === activity.actor ? `${who} left the thread` : `${who} ${activity.type === 'Add' ? 'added' : 'removed'} ${whom}`;
      return { ...base, kind: 'membership', noteId: null, thread: activity.target, fromAgent: false, event };
    }
    const n = activity.object;
    const v: MessageView = { ...base, kind: 'message', noteId: n.id, thread: n.context, fromAgent: n['am:agent'] === true, inReplyTo: n.inReplyTo ?? null };
    const p: any = await this.decrypt(activity);
    if (p.error) return { ...v, error: `cannot decrypt: ${p.error}` };
    if (p.agent?.name) v.agentName = String(p.agent.name);
    return { ...v, subject: p.summary, text: p.content, attachments: p.attachments.map((a: any, index: number) => ({ index, name: a.name, mediaType: a.mediaType, size: a.size })) };
  }

  whoami() { return this.mcp.tool('whoami'); }
  counts(): Promise<Counts> { return this.mcp.resource('inbox://unread'); }
  async inbox(o: { since?: number; limit?: number } = {}) {
    const r = await this.mcp.tool('pull', { since: o.since ?? 0, limit: o.limit ?? 50 });
    const messages: MessageView[] = [];
    for (const it of r.items) messages.push(await this.view(it.activity, { cursor: it.cursor, gapBefore: it.gapBefore || undefined }));
    return { messages, nextCursor: r.nextCursor as number, more: r.more as boolean };
  }
  ack(o: { upTo?: number; ids?: number[] }) { return this.mcp.tool('ack', o); }
  async threads(limit = 50) {
    const { threads } = await this.mcp.tool('list_threads');
    const out = [];
    for (const t of threads.slice(0, limit)) out.push({ threadId: t.uri, members: t.members.map(short), creator: short(t.creator ?? ''), unread: t.unread, updatedAt: t.updatedAt, last: t.last ? await this.view(t.last.activity, { direction: t.last.direction }) : null });
    return { threads: out };
  }
  async thread(threadId: string, limit = 50) {
    const r = await this.mcp.tool('thread_messages', { threadId, limit });
    const messages: MessageView[] = [];
    for (const m of r.messages) messages.push(await this.view(m.activity, { direction: m.direction, gapBefore: m.gapBefore || undefined }));
    return { threadId, messages };
  }
  async requests() {
    const r = await this.mcp.tool('list_requests');
    const messages: MessageView[] = [];
    for (const it of r.items) messages.push(await this.view(it.activity));
    return { requests: messages };
  }
  approvals(pendingOnly = false) { return this.mcp.tool('list_approvals', { status: pendingOnly ? 'pending' : 'recent' }); }

  /** Fetches one attachment of a message, checks it against the message, decrypts it and returns the bytes. */
  async attachment(noteId: string, index = 0) {
    const m = await this.mcp.tool('get_message', { noteId });
    const p: any = await this.decrypt(m.activity);
    if (p.error) throw new Error(`cannot decrypt: ${p.error}`);
    const a = p.attachments[index];
    if (!a) throw new Error(`that message has ${p.attachments.length} attachment(s)`);
    const ref = [].concat(m.activity.object.attachment ?? []).find((r: any) => r.url === a.url) as any;
    if (!ref) throw new Error('the attachment is not listed on the message');
    return { name: a.name as string, mediaType: a.mediaType as string, bytes: await this.fetchAttachment({ url: ref.url, size: ref['am:size'], digest: ref['am:digest'] }, a) };
  }
  async fetchAttachment(ref: { url: string; size: number; digest: string }, key: { key: string; iv: string }) {
    let stored: Uint8Array;
    if (ref.size <= 5 * 1024 * 1024) stored = unb64((await this.mcp.tool('fetch_attachment', ref)).base64);
    else {
      const res = await fetch(`${this.cfg.url}/api/attachments/fetch`, { method: 'POST', headers: { authorization: `Bearer ${this.cfg.token}`, 'content-type': 'application/json' }, body: JSON.stringify(ref) });
      if (!res.ok) throw new Error(`attachment: ${res.status} ${await res.text()}`);
      stored = new Uint8Array(await res.arrayBuffer());
    }
    return decryptAttachment(stored, key);
  }
  async saveAttachment(noteId: string, index: number, path: string) {
    const a = await this.attachment(noteId, index);
    writeFileSync(path, a.bytes);
    return { saved: path, name: a.name, bytes: a.bytes.length };
  }

  // ---- waiting for mail ----
  private async ensureStream() {
    if (this.closeStream) return;
    try {
      await this.mcp.rpc('resources/subscribe', { uri: 'inbox://unread' });
      this.closeStream = await this.mcp.listen(
        m => { if (m?.method === 'notifications/resources/updated') this.wake?.(); },
        () => { this.closeStream = null; setTimeout(() => this.wake?.(), 1000); }, // the server ends the stream after a while: reopen
      );
    } catch { this.closeStream = null; }
  }
  /** Resolves when the instance says something changed, or after `ms` (the fallback poll). */
  private async signal(ms: number) {
    await this.ensureStream();
    await new Promise<void>(res => {
      const done = () => { clearTimeout(timer); this.wake = null; res(); };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }
  /**
   * Calls onMail when there is something new for this agent: mail it has not acked, a new request,
   * or an approval the owner decided. With `once`, returns after the first such moment (or at the deadline).
   */
  async watch(o: { onMail: (c: Counts) => Promise<void> | void; once?: boolean; intervalMs?: number; deadline?: number }): Promise<Counts & { timedOut?: boolean }> {
    const start = await this.counts();
    let last = { latestCursor: 0, requests: 0, pendingApprovals: start.pendingApprovals };
    try {
      for (;;) {
        const c = await this.counts();
        const news = (c.unread > 0 && c.latestCursor > last.latestCursor) || c.requests > last.requests || c.pendingApprovals < last.pendingApprovals;
        last = c;
        if (news) { await o.onMail(c); if (o.once) return c; }
        if (o.deadline && Date.now() >= o.deadline) return { ...c, timedOut: true };
        const wait = Math.min(o.intervalMs ?? 60_000, o.deadline ? Math.max(0, o.deadline - Date.now()) : Infinity);
        await this.signal(wait);
      }
    } finally { this.close(); }
  }
}
