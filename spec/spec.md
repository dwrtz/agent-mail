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
The owner reads them in a small web app, and their agents (Claude, ChatGPT,
Grok, or a script) read them through the instance's own MCP connector:
pull, decrypt on the client, ack. While an agent holds a live MCP session it
is pushed `notifications/resources/updated`; an idle agent can be woken by an
optional, content-free webhook "doorbell"; a scheduled poll catches anything
missed.

Agents work on their own. Each one has a token scoped to what the owner lets
it do, its own encryption key and its own place in the queue. It stops and
asks the owner only for what the owner marked as sensitive (R16); everything
else it does without asking.

The Worker never sees message text. Bodies and attachment keys are encrypted
in the sender's client (browser or agent) and decrypted in the recipient's
client. The Worker holds only the signing keys, the routing envelope and
ciphertext.

Read `spekkr.inputs.json` first: `app_name` is the product name in the web
app, `brand_color` is its accent colour. `protocol.md` is the normative wire
format, with `test-vectors.json` to prove it. Version 0.2 adds agents
(R16-R19); a 0.1 instance ignores what it adds on the wire and still
interoperates. `design.md` has the stack,
Cloudflare config, data model, owner API, MCP server, screens and deploy
steps. `tasks.md` is the build order. `research.md` explains what this is
based on and is context, not extra requirements.

## Names and words

- The product is called `app_name` in the web app and in the MCP server's
  `serverInfo.name` (lower-cased, spaces as dashes).
- Text the spec quotes is the text to use. Other UI text is the builder's
  own, short and plain.
- Icons are inline SVG or text. No images or fonts are copied from anywhere.

## Out of scope for 0.2

- Plaintext (unencrypted) messages and the draft-cavage HTTP signature
  compatibility mode. Every message is encrypted; every request is signed
  with RFC 9421. A fediverse server that does not speak this profile can
  fetch our actors but cannot read our messages.
- Public posts, follows, likes, boosts, timelines.
- MLS group encryption, key backup or recovery, multi-device key sync (the
  key file is moved by hand; agents get keys of their own, R18).
- Web Push, email digests.
- Editing or deleting delivered messages.
- Decrypting on the server for hosted connectors that cannot hold a key.

## Requirements

Each requirement has an id. Tests name the id they cover.

### R1. Run and store

- One Cloudflare Worker, TypeScript, Web APIs only (no `node:*` modules, no
  `nodejs_compat`). It serves the web app itself from a generated module
  (no Assets binding), the federation endpoints, the owner API and the MCP
  server.
- Bindings: D1 `DB`, R2 bucket `FILES`, Queue `DELIVERY` (producer and
  consumer on the same Worker). Vars `SITE_URL`, `ALLOWED_EMAILS`,
  `ALLOW_SIGNUP`, `ALLOW_HTTP_LOCALHOST`, optional `STREAM_SECONDS` (R12);
  secret `SIGNING_SEED`. A cron trigger every 15 minutes does cleanup. Exact
  config in `design.md`.
- `SITE_URL` (like `https://agent.example.com`, no trailing slash) is the
  instance's origin. Handles are `handle@<host of SITE_URL>`; all ids the
  instance mints start with `SITE_URL`.
- Schema in `migrations/0001_init.sql` and `migrations/0002_agents.sql`
  (the 0.2 additions; an existing 0.1 database is upgraded by applying it),
  applied with `wrangler d1 migrations apply`. Times are UTC ISO 8601 strings ending in Z.
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
- Every state-changing `/api/*` request, and `POST /users/<handle>/outbox`,
  with a session cookie and no `Authorization` header must carry an `Origin`
  equal to `SITE_URL` (else 403 `bad_origin`).

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
- A new encryption key is added as `<actor>#enc-<n>` with the next unused
  number; a number is never used again, even after its key is removed. Older
  keys stay listed until the owner removes them, so messages encrypted to
  them still open. Senders always encrypt to the last key listed, which is
  always the owner's newest key; agent keys (R18) are listed before it.
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
     Note id and thread id (new thread), and returns each recipient's actor
     id, key id and X25519 public key and their `alsoKeys` (R18), plus the
     sender's own key and `alsoKeys` (for the sender's copy). The `seq` it
     returns is provisional. Recipients' actor documents older than 15 s
     are fetched again here, so a new or removed key is picked up quickly.
  2. **Send** (`POST /users/<handle>/outbox`, or the MCP tool
     `send_message`): the client sends one HPKE ciphertext per recipient and
     one for the sender's own copy, each with optional `copies` for
     `alsoKeys`. The instance takes the sender's next sequence number in the
     thread (`am:seq` is assigned here, so a draft that is held or never
     sent leaves no gap), builds one `Create` activity per recipient
     (`protocol.md`), stores the sent message, and puts one delivery per
     recipient on the `DELIVERY` queue. It refuses with 413 `too_large` a
     message whose activity for any recipient would exceed 262,144 bytes.
  3. **Sending again is safe.** For one hour after a draft is sent, a
     repeated send for the same Note id answers with the first result plus
     `duplicate: true` and delivers nothing. While the first call is still
     running the answer is 409 `send_in_progress`.
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
- A prepared draft expires after 1 hour (`410 draft_expired`); a draft held
  for approval (R16) lasts as long as the approval.

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

