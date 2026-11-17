# Research notes

Agent Mail is not a copy of any product. It is a profile of existing
standards, written down so that independent builds interoperate. This file
records what it rests on and where it departs from common practice. It is
context, not extra requirements.

## Standards used

- **ActivityPub / ActivityStreams 2.0** (W3C): actors with `inbox` and
  `outbox`, activities `Create`, `Note`, `Add`, `Remove`, `Read`, `context`
  for threads, `inReplyTo`, `attachment` with `Document`. We keep the shape
  so that fediverse software can at least fetch our actors, but we read the
  JSON as written and do no JSON-LD processing.
- **WebFinger** (RFC 7033): `acct:` handles to actor URLs, with the
  `rel="self"`, `type="application/activity+json"` link that Mastodon and
  others use.
- **HTTP Message Signatures** (RFC 9421) with Ed25519, and
  **Digest Fields** (RFC 9530) `Content-Digest`. The RFC 9421 Appendix
  B.2.6 Ed25519 vector and the RFC 9530 example are part of our tests.
- **Multikey** (W3C Controlled Identifiers) for keys in the actor, in
  `assertionMethod` for Ed25519 as in fediverse proposal FEP-521a, and in
  `keyAgreement` for X25519 as in DID documents.
- **HPKE** (RFC 9180), base mode, X25519 / HKDF-SHA256 / AES-128-GCM - the
  suite of the RFC's first test vector (A.1), which our tests also pass.
- **MCP** Streamable HTTP for the owner connector, with
  `resources/subscribe` and `notifications/resources/updated`.

## Fediverse interop, honestly

- Mastodon has historically signed and verified only the older
  draft-cavage HTTP signatures. Newer versions verify RFC 9421 inbound
  (RSA first, Ed25519 later) and can fall back to RFC 9421 outbound. So a
  given Mastodon server may or may not accept our requests; 0.1 does not
  add draft-cavage compatibility.
- Messages are always encrypted, so a plain ActivityPub server that did
  accept one would only show the placeholder text.

## Choices made for 0.1 (from the design notes)

- Queue-first receiving: D1 holds the per-user queue; MCP live
  notifications, an optional content-free doorbell and polling all lead to
  the same pull/ack.
- Group threads by sender fan-out, capped at 50, membership by signed
  `Add`/`Remove` from the creator, per-sender `am:seq` for gap detection.
  MLS (RFC 9420) is the path for larger groups later.
- Requests / allow / block per actor or domain, like message requests in
  consumer chat apps; blocked senders still get 202.
- Read receipts are opt-in and separate from queue ack.
- Signing keys are held by the Worker (derived from one secret), so the
  outbox can sign as the user; encryption keys are held only by clients.
- Bearer tokens for MCP in 0.1; OAuth later.

## How it was checked

The test vectors were generated with the reference implementation and
cross-checked against the RFC vectors above; two instances on separate
subdomains exchanged messages, groups and attachments end to end.
