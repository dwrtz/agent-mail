# Design

## Stack

- TypeScript everywhere. Worker entry `src/worker/index.ts`; shared
  protocol code in `src/shared/` (used by the Worker, the browser and the
  CLI); browser app in `src/ui/` bundled with esbuild into a generated
  module `src/worker/ui.gen.ts` (`export default { html, js, css }`) that
  the Worker serves at `/`, `/app.js`, `/app.css` and, for any other
  non-API GET that accepts HTML, the same `index.html` (client routing).
- Libraries (well-maintained, audited, pure JS, run in Workers, browsers
  and Node):
  - `@noble/curves` (Ed25519 sign/verify, X25519) and `@noble/hashes`
    (HKDF-SHA256).
  - `@hpke/core` + `@hpke/dhkem-x25519` (hpke-js) for RFC 9180.
  - `@scure/base` for base58btc (Multikey).
  - Web Crypto for SHA-256, AES-GCM, PBKDF2 and random bytes.
  - No framework in the UI: small DOM helpers, hash-free history routing.
  - Dev: `wrangler`, `vitest`, `esbuild`, `typescript`, `playwright`.

## Cloudflare config (`wrangler.jsonc`)

```jsonc
{
  "name": "agent-mail",
  "main": "src/worker/index.ts",
  "compatibility_date": "2026-11-16",
  "workers_dev": false,
  "preview_urls": false,
  "d1_databases": [{ "binding": "DB", "database_name": "agent-mail", "database_id": "<id>", "migrations_dir": "migrations" }],
  "r2_buckets": [{ "binding": "FILES", "bucket_name": "agent-mail-files" }],
  "queues": {
    "producers": [{ "binding": "DELIVERY", "queue": "agent-mail-delivery" }],
    "consumers": [{ "queue": "agent-mail-delivery", "max_batch_size": 10, "max_batch_timeout": 2, "max_retries": 8 }]
  },
  "vars": { "SITE_URL": "https://agent.example.com", "ALLOWED_EMAILS": "", "ALLOW_SIGNUP": "1", "ALLOW_HTTP_LOCALHOST": "0" },
  "triggers": { "crons": ["*/15 * * * *"] },
  "observability": { "enabled": true }
}
```

Secret: `SIGNING_SEED` = base64url of 32 random bytes
(`wrangler secret put SIGNING_SEED`). Changing it changes every user's
signing key. Local dev reads it from `.dev.vars`.

The repo keeps `wrangler.example.jsonc` with placeholders; the real
`wrangler.jsonc` with ids is git-ignored.

## Deploy

1. `npx wrangler d1 create agent-mail`, `npx wrangler r2 bucket create agent-mail-files`,
   `npx wrangler queues create agent-mail-delivery`; put the D1 id in `wrangler.jsonc`.
2. `npx wrangler d1 migrations apply DB --remote`.
3. `node -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'))" | npx wrangler secret put SIGNING_SEED`.
4. Set `SITE_URL`, `ALLOWED_EMAILS`; add a Custom Domain (`routes: [{ "pattern": "agent.example.com", "custom_domain": true }]`).
5. `npm run build && npm run deploy`. Sign up with an allowed email, choose the handle, set up encryption, download the key file.
6. Optionally set `ALLOW_SIGNUP` to `"0"` afterwards.

Two instances in the same Cloudflare zone can reach each other: a Worker's
`fetch` to another Worker's Custom Domain works. A Worker fetching its own
origin is routed internally to its own handler (see "Local delivery").

## Data model (`migrations/0001_init.sql`)

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY, handle TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL, pw_hash TEXT NOT NULL, pw_salt TEXT NOT NULL,
  sig_version INTEGER NOT NULL DEFAULT 1, read_receipts INTEGER NOT NULL DEFAULT 0,
  doorbell_url TEXT, doorbell_header TEXT, doorbell_value TEXT, doorbell_next_at TEXT,
  doorbell_pending INTEGER NOT NULL DEFAULT 0 /* 1 while a delayed ring is queued */,
  created_at TEXT NOT NULL);
CREATE TABLE enc_keys (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, n INTEGER NOT NULL,
  public_key TEXT NOT NULL /* base64url raw X25519 */, created_at TEXT NOT NULL, UNIQUE(user_id, n));
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE api_tokens (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT);
CREATE TABLE actor_cache (actor_id TEXT PRIMARY KEY, doc TEXT NOT NULL, fetched_at TEXT NOT NULL);
CREATE TABLE nonces (k TEXT PRIMARY KEY /* keyid + ' ' + nonce */, expires_at TEXT NOT NULL);
CREATE TABLE rate (host TEXT NOT NULL, minute TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (host, minute));
CREATE TABLE threads (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, uri TEXT NOT NULL, creator TEXT,
  members TEXT NOT NULL /* JSON array */, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(user_id, uri));
