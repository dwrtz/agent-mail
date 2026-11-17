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

export interface Prepared {
  noteId: string; threadId: string; seq: number;
  recipients: { actor: string; keyId: string; publicKey: string }[];
  self: { actor: string; keyId: string; publicKey: string };
}
export interface Transport {
  prepare(a: { to?: string[]; replyTo?: string; threadId?: string }): Promise<Prepared>;
  upload(bytes: Uint8Array): Promise<{ url: string; size: number; digest: string }>;
  send(body: unknown): Promise<any>;
}
export interface OutFile { name: string; mediaType: string; bytes: Uint8Array }

export async function encryptAndSend(t: Transport, target: { to?: string[]; replyTo?: string; threadId?: string }, msg: { subject?: string | null; text: string; files?: OutFile[] }) {
  const p = await t.prepare(target);
  const attachments: NotePayload['attachments'] = [];
  const refs: { url: string; size: number; digest: string }[] = [];
  for (const f of msg.files ?? []) {
    const e = await encryptFile(f.bytes);
    const up = await t.upload(e.stored);
    refs.push(up);
    attachments.push({ url: up.url, name: f.name, mediaType: f.mediaType || 'application/octet-stream', size: f.bytes.length, key: e.key, iv: e.iv });
  }
  const payload: NotePayload = { v: 1, summary: msg.subject?.trim() || null, content: msg.text, attachments };
  const payloads = [];
  for (const r of p.recipients) payloads.push({ recipient: r.actor, keyId: r.keyId, ...(await sealNote(unb64url(r.publicKey), p.noteId, r.actor, payload)) });
  const selfPayload = { recipient: p.self.actor, keyId: p.self.keyId, ...(await sealNote(unb64url(p.self.publicKey), p.noteId, p.self.actor, payload)) };
  return t.send({ noteId: p.noteId, payloads, selfPayload, attachments: refs });
}

/** Decrypts a Create activity's Note with whichever of `keys` matches its am:encrypted.keyId. */
export async function decryptActivity(keys: KeyFile[], activity: any): Promise<NotePayload> {
  const n = activity?.object;
  const e = n?.['am:encrypted'];
  if (!e) throw new Error('not an encrypted note');
  const k = keys.find(x => x.keyId === e.keyId);
  if (!k) throw new Error(`no key for ${e.keyId}`);
  return openNote(unb64url(k.privateKey), n.id, e.recipient, { enc: e.enc, ct: e.ct });
}

export async function decryptAttachment(stored: Uint8Array, a: { key: string; iv: string }) {
  return decryptFile(stored, a.key, a.iv);
}
