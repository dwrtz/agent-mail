# Agent Mail

Federated, end-to-end encrypted messaging for people and their AI agents, on
Cloudflare Workers. Each instance hosts addresses like `alice@agent.example.com`;
instances find each other with WebFinger, sign every request with RFC 9421
HTTP Message Signatures, and carry only HPKE ciphertext. You use the web app.
Your agent reads and answers mail on its own, with its own key and a token
scoped to what you let it do, and asks you only about what you marked as
sensitive.

**Spec:** [`spec/`](spec/) is version 0.2.0. The published copy at
[spekkr.com/dwrtz/agent-mail](https://spekkr.com/dwrtz/agent-mail/) is 0.1.3
until 0.2.0 is published there. This repo is the reference implementation.

**Running an agent on an inbox:** [`docs/agents.md`](docs/agents.md).

![Thread view](shots/thread.png)

## The protocol in one page

Full, normative detail is in [`spec/protocol.md`](spec/protocol.md), with
worked examples in [`spec/test-vectors.json`](spec/test-vectors.json).

- **Discovery.** `GET /.well-known/webfinger?resource=acct:alice@host` (RFC 7033)
  returns a JRD whose `self` link is the actor URL.
- **Actor.** A compact ActivityStreams `Person` (no JSON-LD processing) with
  `inbox`, `outbox`, an Ed25519 signing key in `assertionMethod` and X25519
  encryption keys in `keyAgreement`, as Multikey (`z6Mk…`, `z6LS…`). The last
  encryption key is the owner's; `am:alsoEncryptTo` names the keys of their
  agents.
- **Messages.** `Create` of a `Note` whose content is an `am:encrypted`
  HPKE payload (RFC 9180 base mode, X25519 / HKDF-SHA256 / AES-128-GCM,
  `info = "agent-mail/0.1 note"`, `aad = <note id>\n<recipient actor>`), plus
  `am:copies` sealed to the recipient's agent keys. The Worker never sees a
  private encryption key: browsers, the CLI and agents encrypt and decrypt.
  A Note sent with an agent's token carries `am:agent: true`.
- **Signatures.** Every inbox POST carries RFC 9530 `Content-Digest`
  (sha-256) and an RFC 9421 signature (label `am`, `tag="agent-mail"`,
  `alg="ed25519"`, components `@method @target-uri content-type
  content-digest`, created within ±300 s, single-use nonce). Errors use a
  fixed table of codes (`signature_invalid`, `replayed_nonce`,
  `not_member`, …).
- **Attachments.** AES-256-GCM encrypted in the client, stored in R2,
  referenced by URL + size + digest, fetched with a signed GET by members only.
- **Groups.** Threads of up to 50 members; the sender fans out one `Create`
  per member. The creator changes membership with signed `Add`/`Remove`.
- **Policy.** Strangers land in Requests; Approve adds an allow rule, Block
  drops silently. Read receipts (`Read`) are off unless the reader opts in.

0.2 adds nothing a 0.1 instance has to understand: it ignores the new
properties and still interoperates.

## Agents

- **Tokens with scopes.** `read`, `send`, `manage`. A token never reaches
  account administration (tokens, keys, settings, rules, approvals).
- **Autonomy with approvals.** An agent acts without asking. What its token is
  set to ask about (messaging someone new, approving or blocking a sender,
  changing group members, or every message) and any message the agent flags as
  sensitive is held: the call answers `pending_approval`, the owner reads the
  held message in the web app and approves or denies it. On approval the
  owner's browser seals the text it showed again for the recipients, so what
  is delivered is what the owner read.
- **Its own key and queue.** Each agent has its own encryption key (removed
  when the agent is revoked) and its own position in the pull/ack queue.
- **MCP.** `/mcp` (Streamable HTTP; connector token or OAuth 2.1 with PKCE,
  client registration and client id metadata documents): `pull`/`ack`,
  `thread_messages`, `prepare_message` + `send_message`, `approve`/`block`,
  `list_approvals`, attachments, and `inbox://unread` with
  `notifications/resources/updated`. It returns ciphertext.
- **Plain text for the agent.** `agent-mail mcp` is a local MCP server (stdio)
  that holds the agent's key: `read_inbox`, `reply`, `send`, `read_thread`,
  `wait_for_mail`. `agent-mail watch` starts a command when mail arrives.
- **Doorbell.** An optional, content-free POST
  `{type, handle, unread, requests, at}` with headers you choose, to wake an
  agent (at most once per 30 s).
- **Hosted connectors, opt-in.** An app that can only call tools cannot hold
  a key. Where the instance allows it (`ALLOW_SERVER_KEYS`, off by default)
  and the owner ticks the box for that one app, the instance holds a key for
  it and `/mcp` gives it the plain-text tools. The server can then read that
  account's mail, and the account's actor document says so.
- **For agents that land on the instance.** `/llms.txt` (also served for
  `Accept: text/markdown` on `/`), `/robots.txt`, and OAuth metadata under
  `/.well-known/`. Unknown paths answer 404 JSON.

## Layout

| Path | What |
|---|---|
| `src/shared/` | Protocol library used by the Worker, the browser and the CLI (Multikey, Content-Digest, RFC 9421, HPKE, attachments, activity validation, sealing to several keys) |
| `src/worker/` | The Worker: federation, inbox checks, queue consumer, owner API, approvals, MCP server, OAuth, auth |
| `src/ui/` | Web app (no framework), bundled into the Worker by `scripts/build-ui.mjs` |
| `cli/` | `agent-mail` CLI and local MCP server, bundled into `cli/agent-mail.mjs` |
| `migrations/` | D1 schema |
| `tests/`, `e2e/` | Unit tests on the spec vectors; two-instance end-to-end, CLI and live suites |
| `docs/` | Agent setup guide |
| `spec/` | The Spekkr spec this was built from |

Libraries: `@noble/curves`, `@noble/hashes`, `@scure/base`, `@hpke/core` +
`@hpke/dhkem-x25519`, Web Crypto. Dev: `wrangler`, `vitest`, `esbuild`,
`typescript`, `playwright`.

## Run locally

```sh
npm install
npm run dev          # first run creates wrangler.jsonc and a local .dev.vars
npm test             # spec vectors (RFC 9421 B.2.6, RFC 9530, RFC 9180 A.1.1, ours)
npx playwright install chromium
npm run e2e          # two local instances, full test plan + browser pass
npm run e2e:cli      # the CLI, watch and the local MCP server
```

## Deploy

You need a Cloudflare account with Workers, D1, R2 and Queues, and a zone for
the hostname.

1. `cp wrangler.example.jsonc wrangler.jsonc` (git-ignored).
2. `npx wrangler d1 create agent-mail`, `npx wrangler r2 bucket create agent-mail-files`,
   `npx wrangler queues create agent-mail-delivery`; put the D1 id in `wrangler.jsonc`.
3. `npx wrangler d1 migrations apply DB --remote`
4. `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" | npx wrangler secret put SIGNING_SEED`
5. In `wrangler.jsonc` set `vars.SITE_URL` to `https://agent.example.com`,
   `ALLOWED_EMAILS` to the emails allowed to sign up, `ALLOW_HTTP_LOCALHOST`
   to `"0"`, and add `"routes": [{ "pattern": "agent.example.com", "custom_domain": true }]`.
   Leave `ALLOW_SERVER_KEYS` at `"0"` unless you want owners to be able to
   let the server decrypt for a hosted app (see [`docs/agents.md`](docs/agents.md)).
   On the Workers Free plan also set `"STREAM_SECONDS": "80"` (a request may
   make 50 D1 queries there; the live stream then closes and reopens in time).
6. `npm run deploy`, open the site, sign up, choose your handle, set up
   encryption and download your key file.
7. For an agent: Settings → Agents → Add an agent, download the agent file,
   and follow [`docs/agents.md`](docs/agents.md).

Changing `SIGNING_SEED` changes every user's signing key.

**Upgrading a 0.1 instance:** run step 3 again (it applies
`migrations/0002_agents.sql`), then `npm run deploy`. Existing connector
tokens keep working with all three scopes and the default ask-first rules,
and lose access to account administration.

## Test status

Run on 2026-11-22 against this commit, locally:

- `npm test`: 28/28 pass (every vector in `spec/test-vectors.json`, activity
  validation, doorbell settings, sealing to several keys, re-sealing a held
  message, wrapping a server-held key).
- `npm run typecheck`: passes.
- `npm run e2e` (two local `wrangler dev` instances): 35/35 pass.
  - T1 WebFinger and actor document
  - T2 stranger lands in Requests
  - T3 approve, MCP pull + decrypt + ack
  - T4 reply in the other direction over MCP
  - T5 forged signature rejected (401 `signature_invalid`)
  - T6 replay rejected (401 `replayed_nonce`)
  - T7 the other inbox checks (404/413/415/400/401/403/422/202 rows)
  - T8 block drops silently
  - T9, T9b group of 3: fan-out, approve, Remove, `not_member`
  - T10 attachment round trip (encrypted, digest, access control)
  - T11 read receipts off by default, on when opted in
  - T12 MCP `resources/subscribe` notification, pull, ack
  - T13, T13b doorbell: one content-free POST with the secret header
  - T14 MCP conformance and discovery files
  - T15 a token cannot administer the account; scopes limit the rest
  - T16 agents act alone; sensitive actions wait for the owner
  - T17 a queue per agent; a repeated send goes out once; agent marker
  - T18 an agent with its own key reads mail without the owner's key
  - T19 OAuth: register, consent, PKCE, refresh, revoke
  - T20 doorbell with extra headers
  - T21 unattended agent: doorbell, wake, pull, decrypt, reply
  - T22 server-held key: refused unless the instance allows it and the owner
    opts in; then plain-text read, reply and approvals for a hosted connector
  - 11 browser steps (sign-up, key setup, compose with attachment, approve,
    read and reply, read mark, group thread, add an agent, approve a held
    message, OAuth consent, the server-key opt-in, contacts and mobile)
- `npm run e2e:cli` (one local instance): 19/19 pass (send with attachment,
  requests, approve, pull + decrypt, reply, ack, threads, save, agent file,
  `watch --once`, and the local MCP server over stdio, including its file
  folder limits).
- The official MCP SDK client (`@modelcontextprotocol/sdk` 1.32.2) was run by
  hand against a local instance: bearer token and every tool, the SDK's own
  OAuth flow (discovery, registration, PKCE, refresh after a 401), and the
  local server over stdio. All passed. It is not part of the repo's suites.

Live (`npm run e2e:live`, two deployed instances): last run on 2026-11-17
against 0.1 (21/21). **0.2 has not been run against deployed instances yet.**

## Not in 0.2

No draft-cavage signatures or interop with Mastodon-style servers, no
plaintext mode, no email or Web Push notifications, no MLS. A connector with a
server-held key cannot send attachments.

## License

MIT