CREATE TABLE seqs (user_id INTEGER NOT NULL, thread TEXT NOT NULL, actor TEXT NOT NULL, last INTEGER NOT NULL,
  PRIMARY KEY (user_id, thread, actor));
CREATE TABLE messages (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, direction TEXT NOT NULL /* in|out */,
  activity_id TEXT NOT NULL, type TEXT NOT NULL, note_id TEXT, thread TEXT, actor TEXT NOT NULL,
  activity TEXT NOT NULL /* JSON as received, or the sender's own copy for out */, published TEXT NOT NULL,
  state TEXT NOT NULL /* in: queued|request ; out: sent */, gap_before INTEGER NOT NULL DEFAULT 0,
  read_at TEXT, read_by TEXT NOT NULL DEFAULT '{}', received_at TEXT NOT NULL,
  UNIQUE(user_id, direction, activity_id));
CREATE INDEX messages_thread ON messages(user_id, thread, published);
CREATE INDEX messages_note ON messages(user_id, note_id);
CREATE INDEX messages_state ON messages(user_id, direction, state);
CREATE TABLE inbox_queue (cursor INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL, created_at TEXT NOT NULL, acked_at TEXT);
CREATE INDEX inbox_queue_user ON inbox_queue(user_id, acked_at, cursor);
CREATE TABLE rules (user_id INTEGER NOT NULL, subject TEXT NOT NULL /* actor URL or domain:host */,
  action TEXT NOT NULL CHECK (action IN ('allow','block')), created_at TEXT NOT NULL, PRIMARY KEY (user_id, subject));
