# Agent Mail

## What this builds

A self-hosted, federated messaging endpoint for people and their AI agents,
on Cloudflare Workers. Every deploy is one *instance* on one domain. An
instance hosts one or more users. Each user is an ActivityPub-style *actor*
with a handle like `david@agent.example.com`, found with WebFinger, and
holding two published keys: Ed25519 for signing requests (RFC 9421) and
X25519 for end-to-end encryption (HPKE, RFC 9180).

Instances talk to each other directly, with no central server: the sender
looks up the recipient's handle, fetches their actor document, encrypts the
message to their key, signs the POST with its own key and delivers it to
their inbox. Because every build of this spec speaks the same wire format
(`protocol.md`), any instance can message any other.

On the receiving side the instance checks the signature, applies the owner's
policy (allow, ask, block), and keeps allowed messages in a durable queue.
The owner reads them in a small web app, and their agent (Grok Bot, Claude,
ChatGPT, or a script) reads them through the instance's own MCP connector:
pull, decrypt on the client, ack. While an agent holds a live MCP session it
is pushed `notifications/resources/updated`; an idle agent can be woken by an
optional, content-free webhook "doorbell"; a scheduled poll catches anything
missed.

The Worker never sees message text. Bodies and attachment keys are encrypted
in the sender's client (browser or agent) and decrypted in the recipient's
client. The Worker holds only the signing keys, the routing envelope and
ciphertext.

Read `spekkr.inputs.json` first: `app_name` is the product name in the web
app, `brand_color` is its accent colour. `protocol.md` is the normative wire
format, with `test-vectors.json` to prove it. `design.md` has the stack,
Cloudflare config, data model, owner API, MCP server, screens and deploy
steps. `tasks.md` is the build order. `research.md` explains what this is
based on and is context, not extra requirements.

## Names and words

- The product is called `app_name` in the web app and in the MCP server's
  `serverInfo.name` (lower-cased, spaces as dashes).
- Text the spec quotes is the text to use. Other UI text is the builder's
  own, short and plain.
- Icons are inline SVG or text. No images or fonts are copied from anywhere.

## Out of scope for 0.1

- Plaintext (unencrypted) messages and the draft-cavage HTTP signature
  compatibility mode. Every message is encrypted; every request is signed
  with RFC 9421. A fediverse server that does not speak this profile can
  fetch our actors but cannot read our messages.
- Public posts, follows, likes, boosts, timelines.
- MLS group encryption, key backup or recovery, multi-device key sync (the
  key file is moved by hand).
- OAuth for the MCP connector (bearer tokens only), Web Push, email digests.
- Editing or deleting delivered messages.

## Requirements

Each requirement has an id. Tests name the id they cover.

### R1. Run and store

- One Cloudflare Worker, TypeScript, Web APIs only (no `node:*` modules, no
  `nodejs_compat`). It serves the web app itself from a generated module
  (no Assets binding), the federation endpoints, the owner API and the MCP
  server.
- Bindings: D1 `DB`, R2 bucket `FILES`, Queue `DELIVERY` (producer and
  consumer on the same Worker). Vars `SITE_URL`, `ALLOWED_EMAILS`,
  `ALLOW_SIGNUP`, `ALLOW_HTTP_LOCALHOST`; secret `SIGNING_SEED`. A cron
  trigger every 15 minutes does cleanup. Exact config in `design.md`.
- `SITE_URL` (like `https://agent.example.com`, no trailing slash) is the
  instance's origin. Handles are `handle@<host of SITE_URL>`; all ids the
  instance mints start with `SITE_URL`.
- Schema in `migrations/0001_init.sql`, applied with
  `wrangler d1 migrations apply`. Times are UTC ISO 8601 strings ending in Z.
- `npm run dev` builds the UI, applies local migrations and runs
  `wrangler dev`. `npm test` runs the unit tests. `npm run e2e` runs two
  local instances and the end-to-end test (R14).

Check: `npm run dev` serves the web app on port 8787 and
`GET /.well-known/webfinger?resource=acct:nobody@localhost:8787` answers 404
JSON `{"error":"not_found",...}`.

### R2. Accounts and sign-in

- Email and password accounts, like the calendar and notes apps. Sign-up
  takes email, password (at least 10 characters), handle and display name.
  The handle matches `^[a-z0-9_]{1,32}$`, is unique, and becomes the actor
  `SITE_URL/users/<handle>`.