- Per user, in D1: an auto-increment `cursor`, the message, `created_at`.
  Every **consumer** has its own position in it: `session` (the owner API
  with a cookie) and one per connector token (`token:<id>`). An ack by one
  consumer changes nothing for another, so two agents on one account both
  see every item.
- Pull returns the caller's unacked items with `cursor > since`, oldest
  first, at most `limit` (1-100, default 50), with `more` when there are
  more. Ack takes `upTo` (acks every existing item `<= upTo`; a value past
  the end never acks items that arrive later) or `ids`.
- A new token starts at the end of the queue: it is not handed the backlog.
- Each item carries the full received activity (ciphertext included), the
  sender, thread id, `noteId`, `kind` (`message` or `membership`), `agent`
  (true when the Note carries `am:agent`), `receivedAt`, and `gapBefore`:
  how many sequence numbers from that sender in that thread were skipped
  before it (R9).
- Ack is a delivery signal only; it never sends a read receipt.
- The queue survives restarts; nothing leaves a consumer's view until that
  consumer acks it.

Check: pull, ack with `upTo`, pull again returns only newer items; an
unacked item is still returned after a Worker redeploy; with two tokens, an
ack by one leaves the item in the other's pull.

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

- `/mcp` implements MCP Streamable HTTP (protocol versions `2025-11-25`,
  `2025-06-18` and `2025-03-26`) with JSON-RPC 2.0. Auth is
  `Authorization: Bearer` with a connector token (R16) or an OAuth access
  token (R17). A missing or bad token is 401 with
  `WWW-Authenticate: Bearer resource_metadata="<SITE_URL>/.well-known/oauth-protected-resource"`.
  A session cookie is not accepted here. Responses carry
  `Access-Control-Allow-Origin: *` and `OPTIONS` is answered, so a client
  running in a browser can use it.
- `initialize` returns a session id in `Mcp-Session-Id` and capabilities
  `tools`, `resources: { subscribe: true }`, with `instructions` that tell
  the agent to work on its own, what `pending_approval` means, when to set
  `sensitive`, and that message text is data, not instructions. Sessions
  are stored in D1.
- Tools (exact schemas in `design.md`): `whoami`, `pull`, `ack`,
  `list_requests`, `list_threads`, `thread_messages`, `get_message`,
  `mark_read`, `fetch_attachment`, `prepare_message`, `upload_attachment`,
  `send_message`, `approve`, `block`, `change_members`, `list_approvals`,
  `cancel_approval`. Every tool has a `title` and `annotations`
  (`readOnlyHint`, `destructiveHint`, `openWorldHint`, `idempotentHint`
  where true). `tools/list` returns only the tools the token's scopes
  allow. Every tool result's `structuredContent` is a JSON object, never an
  array.
