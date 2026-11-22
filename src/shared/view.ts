// A message as an agent wants to see it: decrypted, with who sent it and whether an agent wrote it.
// Used by the CLI and its local MCP server, and by the instance's plain-text tools for a server-held key (R20).
import { decryptActivity, KeyFile } from './client';

export interface MessageView {
  cursor?: number; kind: 'message' | 'membership'; direction: 'in' | 'out';
  noteId: string | null; thread: string; from: string; fromActor: string; fromAgent: boolean; agentName?: string;
  inReplyTo?: string | null; sentAt: string; subject?: string | null; text?: string | null;
  attachments?: { index: number; name: string; mediaType: string; size: number }[];
  event?: string; gapBefore?: number; error?: string;
}
export interface Counts { unread: number; requests: number; latestCursor: number; pendingApprovals: number }

/** `https://host/users/name` as `name@host`. */
export const shortActor = (actor: string) => { try { const u = new URL(actor); return `${u.pathname.split('/').pop()}@${u.host}`; } catch { return actor; } };

/** Turns a stored activity into a MessageView, opening it with whichever of `keys` fits. */
export async function viewActivity(keys: KeyFile[], activity: any, extra: Partial<MessageView> = {}): Promise<MessageView> {
  const base = { direction: 'in' as const, fromActor: activity.actor, from: shortActor(activity.actor), sentAt: activity.published, ...extra };
  if (activity.type !== 'Create') {
    const who = shortActor(activity.actor), whom = shortActor(activity.object);
    const event = activity.object === activity.actor ? `${who} left the thread` : `${who} ${activity.type === 'Add' ? 'added' : 'removed'} ${whom}`;
    return { ...base, kind: 'membership', noteId: null, thread: activity.target, fromAgent: false, event };
  }
  const n = activity.object;
  const v: MessageView = { ...base, kind: 'message', noteId: n.id, thread: n.context, fromAgent: n['am:agent'] === true, inReplyTo: n.inReplyTo ?? null };
  try {
    const p = await decryptActivity(keys, activity);
    if (p.agent?.name) v.agentName = String(p.agent.name);
    return { ...v, subject: p.summary, text: p.content, attachments: p.attachments.map((a, index) => ({ index, name: a.name, mediaType: a.mediaType, size: a.size })) };
  } catch (e) { return { ...v, error: `cannot decrypt: ${(e as Error).message}` }; }
}
