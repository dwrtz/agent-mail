// R15: every vector in spec/test-vectors.json, including the RFC 9421 B.2.6, RFC 9530 and RFC 9180 A.1.1 vectors.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { CipherSuite, HkdfSha256, Aes128Gcm } from '@hpke/core';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';
import { b64, te, unhex, hex, unb64url, multikeyEncode, multikeyDecode } from '../src/shared/enc';
import { contentDigest, digestMatches } from '../src/shared/digest';
import { signRequest, verifyRequest, signatureBase, parseSignature, POST_COMPONENTS, GET_COMPONENTS, SigError } from '../src/shared/httpsig';
import { deriveSigningKey } from '../src/shared/keys';
import { sealNote, openNote, x25519Public, decryptFile, encryptFile } from '../src/shared/e2ee';
import { webfingerJrd, actorDocument, validateActivity } from '../src/shared/activity';

const V = JSON.parse(readFileSync(new URL('../spec/test-vectors.json', import.meta.url), 'utf8'));
const code = async (p: Promise<unknown>) => { try { await p; return 'valid'; } catch (e) { return (e as SigError).code; } };

describe('RFC vectors', () => {
  it('RFC 9530 Content-Digest', async () => {
    expect(await contentDigest(te.encode(V.rfc_vectors.rfc9530.body_utf8))).toBe(V.rfc_vectors.rfc9530['Content-Digest']);
  });
  it('RFC 9421 B.2.6 Ed25519', () => {
    const r = V.rfc_vectors.rfc9421_b26;
    const m = { method: 'POST', url: 'https://example.com/foo?param=Value&Pet=dog', headers: { date: 'Tue, 20 Apr 2021 02:07:55 GMT', 'content-type': 'application/json', 'content-length': '18' } };
    const params = '("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"';
    const base = signatureBase(['date', '@method', '@path', '@authority', 'content-type', 'content-length'], params, m);
    expect(base).toBe(r.signature_base);
    const sig = ed25519.sign(te.encode(base), unb64url(r.private_d_b64url));
    expect(`sig-b26=:${b64(sig)}:`).toBe(r.Signature);
  });
  it('RFC 9180 A.1.1 open', async () => {
    const r = V.rfc_vectors.rfc9180_a11;
    const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });
    const sk = await suite.kem.deserializePrivateKey(unhex(r.skRm).buffer);
    const ctx = await suite.createRecipientContext({ recipientKey: sk, enc: unhex(r.enc).buffer, info: unhex(r.info).buffer });
    expect(new TextDecoder().decode(await ctx.open(unhex(r.ct).buffer, unhex(r.aad).buffer))).toBe(r.pt_utf8);
  });
});

