// Client-side helpers shared by the web app and the CLI: key files, encrypt-and-send, decrypt.
import { sealNote, openNote, encryptFile, decryptFile, x25519Generate, x25519Public, NotePayload } from './e2ee';
import { b64url, unb64url } from './enc';

export interface KeyFile { type: 'agent-mail-key'; v: 1; address: string; actor: string; keyId: string; privateKey: string; publicKey: string }

export function newKeyFile(address: string, actor: string, keyId: string): KeyFile {
  const k = x25519Generate();
  return { type: 'agent-mail-key', v: 1, address, actor, keyId, privateKey: b64url(k.privateKey), publicKey: b64url(k.publicKey) };
}
export function checkKeyFile(k: any): KeyFile {
  if (k?.type !== 'agent-mail-key' || k.v !== 1 || typeof k.privateKey !== 'string' || typeof k.keyId !== 'string') throw new Error('not an agent-mail key file');
  if (b64url(x25519Public(unb64url(k.privateKey))) !== k.publicKey) throw new Error('key file is damaged: public key does not match');
  return k;
}

/** A key file, or an agent file: an instance URL, a connector token and the agent's own key(s) in one JSON. */
export interface AgentFile { type: 'agent-mail-agent'; v: 1; url: string; token: string; name?: string; keys: KeyFile[] }

interface KeyRef { keyId: string; publicKey: string }
interface Target extends KeyRef { actor: string; alsoKeys?: KeyRef[] }
export interface Prepared {
  noteId: string; threadId: string; seq: number;
  recipients: Target[];
  self: Target;
}
export interface Transport {
  prepare(a: { to?: string[]; replyTo?: string; threadId?: string }): Promise<Prepared>;
  upload(bytes: Uint8Array): Promise<{ url: string; size: number; digest: string }>;
  send(body: unknown): Promise<any>;
}
export interface OutFile { name: string; mediaType: string; bytes: Uint8Array }
export interface OutMessage {
  subject?: string | null; text: string; files?: OutFile[];
  /** The agent's name, when an agent writes the message. */
  agentName?: string;
  /** Ask the owner to approve this message before it is delivered. */
  sensitive?: boolean;
}

/** Seals the payload to a target's main key and to each of its client keys (same info and aad). */
async function sealFor(t: Target, noteId: string, payload: NotePayload) {
  const main = await sealNote(unb64url(t.publicKey), noteId, t.actor, payload);
  const copies = [];
  for (const k of t.alsoKeys ?? []) copies.push({ keyId: k.keyId, ...(await sealNote(unb64url(k.publicKey), noteId, t.actor, payload)) });
  return { recipient: t.actor, keyId: t.keyId, ...main, ...(copies.length ? { copies } : {}) };
}

export async function encryptAndSend(t: Transport, target: { to?: string[]; replyTo?: string; threadId?: string }, msg: OutMessage) {
  const p = await t.prepare(target);
  const attachments: NotePayload['attachments'] = [];
  const refs: { url: string; size: number; digest: string }[] = [];
  for (const f of msg.files ?? []) {
    const e = await encryptFile(f.bytes);
    const up = await t.upload(e.stored);
    refs.push(up);
    attachments.push({ url: up.url, name: f.name, mediaType: f.mediaType || 'application/octet-stream', size: f.bytes.length, key: e.key, iv: e.iv });
  }
  const payload: NotePayload = { v: 1, summary: msg.subject?.trim() || null, content: msg.text, attachments, ...(msg.agentName ? { agent: { name: msg.agentName.slice(0, 80) } } : {}) };
  const payloads = [];
  for (const r of p.recipients) payloads.push(await sealFor(r, p.noteId, payload));
  const selfPayload = await sealFor(p.self, p.noteId, payload);
  return t.send({ noteId: p.noteId, payloads, selfPayload, attachments: refs, ...(msg.sensitive ? { sensitive: true } : {}) });
}

/**
 * The owner approving a message an agent wrote: opens the agent's copy with the owner's key and seals
 * that same plaintext again for every recipient key. Only these ciphertexts are delivered, so what the
 * recipients get is exactly what the owner read, whatever the agent sealed for them.
 */
export async function resealHeld(keys: KeyFile[], heldActivity: any, p: Prepared) {
  const payload = await decryptActivity(keys, heldActivity);
  const payloads = [];
  for (const r of p.recipients) payloads.push(await sealFor(r, p.noteId, payload));
  return { payload, payloads, selfPayload: await sealFor(p.self, p.noteId, payload) };
}

/** Decrypts a Create activity's Note with whichever of `keys` one of its ciphertexts (am:encrypted, am:copies) was sealed to. */
export async function decryptActivity(keys: KeyFile[], activity: any): Promise<NotePayload> {
  const n = activity?.object;
  const e = n?.['am:encrypted'];
  if (!e) throw new Error('not an encrypted note');
  const blocks: { keyId: string; enc: string; ct: string }[] = [e, ...(Array.isArray(n['am:copies']) ? n['am:copies'] : [])];
  for (const b of blocks) {
    const k = keys.find(x => x.keyId === b?.keyId);
    if (k) return openNote(unb64url(k.privateKey), n.id, e.recipient, { enc: b.enc, ct: b.ct });
  }
  throw new Error(`no key for ${blocks.map(b => String(b?.keyId).split('#')[1] ?? '?').join(', ')}`);
}

export async function decryptAttachment(stored: Uint8Array, a: { key: string; iv: string }) {
  return decryptFile(stored, a.key, a.iv);
}