- `ALLOWED_EMAILS` (comma-separated, case-insensitive): when not empty, only
  those emails can sign up, sign in, or keep a session. Others get 403
  `{"error":"email_not_allowed"}` and the page shows "This instance is
  private."
- `ALLOW_SIGNUP` = `"0"` refuses new accounts with 403
  `{"error":"signup_closed"}`; existing accounts still sign in.
- Passwords are PBKDF2-SHA256, 100,000 iterations, 16-byte random salt.
  Sessions are random 32-byte tokens in an `HttpOnly; Secure; SameSite=Lax`
  cookie `am_session`, stored hashed (SHA-256), 30 days.
- Every state-changing `/api/*` request with a session cookie must carry an
  `Origin` equal to `SITE_URL` (else 403 `bad_origin`).

Check: sign-up with a non-allowed email is refused with 403; with an allowed
email it succeeds, `GET /api/me` returns the handle, and
`GET /users/<handle>` returns the actor.

### R3. Keys

- Signing: each user has an Ed25519 key derived from the instance secret
  `SIGNING_SEED` with HKDF-SHA256 (exact derivation in `protocol.md`, vector
  `signing_key_derivation`). The private key never leaves the Worker and is
  never stored in D1. The actor lists it in `assertionMethod` as
  `<actor>#sig-<version>`.
- Encryption: each user has an X25519 key pair made **in the client**. The
  private key is never sent to the Worker. The web app generates it on first
  sign-in ("Set up encryption"), keeps it in the browser's localStorage
  for that origin (key `am.keys:<actor>`, a JSON array of key files), publishes only the public key
  (`PUT /api/keys/encryption`), and offers the *key file* (format in
  `design.md`) as a download: "Download key file". It can also import a key
  file ("Use an existing key file"). Agents use the same key file.
- A new encryption key is added as `<actor>#enc-<n+1>`; older keys stay
  listed until the owner removes them, so messages encrypted to them still
  open. Senders always encrypt to the last key listed.
- Until a user publishes an encryption key their actor has an empty
  `keyAgreement`, and senders get `no_encryption_key`.

Check: the actor's `assertionMethod[0].publicKeyMultibase` decodes to the
key derived from `SIGNING_SEED`; after "Set up encryption" the actor lists
`#enc-1`, the browser's stored key matches it, and the D1 database contains
no private key.

### R4. Discovery (WebFinger, RFC 7033)

- `GET /.well-known/webfinger?resource=acct:<handle>@<host>` returns the JRD
  in `protocol.md` with `Content-Type: application/jrd+json` and
  `Access-Control-Allow-Origin: *`. The actor URL is also accepted as
  `resource`. Missing `resource` is 400 `bad_request`; an unknown handle or
  another host is 404 `not_found`.
- `GET /users/<handle>` returns the actor document (`protocol.md`) as
  `application/activity+json`, whatever the `Accept` header.
- Senders resolve a handle `user@host` with
  `GET https://host/.well-known/webfinger?resource=acct:user@host`, take the
  `self` link of type `application/activity+json`, fetch it and require the
  document's `id` to equal that link. A full actor URL can be used instead
  of a handle.

Check: the WebFinger and actor vectors match field for field (only keys and
host differ); lookups of `acct:x@other.host` and of an unknown handle are 404.

### R5. Sending

- Sending is two steps so encryption happens on the client:
  1. **Prepare** (`POST /api/outbox/prepare`, or the MCP tool
     `prepare_message`): the instance resolves every recipient, mints the
     Note id, thread id (new thread) and the sender's next sequence number,
     and returns each recipient's actor id, key id and X25519 public key,
     plus the sender's own key (for the sender's copy).
  2. **Send** (`POST /users/<handle>/outbox`, or the MCP tool
     `send_message`): the client sends one HPKE ciphertext per recipient and
     one for the sender's own copy. The instance builds one `Create`
     activity per recipient (`protocol.md`), stores the sent message, and
     puts one delivery per recipient on the `DELIVERY` queue.
- Recipients are a list of handles or actor URLs; the thread has at most 50
  members including the sender, else 422 `group_too_large`. A recipient
  without an encryption key gives 422 `no_encryption_key` naming them; an
  unresolvable one gives 422 `unknown_recipient`.
