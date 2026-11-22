// Generates spec/test-vectors.json. Every value is deterministic.
import { writeFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { b64url, hex, multikeyEncode, sha256, te, unhex, b64 } from '../src/shared/enc';
import { contentDigest } from '../src/shared/digest';
import { signRequest, verifyRequest, SigError, POST_COMPONENTS, GET_COMPONENTS } from '../src/shared/httpsig';
import { deriveSigningKey } from '../src/shared/keys';
import { sealNote, openNote, x25519Public, encryptFile, HPKE_INFO, HPKE_IDS } from '../src/shared/e2ee';
import { webfingerJrd, actorDocument, ACTIVITY_CONTEXT, ENCRYPTED_PLACEHOLDER } from '../src/shared/activity';

const out: any = { about: 'agent-mail 0.1 test vectors, with the spec 0.2 additions under agent_keys. Byte strings are hex unless the field name ends in _b64url or the value is a header. All JSON bodies are the exact bytes sent (UTF-8, no trailing newline).' };
const seed = b64url(Uint8Array.from({ length: 32 }, (_, i) => i));
const alice = deriveSigningKey(seed, 'alice', 1);
out.signing_key_derivation = {
  SIGNING_SEED_b64url: seed, handle: 'alice', version: 1,
  hkdf: { hash: 'SHA-256', salt_utf8: 'agent-mail/0.1', info_utf8: 'sig:alice:1', length: 32 },
  ed25519_private_seed: hex(alice.privateKey), ed25519_public: hex(alice.publicKey),
  publicKeyMultibase: multikeyEncode('ed25519', alice.publicKey),
};
const bobSk = await sha256('agent-mail test vector: bob x25519');
const bobPk = x25519Public(bobSk);
out.x25519_key = { actor: 'https://b.example/users/bob', private: hex(bobSk), public: hex(bobPk), publicKeyMultibase: multikeyEncode('x25519', bobPk), keyId: 'https://b.example/users/bob#enc-1' };
const A = 'https://a.example/users/alice', B = 'https://b.example/users/bob';
out.webfinger = { request: 'GET https://a.example/.well-known/webfinger?resource=acct:alice@a.example', content_type: 'application/jrd+json', response: webfingerJrd('alice', 'a.example', A) };
const aliceEnc = x25519Public(await sha256('agent-mail test vector: alice x25519'));
out.actor = { request: 'GET https://a.example/users/alice', content_type: 'application/activity+json', response: actorDocument({ origin: 'https://a.example', handle: 'alice', name: 'Alice', readReceipts: false,
  sigKeys: [{ id: `${A}#sig-1`, type: 'Multikey', controller: A, publicKeyMultibase: multikeyEncode('ed25519', alice.publicKey) }],
  encKeys: [{ id: `${A}#enc-1`, type: 'Multikey', controller: A, publicKeyMultibase: multikeyEncode('x25519', aliceEnc) }] }) };

// HPKE
const noteId = `${A}/notes/0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0`;
const ikmE = await sha256('agent-mail test vector: ephemeral');
const att = await encryptFile(te.encode('hello attachment\n'), new Uint8Array(32).fill(0x11), new Uint8Array(12).fill(0x22));
const attUrl = 'https://a.example/attachments/6b0c2f3e9d1a4c7e8f00112233445566';
const payload = { v: 1 as const, summary: 'Lunch?', content: 'Are you free for lunch on Friday?', attachments: [{ url: attUrl, name: 'hello.txt', mediaType: 'text/plain', size: 17, key: att.key, iv: att.iv }] };
const sealed = await sealNote(bobPk, noteId, B, payload, ikmE);
const back = await openNote(bobSk, noteId, B, sealed);
if (JSON.stringify(back) !== JSON.stringify(payload)) throw new Error('hpke roundtrip');
out.hpke = {
  suite: { mode: 'base (0x00)', kem_id: HPKE_IDS.kem, kdf_id: HPKE_IDS.kdf, aead_id: HPKE_IDS.aead, names: 'DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM' },
  recipient_private: hex(bobSk), recipient_public: hex(bobPk),
  ikmE: hex(ikmE), note: 'ikmE fixes the ephemeral key (RFC 9180 DeriveKeyPair) so the output is reproducible; real senders use a random ephemeral key.',
  info_utf8: HPKE_INFO, aad_utf8: `${noteId}\n${B}`,
  plaintext_utf8: JSON.stringify(payload),
  enc_b64url: sealed.enc, ct_b64url: sealed.ct,
  expected: 'Opening enc/ct with recipient_private, info and aad gives plaintext_utf8. Changing any byte of aad (for example another recipient actor) fails to open.',
};
out.attachment = { plaintext_utf8: 'hello attachment\n', key_b64url: att.key, iv_b64url: att.iv, algorithm: 'AES-256-GCM, 128-bit tag appended, no AAD', stored_bytes: hex(att.stored), size: att.stored.length, digest: `sha-256=:${b64(att.digest)}:` };

// Create activity and signed POST
const thread = `${A}/threads/5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d`;
const create = {
  '@context': ACTIVITY_CONTEXT,
  id: `${A}/activities/9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d`,
  type: 'Create', actor: A, published: '2026-11-17T02:00:00Z', to: [B],
  object: {
    id: noteId, type: 'Note', attributedTo: A, to: [B], published: '2026-11-17T02:00:00Z', context: thread, inReplyTo: null,
    content: ENCRYPTED_PLACEHOLDER, 'am:seq': 1,
    'am:encrypted': { kem: HPKE_IDS.kem, kdf: HPKE_IDS.kdf, aead: HPKE_IDS.aead, recipient: B, keyId: out.x25519_key.keyId, enc: sealed.enc, ct: sealed.ct },
    attachment: [{ type: 'Document', url: attUrl, mediaType: 'application/octet-stream', 'am:size': att.stored.length, 'am:digest': out.attachment.digest }],
  },
};
const body = JSON.stringify(create);
const digest = await contentDigest(te.encode(body));
const created = 1794880800; // 2026-11-17T02:00:00Z
const inbox = 'https://b.example/users/bob/inbox';
const headers: Record<string, string> = { 'content-type': 'application/activity+json', 'content-digest': digest };
const s = signRequest({ method: 'POST', url: inbox, headers }, { keyId: `${A}#sig-1`, privateKey: alice.privateKey, created, nonce: 'bm9uY2UtMDAwMDAwMDAwMDAx' });
const lookup = async (k: string) => { if (k === `${A}#sig-1`) return alice.publicKey; throw new SigError('key_unavailable', 'unknown'); };
const v = async (m: any, now: number, comps = POST_COMPONENTS) => { try { await verifyRequest(m, { now, requiredComponents: comps, lookupKey: lookup }); return 'valid'; } catch (e: any) { return e.code; } };
const msg = { method: 'POST', url: inbox, headers: { ...headers, 'signature-input': s['signature-input'], signature: s.signature } };
out.signed_post = {
  method: 'POST', target_uri: inbox, body_utf8: body,
  headers: { 'Content-Type': 'application/activity+json', 'Content-Digest': digest, 'Signature-Input': s['signature-input'], Signature: s.signature },
  signer_private_seed: hex(alice.privateKey), keyid: `${A}#sig-1`,
  signature_base: s.base,
  expected: {
    at_created_plus_10s: await v(msg, created + 10),
    at_created_plus_400s: await v(msg, created + 400),
    at_created_minus_400s: await v(msg, created - 400),
    target_uri_changed_to_carol_inbox: await v({ ...msg, url: 'https://b.example/users/carol/inbox' }, created + 10),
    content_digest_header_changed: await v({ ...msg, headers: { ...msg.headers, 'content-digest': 'sha-256=:' + b64(new Uint8Array(32)) + ':' } }, created + 10),
  },
};
// Signed GET for the attachment, as bob
const bobSig = deriveSigningKey(seed, 'bob', 1);
// Spec 0.2: bob gave an agent its own key (#enc-2). His actor names it, and alice seals a copy of the same message to it.
const agentSk = await sha256('agent-mail test vector: bob agent x25519');
const agentPk = x25519Public(agentSk);
const ikmE2 = await sha256('agent-mail test vector: ephemeral for the copy');
const copy = await sealNote(agentPk, noteId, B, payload, ikmE2);
if (JSON.stringify(await openNote(agentSk, noteId, B, copy)) !== JSON.stringify(payload)) throw new Error('copy roundtrip');
const bobKeys = {
  sigKeys: [{ id: `${B}#sig-1`, type: 'Multikey' as const, controller: B, publicKeyMultibase: multikeyEncode('ed25519', bobSig.publicKey) }],
  encKeys: [{ id: `${B}#enc-2`, type: 'Multikey' as const, controller: B, publicKeyMultibase: multikeyEncode('x25519', agentPk) },
            { id: `${B}#enc-1`, type: 'Multikey' as const, controller: B, publicKeyMultibase: multikeyEncode('x25519', bobPk) }],
};
const bobActor = (serverKeys?: string[]) => actorDocument({ origin: 'https://b.example', handle: 'bob', name: 'Bob', readReceipts: false, ...bobKeys, alsoEncryptTo: [`${B}#enc-2`], serverKeys });
out.agent_keys = {
  note: 'Spec 0.2, optional on the wire. A 0.1 instance ignores am:alsoEncryptTo, am:serverKeys, am:copies and am:agent and interoperates unchanged.',
  actor: { request: 'GET https://b.example/users/bob', content_type: 'application/activity+json', response: bobActor(),
    expected: 'The client key #enc-2 is listed before the owner key, so the last keyAgreement entry is still #enc-1. A sender seals am:encrypted to #enc-1 and one copy to #enc-2.' },
  actor_when_the_instance_holds_the_key: { response: bobActor([`${B}#enc-2`]), expected: 'Same actor, with am:serverKeys naming the client key whose private half the instance holds (the owner opted in). Senders treat the key as any other client key.' },
  copy: {
    key_id: `${B}#enc-2`, recipient_private: hex(agentSk), recipient_public: hex(agentPk), ikmE: hex(ikmE2),
    info_utf8: HPKE_INFO, aad_utf8: `${noteId}\n${B}`, plaintext_utf8: JSON.stringify(payload), enc_b64url: copy.enc, ct_b64url: copy.ct,
    expected: 'The same plaintext, info and aad as the hpke vector, sealed to the client key. Opening enc/ct with recipient_private gives plaintext_utf8.',
  },
  note_object: { ...create.object, 'am:copies': [{ keyId: `${B}#enc-2`, enc: copy.enc, ct: copy.ct }], 'am:agent': true },
  note_expected: 'The Note of the signed_post vector as an agent of alice would send it to this actor: am:encrypted opens with the owner key (x25519_key.private), the copy opens with copy.recipient_private, and both give the same plaintext.',
};
const g = signRequest({ method: 'GET', url: attUrl, headers: {} }, { keyId: `${B}#sig-1`, privateKey: bobSig.privateKey, created, nonce: 'bm9uY2UtMDAwMDAwMDAwMDAy' });
out.signed_get = { method: 'GET', target_uri: attUrl, headers: { 'Signature-Input': g['signature-input'], Signature: g.signature }, signer_private_seed: hex(bobSig.privateKey), signer_public: hex(bobSig.publicKey), keyid: `${B}#sig-1`, signature_base: g.base,
  expected: 'Valid at created+10 s with the public key above; the response is stored_bytes with Content-Digest equal to attachment.digest.' };
const checkGet = await verifyRequest({ method: 'GET', url: attUrl, headers: { 'signature-input': g['signature-input'], signature: g.signature } }, { now: created + 10, requiredComponents: GET_COMPONENTS, lookupKey: async () => bobSig.publicKey });
if (!checkGet) throw new Error('get');
out.rfc_vectors = {
  note: 'Standard vectors from the RFCs that the reference implementation also passes.',
  rfc9530: { body_utf8: '{"hello": "world"}', 'Content-Digest': 'sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:' },
  rfc9421_b26: { private_d_b64url: 'n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU', signature_base: '"date": Tue, 20 Apr 2021 02:07:55 GMT\n"@method": POST\n"@path": /foo\n"@authority": example.com\n"content-type": application/json\n"content-length": 18\n"@signature-params": ("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"', Signature: 'sig-b26=:wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw==:' },
  rfc9180_a11: { skRm: '4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8', enc: '37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431', info: '4f6465206f6e2061204772656369616e2055726e', aad: '436f756e742d30', ct: 'f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a', pt_utf8: 'Beauty is truth, truth beauty' },
};
writeFileSync(process.argv[2] ?? 'test-vectors.json', JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.signed_post.expected));