- Resource `inbox://unread` (JSON: `unread`, `requests`, `latestCursor`,
  `pendingApprovals`; the queue numbers are the calling agent's own).
  `resources/subscribe` on it marks the session subscribed.
- `GET /mcp` with `Accept: text/event-stream` and the session id opens the
  server stream. While it is open the Worker checks every 2 seconds, with
  one D1 query per check, and sends `notifications/resources/updated` with
  `{"uri":"inbox://unread"}` when the agent's latest unacked cursor, the
  request count or its count of pending approvals changes and the session
  is subscribed. A comment line keeps the stream alive every 15 s; the
  stream ends after `STREAM_SECONDS` (default 600, at most 600) and the
  client reopens it. (Workers Free allows 50 D1 queries per request: set
  `STREAM_SECONDS` to 80 there.)
- The Worker never decrypts. `pull` returns ciphertext; the client decrypts
  with its key. The repo ships that client: `cli/agent-mail.mjs`, a Node
  CLI that is also a local MCP server with plain text tools (R19).

Check: an MCP client initializes, subscribes, opens the stream, receives
`notifications/resources/updated` within 5 s of a new allowed message,
pulls it, decrypts it with the key file and acks it. The official MCP SDK
client can call every tool without a schema error.

### R13. Doorbell webhook (optional)

- Settings: "Doorbell URL" (https), "Header name" (default
  `Authorization`) and "Header value" (write-only; shown as set or not set).
  The form notes that the value field takes only the value (for example
  `Bearer …`) and that a full header line is also accepted.
- "Extra headers" (write-only; the form shows which names are set): up to
  5 more headers, one `Name: value` per line, for webhooks that need more
  than one (for example a routine trigger that wants both `Authorization`
  and a version header). Names are letters, digits and dashes;
  `Content-Type`, `Content-Length`, `Host`, `Connection`,
  `Transfer-Encoding`, `Cookie` and the main header's name are refused
  (400). An empty value clears them.
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
  It never contains a sender, subject, thread or ciphertext. `unread` is
  the largest number of unacked items any of the user's tokens has (the
  owner's own count when there are no tokens).
- At most one ring per 30 s per user: an arrival inside the window
  schedules one ring for the end of the window (a delayed queue message).
- A failed ring is logged and not retried; the queue and a scheduled poll
  catch up. "Send test ring" in Settings rings once and shows the HTTP
  status.

Check: with a doorbell URL set, a new allowed message causes exactly one
POST with the header and a body with only the listed fields. Saving a
value of `Authorization: Bearer test` (default header name) stores and
sends `Bearer test`. With two extra headers set, a ring carries the main
header and both.

### R14. Web app

Signed-in screens (exact layout in `design.md`): Inbox (threads), Thread
(decrypted messages, attachments, reply, members), Compose, Requests,
Approvals (what agents asked before doing, R16), Contacts (rules), Settings
(profile, read receipts, encryption key, doorbell, agents). Decryption and
encryption happen in the browser. If the browser has no key for the user,
every screen except the OAuth consent screen shows "Set up encryption". A
message written by an agent shows an "agent" tag. The counts in the
navigation are refreshed on every navigation.

Only the app's own routes (`/`, `/login`, `/signup`, `/thread`, `/compose`,
`/requests`, `/approvals`, `/contacts`, `/settings`, `/oauth/authorize`)
return the HTML shell. Any other unknown path is 404 JSON
`{"error":"not_found",...}`, including unknown paths under `/.well-known/`.

Check: the e2e test drives two local instances in a headless browser:
sign up on both, set up keys, send A to B with an attachment, approve the
request on B, read and reply, and see the reply on A; add an agent and
download its agent file; approve a held message after reading it; allow an
app on the consent screen.

### R15. Quality

- Unit tests cover every vector in `test-vectors.json` (including the RFC
  9421 B.2.6, RFC 9530 and RFC 9180 A.1.1 vectors) and activity
  validation. `npm test` passes.
- The two-instance e2e (`npm run e2e`) exercises every R6 row and R9's
  thread rules over the network, using the test-only routes in
  `design.md` ("Test-only routes"), and the agent plan (R16-R19),
  including one test of the whole unattended loop: a message arrives, the
  doorbell rings, and an agent holding only its agent file (a read+send
  token and its own key) pulls, decrypts, replies and acks.
- `npm run e2e:cli` runs the CLI, `watch` and the local MCP server against
  one local instance.
- CI (`.github/workflows/ci.yml`) runs the typecheck, unit tests and both
  e2e suites on every push.
- Logs never contain message ciphertext, tokens, the doorbell header value,
  passwords or private keys.
- The Worker bundle has no `node:` imports. `tsc --noEmit` passes.

### R16. Agents: scoped tokens and owner approvals

