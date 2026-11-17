// agent-mail 0.1 wire format: WebFinger JRD, actor documents and activities (plain JSON in ActivityStreams 2.0 compact form).
import { HPKE_IDS } from './e2ee';

export const AS = 'https://www.w3.org/ns/activitystreams';
export const AM_NS = 'https://spekkr.com/dwrtz/agent-mail/ns#';
export const PROTOCOL = 'agent-mail/0.1';
export const ACTIVITY_CONTEXT = [AS, { am: AM_NS }];
export const ACTOR_CONTEXT = [
  AS,
  'https://w3id.org/security/multikey/v1',
  { am: AM_NS, keyAgreement: { '@id': 'https://w3id.org/security#keyAgreementMethod', '@type': '@id' } },
];
export const MAX_GROUP = 50;          // members including the creator
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_INBOX_BODY = 256 * 1024;
export const ENCRYPTED_PLACEHOLDER = 'This message is end-to-end encrypted.';
export const HANDLE_RE = /^[a-z0-9_]{1,32}$/;

export function webfingerJrd(handle: string, host: string, actorId: string) {
  return {
    subject: `acct:${handle}@${host}`,
    aliases: [actorId],
    links: [{ rel: 'self', type: 'application/activity+json', href: actorId }],
  };
}

export interface KeyEntry { id: string; type: 'Multikey'; controller: string; publicKeyMultibase: string }

export function actorDocument(o: { origin: string; handle: string; name: string; sigKeys: KeyEntry[]; encKeys: KeyEntry[]; readReceipts: boolean }) {
  const id = `${o.origin}/users/${o.handle}`;
  return {
    '@context': ACTOR_CONTEXT,
    id,
    type: 'Person',
    preferredUsername: o.handle,
    name: o.name,
    inbox: `${id}/inbox`,
    outbox: `${id}/outbox`,
    assertionMethod: o.sigKeys,
    keyAgreement: o.encKeys,
    'am:protocol': PROTOCOL,
    'am:readReceipts': o.readReceipts,
  };
}

export interface EncryptedBlock { kem: number; kdf: number; aead: number; recipient: string; keyId: string; enc: string; ct: string }
export interface AttachmentRef { type: 'Document'; url: string; mediaType: string; 'am:size': number; 'am:digest': string }

export class ProtoError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

let allowLocalHttp = false;
/** Tests only (var ALLOW_HTTP_LOCALHOST="1"): also accept http://localhost and http://127.0.0.1 URLs. */
export function setAllowLocalHttp(on: boolean) { allowLocalHttp = on; }
export const isUrl = (v: unknown): v is string => {
  if (typeof v !== 'string' || v.length > 2048) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || (allowLocalHttp && u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'));
  } catch { return false; }
};
const sameOrigin = (a: string, b: string) => new URL(a).origin === new URL(b).origin;
const bad = (m: string) => new ProtoError(400, 'bad_activity', m);
const isB64u = (v: unknown, min = 1, max = 400_000) => typeof v === 'string' && v.length >= min && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v);
const isSeq = (v: unknown) => Number.isInteger(v) && (v as number) >= 1;
const isIso = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

export type Inbound =
  | { type: 'Create'; raw: any; id: string; actor: string; to: string[]; note: any }
  | { type: 'Add' | 'Remove'; raw: any; id: string; actor: string; to: string[]; object: string; target: string; members: string[]; seq: number }
  | { type: 'Read'; raw: any; id: string; actor: string; to: string[]; object: string };