- A reply names the Note it answers; it goes to that Note's thread and all
  its current members except the sender, with `inReplyTo` set.
- Sending to someone adds an `allow` rule for them if there is no rule yet.
- The queue consumer signs each POST fresh (new `created`, `nonce`), and on
  a network error, 5xx, 408 or 429 retries with backoff
  (the first retry 30 s after the first failure, then doubling, capped at
  3600 s: `delaySeconds = min(30 * 2^(attempts - 1), 3600)` where `attempts`
  counts failures so far; at most 8 attempts). Any
  other 4xx fails the delivery at once. Each delivery's state (`queued`,
  `delivered`, `failed` and the last error) is shown on the sent message.
- A prepared draft expires after 1 hour (`410 draft_expired`).

Check: `test-vectors.json` `hpke` and `signed_post` are reproduced by the
library code (with the fixed `ikmE`), and a message sent from instance A
arrives at instance B with status `delivered` on A.

### R6. Checking (inbox)

`POST /users/<handle>/inbox` runs these checks in this order and stops at
the first failure with the status and error code shown. Nothing is stored or
queued for a failed request.

| # | Check | Failure |
|---|---|---|
| 1 | The user exists | 404 `not_found` |
| 2 | Body is at most 262,144 bytes | 413 `too_large` |
| 3 | `Content-Type` is `application/activity+json` or `application/ld+json` (parameters allowed) | 415 `unsupported_media_type` |
| 4 | `Content-Digest` has `sha-256` and it matches the body | 400 `digest_mismatch` |
| 5 | A signature tagged `agent-mail` is present and parses | 401 `signature_missing` / `signature_invalid` |
| 6 | It covers `@method`, `@target-uri`, `content-type`, `content-digest`; has `created`, `expires`, `nonce`, `keyid`, `alg="ed25519"` or no `alg` | 401 `signature_invalid` |
| 7 | `created` within 300 s of now, `expires` in the future and at most 300 s after `created` | 401 `signature_expired` (or `signature_invalid` for a bad lifetime) |
| 8 | The keyid's actor document (the URL before `#`) can be fetched and lists the key in `assertionMethod` with that `controller` | 401 `key_unavailable` |
| 9 | The signature verifies (after one refetch of the actor if the cached copy fails) | 401 `signature_invalid` |
| 10 | `(keyid, nonce)` was not seen in the last 15 minutes | 401 `replayed_nonce` |
| 11 | Body is a valid activity (`protocol.md`) | 400 `bad_activity` / 422 `unsupported_activity` / 422 `unsupported_encryption` / 422 `group_too_large` |
| 12 | The keyid's actor equals the activity's `actor` | 403 `actor_mismatch` |
| 13 | The inbox owner is in `to`, and for `Create` is `am:encrypted.recipient` | 422 `not_addressed` |
| 14 | The sending host has made at most 120 inbox POSTs to this instance in the current minute | 429 `rate_limited` with `Retry-After` |
| 15 | Thread rules (R9) | 403 `not_member` / `not_thread_owner` |
| 16 | The activity id was not already received by this user | 202 `{"status":"duplicate"}`, nothing new stored |

- A passing request answers 202 `{"status":"accepted"}`, whatever policy
  then decides (a blocked sender cannot tell it was blocked).
- The nonce is recorded only after the signature verifies (step 10), so an
  unsigned request cannot burn a nonce.
- Actor documents are cached in D1 for 1 hour; fetches time out after
  5 seconds, refuse redirects to other hosts, and are at most 64 KiB.
- Error bodies are `{"error":"<code>","detail":"<text>"}`.

Check: every row above has a unit or e2e test that sends a request failing
exactly that check and gets the listed status and code.

### R7. Deciding (policy)

- Rules are per user, for an actor URL or for a whole domain
  (`domain:example.com`), with action `allow` or `block`. An actor rule wins
  over a domain rule.
- With no rule the message is a **request**: it is stored but not queued.
- `allow`: stored and appended to the user's inbox queue (R8).
- `block`: dropped (nothing stored), still 202.
- **Approve** a sender: add an `allow` rule and move all their pending
  requests into the queue in arrival order. **Block** a sender: add a
  `block` rule and delete their pending requests. Rules can be listed,
  changed and removed in the web app and the API.
- `Add` and `Remove` are applied to thread state (R9) and then queued or
  held by the same policy as a message. `Read` is never queued.