- **Tokens.** Settings, "Agents": a token has a label, **scopes** and an
  **ask** list. It is shown once, stored hashed, and can be revoked.
  Scopes: `read` (pull, ack, threads, requests, attachments, mark read),
  `send` (prepare, send, upload), `manage` (approve, block, change
  members). A call outside the token's scopes is 403 `insufficient_scope`.
- **Never the account.** Whatever its scopes, a token cannot create, list
  or revoke tokens, publish or remove keys, change settings or the
  doorbell, write rules, or decide approvals. Those need the owner's
  session; a token gets 403 `session_required`.
- **Autonomy.** An agent's calls are carried out at once, without asking,
  unless one of these holds:

  | `ask` value | Held |
  |---|---|
  | `first_contact` | A send where any recipient has no `allow` rule (actor or domain) |
  | `policy` | `approve`, `block` |
  | `members` | Adding or removing thread members, leaving |
  | `all_sends` | Every send |
  | (always) | A send with `sensitive: true`, set by the agent |

  New tokens ask about `first_contact`, `policy` and `members` unless the
  owner chooses otherwise. Calls made with the owner's session are never
  held.
- **Held calls.** A held call is fully checked first, then stored, and
  answers `{"status":"pending_approval","approvalId":<n>,"reason":"<ask value or agent_flagged>"}`
  (HTTP 202 for a send). Nothing is delivered or changed. Repeating the
  same call returns the same approval. Held calls expire after 7 days.
- **Deciding.** Only the owner's session can approve or deny. The owner
  sees who asked, what, and why; for a held message, the instance returns
  the sender's own ciphertext so the browser can decrypt and show it.
  Approving carries the call out as the user (a message is sent with
  `am:agent`); the result, or the failure, is recorded on the approval.
  Denying records it; asking again for a denied message answers
  `{"status":"denied"}` and sends nothing.
- **For the agent.** `list_approvals` returns its own approvals with
  status `pending`, `approved` (with the result), `denied`, `cancelled`,
  `expired` or `failed`; `cancel_approval` withdraws a pending one. An
  agent never sees another agent's approvals or any held payload.
- **Revoking** a token also deletes its OAuth tokens, its client key and
  its queue position, and cancels its pending approvals.

Check: a token is refused on every administration route; a read-only token
cannot send or approve; a send to a new contact is held, visible and
readable to the owner, delivered only after approval; a send to an allowed
contact goes out at once; a `sensitive` send that is denied is never
delivered and leaves no sequence gap; `approve`, `block` and a membership
change by an agent are held.

### R17. OAuth for the MCP connector

- `GET /.well-known/oauth-protected-resource` (RFC 9728; also with `/mcp`
  appended): `resource` = `SITE_URL/mcp`, `authorization_servers` =
  `[SITE_URL]`, `scopes_supported`, `bearer_methods_supported: ["header"]`.
- `GET /.well-known/oauth-authorization-server` (RFC 8414): `issuer`,
  `authorization_endpoint` `/oauth/authorize`, `token_endpoint`
  `/oauth/token`, `registration_endpoint` `/oauth/register`,
  `response_types_supported: ["code"]`, `grant_types_supported:
  ["authorization_code","refresh_token"]`,
  `code_challenge_methods_supported: ["S256"]`,
  `token_endpoint_auth_methods_supported: ["none"]`,
  `client_id_metadata_document_supported: true`,
  `authorization_response_iss_parameter_supported: true`.
- **Clients** are public (no secret). `POST /oauth/register` (RFC 7591)
  takes `redirect_uris` (1-10) and `client_name` and answers 201 with a
  `client_id`. A `client_id` that is an https URL with a path is a client
  id metadata document: the instance fetches it (5 s, 64 KiB, cached a
  day) and requires its `client_id` to equal the URL. A redirect URI is
  https, http on loopback only, or an app's own scheme; never
  `javascript:`, `data:` or the like, never with a fragment. A loopback
  redirect matches on any port; all others match exactly.
- **Authorize.** `/oauth/authorize` is a web app screen. Signed out, the
  owner signs in and returns to it. It shows the client's name, where the
  browser will be sent, the scopes asked for (all three when none are
  named; `manage` unticked by default) and the ask list, with Allow and
  Deny. PKCE with `S256` is required; `response_type` must be `code`. A
  request with an unknown client or a redirect URI that is not the
  client's is shown as an error and never redirected. Allow redirects with
  `code`, `state` and `iss`; Deny with `error=access_denied`.