/** Validates the shape of an inbound activity. Throws ProtoError (400 bad_activity / 422 ...). */
export function validateActivity(a: any): Inbound {
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw bad('body must be a JSON object');
  if (!['Create', 'Add', 'Remove', 'Read'].includes(a.type)) throw new ProtoError(422, 'unsupported_activity', `type ${String(a.type)} is not supported`);
  if (!isUrl(a.actor)) throw bad('actor must be an https URL');
  if (!isUrl(a.id) || !sameOrigin(a.id, a.actor)) throw bad('id must be an https URL on the actor\'s origin');
  if (!Array.isArray(a.to) || a.to.length < 1 || !a.to.every(isUrl)) throw bad('to must be a non-empty array of actor URLs');
  if (new Set(a.to).size + 1 > MAX_GROUP) throw new ProtoError(422, 'group_too_large', `at most ${MAX_GROUP} members`);
  if (!isIso(a.published)) throw bad('published must be an ISO 8601 time');
  if (a.type === 'Create') {
    const n = a.object;
    if (!n || n.type !== 'Note') throw new ProtoError(422, 'unsupported_activity', 'Create must carry a Note');
    if (!isUrl(n.id) || !sameOrigin(n.id, a.actor)) throw bad('object.id must be an https URL on the actor\'s origin');
    if (n.attributedTo !== a.actor) throw bad('object.attributedTo must equal actor');
    if (!isUrl(n.context)) throw bad('object.context (thread id) must be an https URL');
    if (n.inReplyTo != null && !isUrl(n.inReplyTo)) throw bad('object.inReplyTo must be an https URL');
    if (!isSeq(n['am:seq'])) throw bad('object.am:seq must be an integer >= 1');
    const e = n['am:encrypted'];
    if (!e || typeof e !== 'object') throw bad('object.am:encrypted is required');
    if (e.kem !== HPKE_IDS.kem || e.kdf !== HPKE_IDS.kdf || e.aead !== HPKE_IDS.aead) throw new ProtoError(422, 'unsupported_encryption', 'HPKE suite must be kem 32, kdf 1, aead 1');
    if (!isUrl(e.recipient) || !isUrl(e.keyId)) throw bad('am:encrypted.recipient and keyId must be URLs');
    if (!isB64u(e.enc, 43, 43)) throw bad('am:encrypted.enc must be 32 bytes base64url');
    if (!isB64u(e.ct, 22, 200_000)) throw bad('am:encrypted.ct must be base64url');
    const att = n.attachment ?? [];
    if (!Array.isArray(att) || att.length > MAX_ATTACHMENTS) throw bad(`attachment must be an array of at most ${MAX_ATTACHMENTS}`);
    for (const x of att) {
      if (x?.type !== 'Document' || !isUrl(x.url) || !sameOrigin(x.url, a.actor)) throw bad('attachment entries must be Documents on the actor\'s origin');
      if (typeof x.mediaType !== 'string' || !Number.isInteger(x['am:size']) || x['am:size'] < 1 || x['am:size'] > MAX_ATTACHMENT_BYTES) throw bad('attachment mediaType and am:size are required');
      if (typeof x['am:digest'] !== 'string' || !/^sha-256=:[A-Za-z0-9+/]{43}=:$/.test(x['am:digest'])) throw bad('attachment am:digest must be sha-256=:...:');
    }
    return { type: 'Create', raw: a, id: a.id, actor: a.actor, to: a.to, note: n };
  }
  if (a.type === 'Read') {
    if (!isUrl(a.object)) throw bad('Read object must be a Note id');
    return { type: 'Read', raw: a, id: a.id, actor: a.actor, to: a.to, object: a.object };
  }
  if (!isUrl(a.object)) throw bad(`${a.type} object must be an actor URL`);
  if (!isUrl(a.target)) throw bad(`${a.type} target must be a thread id`);
  if (!Array.isArray(a['am:members']) || !a['am:members'].every(isUrl)) throw bad('am:members must list the members after the change');
  if (new Set(a['am:members']).size > MAX_GROUP) throw new ProtoError(422, 'group_too_large', `at most ${MAX_GROUP} members`);
  if (!isSeq(a['am:seq'])) throw bad('am:seq must be an integer >= 1');
  return { type: a.type, raw: a, id: a.id, actor: a.actor, to: a.to, object: a.object, target: a.target, members: a['am:members'], seq: a['am:seq'] };
}

/** The actor that minted a thread id: everything before "/threads/". */
export function threadCreator(threadId: string): string | null {
  const i = threadId.indexOf('/threads/');
  return i > 0 ? threadId.slice(0, i) : null;
}