describe('agent-mail vectors', () => {
  it('signing key derivation and Multikey', () => {
    const v = V.signing_key_derivation;
    const k = deriveSigningKey(v.SIGNING_SEED_b64url, v.handle, v.version);
    expect(hex(k.privateKey)).toBe(v.ed25519_private_seed);
    expect(hex(k.publicKey)).toBe(v.ed25519_public);
    expect(multikeyEncode('ed25519', k.publicKey)).toBe(v.publicKeyMultibase);
    expect(multikeyEncode('x25519', unhex(V.x25519_key.public))).toBe(V.x25519_key.publicKeyMultibase);
    expect(hex(multikeyDecode(V.x25519_key.publicKeyMultibase).key)).toBe(V.x25519_key.public);
    expect(hex(x25519Public(unhex(V.x25519_key.private)))).toBe(V.x25519_key.public);
  });
  it('WebFinger JRD and actor document', () => {
    expect(webfingerJrd('alice', 'a.example', 'https://a.example/users/alice')).toEqual(V.webfinger.response);
    const a = V.actor.response;
    expect(actorDocument({ origin: 'https://a.example', handle: 'alice', name: 'Alice', readReceipts: false, sigKeys: a.assertionMethod, encKeys: a.keyAgreement })).toEqual(a);
    expect(a.assertionMethod[0].publicKeyMultibase).toBe(V.signing_key_derivation.publicKeyMultibase);
  });
  it('HPKE: reproduces enc/ct with the fixed ikmE and opens it', async () => {
    const v = V.hpke;
    const payload = JSON.parse(v.plaintext_utf8);
    const noteId = v.aad_utf8.split('\n')[0], rcpt = v.aad_utf8.split('\n')[1];
    const s = await sealNote(unhex(v.recipient_public), noteId, rcpt, payload, unhex(v.ikmE));
    expect(s).toEqual({ enc: v.enc_b64url, ct: v.ct_b64url });
    expect(await openNote(unhex(v.recipient_private), noteId, rcpt, { enc: v.enc_b64url, ct: v.ct_b64url })).toEqual(payload);
    await expect(openNote(unhex(v.recipient_private), noteId, 'https://b.example/users/carol', { enc: v.enc_b64url, ct: v.ct_b64url })).rejects.toThrow();
  });
  it('attachment AES-256-GCM and digest', async () => {
    const v = V.attachment;
    const e = await encryptFile(te.encode(v.plaintext_utf8), unb64url(v.key_b64url), unb64url(v.iv_b64url));
    expect(hex(e.stored)).toBe(v.stored_bytes);
    expect(`sha-256=:${b64(e.digest)}:`).toBe(v.digest);
    expect(new TextDecoder().decode(await decryptFile(unhex(v.stored_bytes), v.key_b64url, v.iv_b64url))).toBe(v.plaintext_utf8);
  });
  it('signed POST: base, signature and every expected result', async () => {
    const v = V.signed_post;
    const priv = unhex(v.signer_private_seed);
    const pub = ed25519.getPublicKey(priv);
    const headers = { 'content-type': v.headers['Content-Type'], 'content-digest': v.headers['Content-Digest'] };
    expect(await contentDigest(te.encode(v.body_utf8))).toBe(v.headers['Content-Digest']);
    expect(await digestMatches(v.headers['Content-Digest'], te.encode(v.body_utf8))).toBe(true);
    const created = Number(/created=(\d+)/.exec(v.headers['Signature-Input'])![1]);
    const nonce = /nonce="([^"]+)"/.exec(v.headers['Signature-Input'])![1];
    const s = signRequest({ method: 'POST', url: v.target_uri, headers }, { keyId: v.keyid, privateKey: priv, created, nonce });
    expect(s.base).toBe(v.signature_base);
    expect(s['signature-input']).toBe(v.headers['Signature-Input']);
    expect(s.signature).toBe(v.headers.Signature);
    const msg = { method: 'POST', url: v.target_uri, headers: { ...headers, 'signature-input': s['signature-input'], signature: s.signature } };
    const opt = (now: number) => ({ now, requiredComponents: POST_COMPONENTS, lookupKey: async () => pub });
    expect(await code(verifyRequest(msg, opt(created + 10)))).toBe(v.expected.at_created_plus_10s);
    expect(await code(verifyRequest(msg, opt(created + 400)))).toBe(v.expected.at_created_plus_400s);
    expect(await code(verifyRequest(msg, opt(created - 400)))).toBe(v.expected.at_created_minus_400s);
    expect(await code(verifyRequest({ ...msg, url: 'https://b.example/users/carol/inbox' }, opt(created + 10)))).toBe(v.expected.target_uri_changed_to_carol_inbox);
    expect(await code(verifyRequest({ ...msg, headers: { ...msg.headers, 'content-digest': 'sha-256=:' + b64(new Uint8Array(32)) + ':' } }, opt(created + 10)))).toBe(v.expected.content_digest_header_changed);
    expect(validateActivity(JSON.parse(v.body_utf8)).type).toBe('Create');
  });
  it('signed GET for the attachment', async () => {
    const v = V.signed_get;
    const created = Number(/created=(\d+)/.exec(v.headers['Signature-Input'])![1]);
    const nonce = /nonce="([^"]+)"/.exec(v.headers['Signature-Input'])![1];
    const s = signRequest({ method: 'GET', url: v.target_uri, headers: {} }, { keyId: v.keyid, privateKey: unhex(v.signer_private_seed), created, nonce });
    expect(s.base).toBe(v.signature_base);
    expect(s.signature).toBe(v.headers.Signature);
    const r = await verifyRequest({ method: 'GET', url: v.target_uri, headers: { 'signature-input': s['signature-input'], signature: s.signature } }, { now: created + 10, requiredComponents: GET_COMPONENTS, lookupKey: async () => unhex(v.signer_public) });
    expect(r.keyId).toBe(v.keyid);
  });
  it('picks the agent-mail-tagged member among several signatures', () => {
    const p = parseSignature('other=("@method");created=1;keyid="x", am=("@method");created=2;keyid="https://a/x";tag="agent-mail"', 'other=:AAAA:, am=:AAAA:');
    expect(p.label).toBe('am');
  });
});