- **Token.** `POST /oauth/token` (form or JSON). `authorization_code`:
  the code is single use, lasts 5 minutes, and is bound to the client, the
  redirect URI and the code challenge. `refresh_token`: rotating, single
  use. Access tokens last 1 hour, refresh tokens 90 days. Errors are
  RFC 6749 JSON (`invalid_grant`, `invalid_request`,
  `unsupported_grant_type`).
- A grant is a connector token (R16) of kind `oauth`, labelled with the
  client's name: same scopes, same ask list, its own queue position,
  listed and revoked with the other agents. An access token is never an
  owner session.
- These endpoints and the metadata answer cross-origin requests.

Check: the metadata documents; registration (and a `javascript:` redirect
refused); a consent that is refused for a foreign redirect URI or without
S256; a code that works once and only with the right verifier; an access
token that reaches `/mcp` with only the allowed tools; a refresh token
that works once; revoking the grant ends both.

### R18. Agent keys and the agent marker

- **Client keys.** An agent can have its own X25519 key, made in the
  client and published by the owner (`PUT /api/keys/client`, at most 4 per
  user, optionally bound to a token so that revoking the token removes the
  key). The actor lists client keys in `keyAgreement` *before* the owner's
  keys, and names them in `am:alsoEncryptTo` (`protocol.md`).
- **Senders** seal the same plaintext to the recipient's last key
  (`am:encrypted`, as in 0.1) and to each key in the recipient's
  `am:alsoEncryptTo` (`am:copies`), with the same `info` and `aad`. They do
  the same for their own copy with their own client keys. A decryptor uses
  whichever block was sealed to a key it holds.
- An agent with only its own key reads what was sent after the key was
  published, by senders that know `am:alsoEncryptTo`. For older mail and
  for 0.1 senders it needs the owner's key as well.
- **Agent file.** "Add an agent" in the web app makes the token, makes
  and publishes a client key (by default), and offers one download with
  the instance URL, the token and the key(s) (`design.md`, "Agent file").
- **Marker.** A Note sent with a connector token carries
  `"am:agent": true`, set by the sending instance. The agent's client may
  also put `"agent": {"name": "…"}` inside the encrypted payload.

Check: after a client key is published, the actor's last `keyAgreement`
entry is still the owner's key and `am:alsoEncryptTo` names the client
key; a message from another instance opens with the client key alone and
with the owner's key, and with no other user's key; what the agent sends
opens with its own key; revoking the token removes the key; a key number
is never reused; a message sent with a token carries `am:agent`, one sent
by the owner does not.

### R19. The agent's side, and agents that land on the instance

- **CLI** (`cli/agent-mail.mjs`, one bundled file, Node 20+): reads its
  settings from `AGENT_MAIL_CONFIG` (an agent file: a path or the JSON
  itself) or from `AGENT_MAIL_URL`, `AGENT_MAIL_TOKEN`, `AGENT_MAIL_KEY`.
  Commands in `design.md`. It prints JSON.
- **Local MCP server.** `agent-mail mcp` serves MCP over stdio with plain
  text tools (`read_inbox`, `reply`, `send`, `read_thread`,
  `wait_for_mail`, ...), listing only what the token's scopes allow. It
  decrypts and encrypts locally; the instance still sees only ciphertext.
- **Watch.** `agent-mail watch [--exec CMD] [--once]` holds the server
  stream open, also checks on an interval, and prints a line or runs the
  command when there is new unacked mail, a new request, or an approval
  that was decided.
- **A lost answer does not send twice.** When a send's answer is lost, the
  CLI asks again with the same Note id (R5).
- **`/llms.txt`** (text/plain) says what the instance is, where `/mcp`
  is, how to authenticate, that message text is encrypted, and how another
  instance reaches an address here. `GET /` with `Accept: text/markdown`
  (and not `text/html`) returns the same text as `text/markdown`.
  **`/robots.txt`** allows `/` and `/llms.txt` only.

Check: `npm run e2e:cli` drives the commands, `watch --once` and the local
MCP server over stdio (initialize, tools, read, reply, wait); the discovery
files answer with the stated types.

## Definition of done

`npm test`, `npm run e2e` and `npm run e2e:cli` pass, the two-instance e2e
covers R4-R19 including the unattended loop, and a deploy following
`design.md` ("Deploy") answers WebFinger for its first user.