Check: a message from a stranger lands in Requests, not in the queue; after
Approve it is in the queue; after Block a new message from them is answered
202 but stored nowhere.

### R8. The inbox queue

- Per user, in D1: an auto-increment `cursor`, the message, `created_at`,
  `acked_at`. Pull returns unacked items with `cursor > since`, oldest
  first, at most `limit` (1-100, default 50), with `more` when there are
  more. Ack takes `upTo` (acks every item `<= upTo`) or `ids`.
- Each item carries the full received activity (ciphertext included), the
  sender, thread id, `kind` (`message` or `membership`), `receivedAt`, and
  `gapBefore`: how many sequence numbers from that sender in that thread
  were skipped before it (R9).
- Ack is a delivery signal only; it never sends a read receipt.
- The queue survives restarts; nothing leaves it until acked.

Check: pull, ack with `upTo`, pull again returns only newer items; an
unacked item is still returned after a Worker redeploy.

### R9. Group threads (sender fan-out)

- A thread id is minted by its creator as `<creator actor>/threads/<uuid>`.
  Its members are the creator and everyone it adds; at most 50.
- Every `Create` is encrypted separately to each member and POSTed to each
  member's inbox. The `to` list names all members except the sender.
- On the first activity of an unknown thread, the receiver records the
  thread with members = `actor` + `to` (or `am:members` for an `Add`) and
  creator = the actor before `/threads/` in its id.
- In a known thread, a `Create` from someone not a member is refused (403
  `not_member`).
- Only the creator may `Add` or `Remove` others (403 `not_thread_owner`);
  any member may `Remove` themselves (leave). `Add`/`Remove` carry
  `am:members`, the full list after the change, which the receiver stores.
  The creator sends them to every member after the change plus, for
  `Remove`, the removed member.
- Removing a member needs no key rotation: later messages are simply not
  encrypted to them.
- Ordering: each sender numbers its activities in a thread with `am:seq`
  from 1. The receiver keeps the last seq per (thread, sender) and sets
  `gapBefore = seq - last - 1` when positive. The UI orders by `published`
  and shows "N earlier message(s) missing" on a gap.

Check: a 3-member thread across two instances: each member decrypts the
others' messages; after the creator removes one member, that member gets
the `Remove` and no later messages, and a `Create` they send to the thread
is refused with 403 `not_member`.

### R10. Attachments (R2, encrypted)

- The client encrypts each file with its own AES-256-GCM key and IV
  (`protocol.md`), uploads the stored bytes with `POST /api/attachments`
  (max 25 MiB, 10 per message) and gets back the URL
  (`SITE_URL/attachments/<32 hex>`), size and `sha-256` digest. The key and
  IV travel only inside the encrypted Note.
- `GET /attachments/<id>` requires an RFC 9421 signed GET (covering
  `@method`, `@target-uri`) from an actor who was sent a Note that
  references it, or the owner's session. Otherwise 401/403/404. The answer
  carries `Content-Digest`, `Content-Length` and
  `Content-Type: application/octet-stream`.
- The recipient's client asks its own instance to fetch
  (`POST /api/attachments/fetch`), which makes the signed GET as the user,
  checks size and digest against the Note's attachment entry (502
  `attachment_mismatch` if not), and returns the bytes. The client decrypts.

Check: round-trip a file from instance A to B; the bytes B's client decrypts
equal the original; a flipped byte in R2 gives `attachment_mismatch`; an
unsigned GET is 401 and a GET signed by a non-recipient is 403.

### R11. Read receipts (opt-in)

- Off by default per user (Settings: "Send read receipts"). The actor
  shows the setting as `am:readReceipts`.
- When on, opening a thread in the web app (or the MCP tool `mark_read`)
  sends a signed `Read` activity for each newly read Note to its author.
  When off, nothing is sent; reading is only marked locally.
- A received `Read` for a Note the user sent marks that recipient as having
  read it ("Read by …" under the sent message). Other `Read`s are ignored
  (202).

Check: with receipts off, marking a message read sends nothing and the
sender shows no read mark; with them on, the sender shows "Read by" the
reader.

### R12. Owner MCP connector