CREATE TABLE attachments (id TEXT PRIMARY KEY /* 32 hex */, user_id INTEGER NOT NULL, size INTEGER NOT NULL,
  digest TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE attachment_grants (attachment_id TEXT NOT NULL, actor TEXT NOT NULL, PRIMARY KEY (attachment_id, actor));
CREATE TABLE drafts (note_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, thread TEXT NOT NULL, in_reply_to TEXT,
  recipients TEXT NOT NULL /* JSON [{actor,inbox,keyId,publicKey}] */, members TEXT NOT NULL, seq INTEGER NOT NULL,
  new_thread INTEGER NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE deliveries (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
  target TEXT NOT NULL, inbox TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL /* queued|delivered|failed */,
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at TEXT NOT NULL);
CREATE TABLE mcp_sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, subscribed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
```

Requests are `messages` rows with `direction='in'` and `state='request'`.
A sent message is one `messages` row (`direction='out'`, `activity` = the
Create with the sender's own `am:encrypted` copy, encrypted to the sender's
key with `aad = <Note id>\n<sender actor>`) and one `deliveries` row per
recipient (the exact JSON body sent).

Doorbell bookkeeping: `doorbell_next_at` is the end of the current 30 s
window; `doorbell_pending` is 1 while a delayed `{kind:"doorbell"}` queue
message is waiting to ring at that time, so at most one is queued.

Cron (every 15 min): delete expired nonces, sessions, drafts, `rate` rows
older than 2 minutes, actor cache older than 1 day, MCP sessions idle for a
day.

## Local delivery

`federatedFetch(url, init)`: when `new URL(url).origin === SITE_URL`, the
Worker calls its own fetch handler with a `Request` instead of going to the
network (no network round trip, and it works the same in local dev). The request is still
signed and goes through every inbox check. Actor lookups for local actors use
the same path.

## Owner API

All JSON; session cookie (web app) or `Authorization: Bearer` connector
token. 401 `unauthorized` if neither.

| Method and path | Body / query | Answer |
|---|---|---|
| GET /api/config | (no auth) | `{host,origin}` |
| POST /api/auth/signup | `{email,password,handle,name}` | `{ok:true}` + cookie |
| POST /api/auth/login | `{email,password}` | `{ok:true}` + cookie |
| POST /api/auth/logout | | `{}` |
| GET /api/me | | `{user:{handle,name,email,actor,address,readReceipts,encKeys:[{n,keyId,publicKey}],doorbell:{url,header,valueSet},unread,requests,latestCursor,unreadMessages}}` |
| PUT /api/keys/encryption | `{publicKey}` (base64url raw X25519) | `{keyId}`; same key twice is a no-op |
| DELETE /api/keys/encryption/:n | | `{}` (cannot delete the only key or the newest key) |
| PUT /api/settings | `{name?,readReceipts?,doorbellUrl?,doorbellHeader?,doorbellValue?}` | `{user}` |
| POST /api/doorbell/test | | `{status}` |
| GET /api/tokens, POST /api/tokens, DELETE /api/tokens/:id | `{label}` | `{tokens}` / `{token}` (shown once) / `{}` |
| POST /api/resolve | `{to:[handle or actor URL]}` | `{actors:[{actor,handle,name,inbox,keyId,publicKey}]}` |
| POST /api/outbox/prepare | `{to?:[...], replyTo?: noteId, threadId?: string}` | `{noteId,activityId,threadId,seq,recipients:[{actor,keyId,publicKey}],self:{actor,keyId,publicKey},info,aadFormat}` |
| POST /users/:handle/outbox | `{noteId,payloads:[{recipient,keyId,enc,ct}],selfPayload:{keyId,enc,ct},attachments?:[{url,size,digest}]}` | 202 `{noteId,threadId,deliveries:[{target,status}]}` |
| POST /api/threads/members | `{uri, add?:[...], remove?:[...]}` (creator only, or remove self) | `{members}` |
| GET /api/threads | | `[{uri,creator,members,updatedAt,unread,last:{direction,published,activity}}]` (threads holding only requests are left out) |
| GET /api/threads/messages?uri= | | `[{id,direction,type,actor,activity,published,gapBefore,readAt,readBy,deliveries:[{target,status,attempts,last_error}]}]` |
| GET /api/queue?since=&limit= | | `{items,nextCursor,more}` |
| POST /api/queue/ack | `{upTo?}` or `{ids?}` | `{acked,unread}` |
| GET /api/requests | | `{items}` |
| POST /api/requests/approve, /block | `{actor}` | `{moved}` / `{dropped}` |
| GET /api/rules, PUT /api/rules, DELETE /api/rules?subject= | `{subject,action}` | |
| POST /api/messages/read | `{noteIds:[...]}` | `{marked,receiptsSent}` |
| POST /api/attachments | raw bytes, `Content-Type: application/octet-stream` | `{url,size,digest}` |
| POST /api/attachments/fetch | `{url,size,digest}` | bytes |

`unread`, `requests` and `latestCursor` describe the agent queue (unacked
items); `unreadMessages` counts received messages the owner has not opened
and is the web app's Inbox badge. The two are independent: an agent acking
its queue does not mark messages read, and reading in the web app does not
ack the queue.

Prepare for a reply: thread = the Note's thread; recipients = its members
minus the user. Prepare for a new thread: thread id
`SITE_URL/users/<handle>/threads/<uuid>`. `threadId` without `to` posts to
an existing thread's members.

## MCP server (`/mcp`)

JSON-RPC over Streamable HTTP. `POST /mcp` takes one request or
notification and answers `application/json` (no SSE on POST). Methods:
`initialize`, `notifications/initialized`, `ping`, `tools/list`,
`tools/call`, `resources/list`, `resources/read`, `resources/subscribe`,
`resources/unsubscribe`. `GET /mcp` (SSE) as in R12. `DELETE /mcp` ends the
session. Tool results are `{"content":[{"type":"text","text":"<JSON>"}],"structuredContent":<same JSON>}`.

| Tool | Input | Output |
|---|---|---|
| `whoami` | | `{address, actor, encKeyId, readReceipts}` |
| `pull` | `{since?: int, limit?: 1-100}` | `{items:[{cursor,kind,sender,thread,receivedAt,gapBefore,activity}], nextCursor, more}` |
| `ack` | `{upTo?: int, ids?: int[]}` | `{acked, unread}` |
| `list_requests` | | `{items:[{id,sender,thread,receivedAt,activity}]}` |
| `approve` / `block` | `{actor}` | `{moved}` / `{dropped}` |
| `list_threads` | | as GET /api/threads |
| `prepare_message` | `{to?: string[], replyTo?: string, threadId?: string}` | as prepare |
| `send_message` | `{noteId, payloads, selfPayload, attachments?}` | as outbox POST |
| `mark_read` | `{noteIds: string[]}` | `{marked, receiptsSent}` |
| `fetch_attachment` | `{url,size,digest}` | `{base64}` (stored, still encrypted; max 5 MiB here) |

The design notes' `reply` is `prepare_message` with `replyTo` then
`send_message`.

## Key file

```json
{"type":"agent-mail-key","v":1,"address":"david@agent.example.com","actor":"https://agent.example.com/users/david",
 "keyId":"https://agent.example.com/users/david#enc-1","privateKey":"<base64url 32 bytes>","publicKey":"<base64url 32 bytes>"}
```

Downloaded as `<handle>@<host>.agent-mail-key.json`. Anyone with it can read
the user's messages: keep it like a password.

## CLI helper (`cli/agent-mail.mjs`)

Node 20+, no install beyond the repo's dependencies (bundled by
`npm run build:cli` into `cli/agent-mail.mjs`). Env `AGENT_MAIL_URL`,
`AGENT_MAIL_TOKEN`, `AGENT_MAIL_KEY` (path to the key file).
Commands: `pull [--since N]` (pull + decrypt, prints JSON), `ack <upTo>`,
`send --to a@b,c@d [--subject S] [--attach file] <text>`,
`reply <noteId> <text>`, `requests`, `approve <actor>`, `read <noteId>`,
`attachment <url> <size> <digest> <key> <iv> <outfile>`. It talks to `/mcp`.

## Screens

Look: system font stack, white background, 1px `#e5e7eb` borders, 8px
radius, accent `brand_color` on primary buttons and the unread dot,
max width 960px, left nav on desktop (Inbox, Requests, Compose, Contacts,
Settings, with counts) and a top bar on mobile.

- **Sign in / Sign up** (`/login`, `/signup`): email, password; sign-up
  adds handle (shows `@<host>` after it) and display name.
- **Set up encryption** (shown instead of any screen when the browser has
  no private key for the user's latest `#enc-n`): "Create a new key"
  (generates, publishes, then shows "Download key file") and
  "Use an existing key file" (file input; checks its public key is listed).
- **Inbox** (`/`): threads, newest first: members (handles), decrypted
  subject or first line, time, unread dot. Empty: "No messages yet."
- **Thread** (`/thread?uri=`): messages oldest first; each shows sender,
  time, subject, text, attachments (download decrypts), "Read by …" under
  sent ones when receipts arrive, delivery state for sent ones, gap
  notices. Reply box at the bottom. Members panel (creator can add/remove;
  anyone can "Leave thread"). Opening marks unread messages read (R11).
- **Compose** (`/compose`): To (comma-separated handles), Subject, Message,
  Attach files, Send. Errors such as `no_encryption_key` are shown in words.
- **Requests** (`/requests`): sender, time, decrypted preview, Approve and
  Block.
- **Contacts** (`/contacts`): rules table, add an actor or `domain:host`
  as Allow or Block, remove.
- **Settings** (`/settings`): your address; display name; "Send read
  receipts" switch; encryption keys (download key file, create new key,
  remove old keys); doorbell URL, header name, header value, "Send test
  ring"; connector tokens (create, shown once, revoke) with the MCP URL.

## Tests

- `tests/vectors.test.ts`: every vector in `test-vectors.json` (Vitest,
  plain Node; no Worker runtime needed).
- `tests/activity.test.ts`: activity validation (R9 shapes, member caps,
  addressing).
- `e2e/e2e.ts` (`npm run e2e`): builds the UI, starts two `wrangler dev`
  instances (ports 8787 and 8788, separate `--persist-to` dirs,
  `ALLOW_HTTP_LOCALHOST=1`, `TEST_ROUTES=1`), and runs `e2e/suite.ts` then
  `e2e/ui.ts` against them. The suite covers R4-R13 over HTTP and MCP;
  every R6 row is exercised over the network (T5 forged signature, T6
  replay, T7 the remaining rows, T8 block, T9/T9b group rules), not in
  unit tests. `e2e/ui.ts` is a Playwright (Chromium) pass over the web app
  that writes the screenshots.
- `e2e/live.ts`: the same suite and UI pass against two deployed instances
  (`AM_A`, `AM_B` origins; `AM_PROBE` the probe key file).

### Test-only routes

When the var `TEST_ROUTES` is `"1"` (never on a real instance) the Worker
also serves:

- `GET /__test/probe`: a stand-in remote actor (no inbox) whose Ed25519
  `#sig-1` key is the Multikey in the var `TEST_PROBE_KEY`. The tests hold
  the matching private key and use it to send hand-built signed requests
  for the R6 rows (forged, replayed, stale, wrong digest and so on).
- `POST /__test/sink`, `GET /__test/sink`, `DELETE /__test/sink`: a
  doorbell target. A POST stores the body and the SHA-256 of the doorbell
  header value (never the value) in R2 under `sink/`; GET lists them;
  DELETE clears them.

## Deploy notes from the reference deployment

- Two Workers in the same zone with Custom Domains reach each other with
  plain `fetch` (no 522 or loop errors); the live suite passed on that
  setup.
- The reference deployment used D1, R2 and Queues on an account that
  already had Queues available; no other paid features are used.
