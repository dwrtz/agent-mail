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
- Bearer tokens for MCP in 0.1; OAuth later (added in 0.2, below).

## Choices made for 0.2 (agents)

- **Autonomy first, approvals for what is sensitive.** An agent that asks
  about everything is not useful, and one that can do everything is not
  safe. The owner picks, per agent, the few kinds of action to be asked
  about (the defaults: writing to someone new, letting a stranger in or
  shutting them out, changing a group); the agent can also flag a message
  itself. Everything else goes through without a prompt. Because the
  server cannot read messages, a held message is shown to the owner by
  returning the sender's own ciphertext to their browser.
- **A token is not the owner.** In 0.1 a connector token could mint
  tokens and publish keys. Tokens now have scopes, and account
  administration needs a session.
- **One key per agent**, as an addition to the wire format that 0.1
  ignores: the actor names extra keys in `am:alsoEncryptTo` and senders
  add `am:copies`. The owner's key stays last in `keyAgreement`, which is
  the key 0.1 senders use. Copies repeat the ciphertext, so they are
  capped at 4 and the sender checks the 256 KiB inbox limit; a content key
  wrapped per recipient key would be smaller but would change
  `am:encrypted` itself and break 0.1 receivers.
- **OAuth 2.1 as MCP clients expect it** (RFC 9728 and 8414 metadata,
  RFC 7591 registration, client id metadata documents, PKCE), with the
  grant stored as an ordinary scoped token.
- **A hosted connector that can only call tools** cannot hold a key, so
  on its own it only sees ciphertext. Decrypting for it on the server
  gives up the promise that the Worker never sees message text, so it is
  not a mode an instance is in but a choice made twice: the operator
  allows it (off by default), and the owner ticks a box for one connector,
  with the consequence spelled out and confirmed. The instance then holds
  a key for that connector only, never the owner's own key, wrapped under
  the instance secret, and the actor says so in `am:serverKeys` so that
  the people writing to it are not left believing otherwise.
- **The plain-text surface is local.** `agent-mail mcp` runs next to the
  agent and holds its key, so MCP clients get readable tools without the
  instance learning anything.
- **The doorbell stays content-free** but can carry several headers,
  because real triggers (a Claude Code routine's fire endpoint, for one)
  want more than one. Live `resources/updated` notifications are kept, but
  common MCP clients do not act on them, so `watch` and the doorbell are
  the practical wake paths.
- **MCP protocol versions.** The server answers `2025-11-25` and older.
  Revision `2026-07-28` was not implemented; clients that speak it fall
  back.

## How it was checked

The test vectors were generated with the reference implementation and
cross-checked against the RFC vectors above; two instances on separate
subdomains exchanged messages, groups and attachments end to end.