- `/mcp` implements MCP Streamable HTTP (protocol version `2025-06-18`;
  also answers `2025-03-26`) with JSON-RPC 2.0. Auth is
  `Authorization: Bearer <token>`; tokens are made in Settings
  ("Connector tokens"), shown once, stored hashed, and can be revoked.
  A missing or bad token is 401 with `WWW-Authenticate: Bearer`.
- `initialize` returns a session id in `Mcp-Session-Id` and capabilities
  `tools`, `resources: { subscribe: true }`. Sessions are stored in D1.
- Tools (exact schemas in `design.md`): `whoami`, `pull`, `ack`,
  `list_requests`, `approve`, `block`, `prepare_message`, `send_message`,
  `mark_read`, `fetch_attachment`, `list_threads`.
- Resource `inbox://unread` (JSON: `unread`, `requests`, `latestCursor`).
  `resources/subscribe` on it marks the session subscribed.
- `GET /mcp` with `Accept: text/event-stream` and the session id opens the
  server stream. While it is open the Worker checks the user's queue every
  2 seconds and sends `notifications/resources/updated` with
  `{"uri":"inbox://unread"}` when the latest unacked cursor or the request
  count changes and the session is subscribed. A comment line keeps the
  stream alive every 15 s; the stream ends after 10 minutes and the client
  reopens it.
- The Worker never decrypts. `pull` returns ciphertext; the client decrypts
  with its key file (the repo ships a small Node helper, `cli/agent-mail.mjs`,
  that does pull+decrypt, encrypt+send and attachment decrypt).

Check: an MCP client initializes, subscribes, opens the stream, receives
`notifications/resources/updated` within 5 s of a new allowed message,
pulls it, decrypts it with the key file and acks it.

### R13. Doorbell webhook (optional)

- Settings: "Doorbell URL" (https), "Header name" (default
  `Authorization`) and "Header value" (write-only; shown as set or not set).
  The form notes that the value field takes only the value (for example
  `Bearer …`) and that a full header line is also accepted.
- On save, the header name is trimmed and a trailing colon is stripped.
  The header value is trimmed; if it starts with the configured header
  name plus a colon (case-insensitive; the header being saved in the same
  request, else the stored header, else `Authorization`), that prefix is
  stripped and the rest is trimmed again. A pasted line such as
  `Authorization: Bearer …` is therefore stored and sent as `Bearer …`.
- When an item is appended to the user's inbox queue or a new request
  arrives, the Worker POSTs to the URL with that header and
  `Content-Type: application/json` and this content-free body:
  `{"type":"agent-mail.doorbell","handle":"<handle@host>","unread":<n>,"requests":<n>,"at":"<ISO>"}`.
  It never contains a sender, subject, thread or ciphertext.
- At most one ring per 30 s per user: an arrival inside the window
  schedules one ring for the end of the window (a delayed queue message).
- A failed ring is logged and not retried; the queue and a scheduled poll
  catch up. "Send test ring" in Settings rings once and shows the HTTP
  status.

Check: with a doorbell URL set, a new allowed message causes exactly one
POST with the header and a body with only the listed fields. Saving a
value of `Authorization: Bearer test` (default header name) stores and
sends `Bearer test`.

### R14. Web app

Signed-in screens (exact layout in `design.md`): Inbox (threads), Thread
(decrypted messages, attachments, reply, members), Compose, Requests,
Contacts (rules), Settings (profile, read receipts, encryption key, doorbell,
connector tokens). Decryption and encryption happen in the browser. If the
browser has no key for the user, every screen shows "Set up encryption".

Check: the e2e test drives two local instances in a headless browser:
sign up on both, set up keys, send A to B with an attachment, approve the
request on B, read and reply, and see the reply on A.

### R15. Quality

- Unit tests cover every vector in `test-vectors.json` (including the RFC
  9421 B.2.6, RFC 9530 and RFC 9180 A.1.1 vectors) and activity
  validation. `npm test` passes.
- The two-instance e2e (`npm run e2e`) exercises every R6 row and R9's
  thread rules over the network, using the test-only routes in
  `design.md` ("Test-only routes").
- Logs never contain message ciphertext, tokens, the doorbell header value,
  passwords or private keys.
- The Worker bundle has no `node:` imports. `tsc --noEmit` passes.

## Definition of done

`npm test` and `npm run e2e` pass, the two-instance e2e covers R4-R13, and a
deploy following `design.md` ("Deploy") answers WebFinger for its first
user.
