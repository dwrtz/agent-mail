-- agent-mail 0.2: agents (design.md, "Data model").
-- Scoped connector tokens, owner approvals, per-agent queue cursors, client keys, OAuth, doorbell headers.

-- Connector tokens: what the agent may do (scopes) and what it must ask the owner first (ask).
-- The table is rebuilt so that ids come from AUTOINCREMENT: a token id is never given to a later token,
-- because queue positions, keys, approvals and OAuth tokens all refer to it.
CREATE TABLE api_tokens_v2 (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT,
  scopes TEXT NOT NULL DEFAULT 'read send manage', ask TEXT NOT NULL DEFAULT 'first_contact policy members',
  kind TEXT NOT NULL DEFAULT 'token' /* token | oauth */, client_id TEXT);
INSERT INTO api_tokens_v2 (id, user_id, label, token_hash, created_at, last_used_at) SELECT id, user_id, label, token_hash, created_at, last_used_at FROM api_tokens;
DROP TABLE api_tokens;
ALTER TABLE api_tokens_v2 RENAME TO api_tokens;

-- Client keys: extra X25519 keys (one per agent) that senders also encrypt to.
ALTER TABLE enc_keys ADD COLUMN kind TEXT NOT NULL DEFAULT 'primary'; /* primary | client */
ALTER TABLE enc_keys ADD COLUMN label TEXT;
ALTER TABLE enc_keys ADD COLUMN token_id INTEGER; /* a client key goes away with its token */
-- Opt-in: the instance holds the private half of a client key, for a hosted connector that cannot hold one.
ALTER TABLE enc_keys ADD COLUMN hosted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE enc_keys ADD COLUMN private_enc TEXT; /* that private key, AES-256-GCM under a key derived from SIGNING_SEED */
-- Key numbers are never reused: a sender holding an old actor document must not seal to a new key under an old id.
ALTER TABLE users ADD COLUMN key_seq INTEGER NOT NULL DEFAULT 0;

ALTER TABLE users ADD COLUMN doorbell_extra TEXT; /* JSON {"header-name":"value"} sent with every ring */
ALTER TABLE drafts ADD COLUMN sent_result TEXT;   /* set once sent, so a repeated send answers the same */

-- Actions an agent asked the owner to approve.
CREATE TABLE approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, token_id INTEGER, agent TEXT NOT NULL,
  kind TEXT NOT NULL /* send | approve | block | members */, reason TEXT NOT NULL /* first_contact | policy | members | all_sends | agent_flagged */,
  ref TEXT NOT NULL /* note id, actor or thread */, subject TEXT NOT NULL /* JSON, shown to the owner */,
  payload TEXT NOT NULL /* JSON, the held call */, status TEXT NOT NULL DEFAULT 'pending' /* pending | approved | denied | cancelled | expired | failed */,
  result TEXT, created_at TEXT NOT NULL, decided_at TEXT, expires_at TEXT NOT NULL);
CREATE INDEX approvals_user ON approvals(user_id, status, id);
CREATE INDEX approvals_ref ON approvals(user_id, kind, ref);

-- Per-consumer queue position. A consumer is 'session' (the owner API with a cookie) or 'token:<id>'.
CREATE TABLE consumers (user_id INTEGER NOT NULL, consumer TEXT NOT NULL, upto INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, consumer));
CREATE TABLE consumer_acks (user_id INTEGER NOT NULL, consumer TEXT NOT NULL, cursor INTEGER NOT NULL, PRIMARY KEY (user_id, consumer, cursor));
CREATE INDEX inbox_queue_cursor ON inbox_queue(user_id, cursor);
-- Carry over what was acked under 0.1 (one shared ack per item) to the owner and to every existing token.
INSERT INTO consumer_acks (user_id, consumer, cursor) SELECT user_id, 'session', cursor FROM inbox_queue WHERE acked_at IS NOT NULL;
INSERT INTO consumer_acks (user_id, consumer, cursor) SELECT q.user_id, 'token:' || t.id, q.cursor FROM inbox_queue q JOIN api_tokens t ON t.user_id = q.user_id WHERE q.acked_at IS NOT NULL;

-- OAuth 2.1 for the MCP connector.
CREATE TABLE oauth_clients (client_id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL /* JSON array */,
  source TEXT NOT NULL /* registered | metadata */, created_at TEXT NOT NULL, fetched_at TEXT NOT NULL);
CREATE TABLE oauth_codes (code_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, client_id TEXT NOT NULL, client_name TEXT NOT NULL,
  redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, scopes TEXT NOT NULL, ask TEXT NOT NULL, expires_at TEXT NOT NULL,
  hosted INTEGER NOT NULL DEFAULT 0 /* the owner ticked "let this server decrypt for this app" */);
CREATE TABLE oauth_tokens (access_hash TEXT PRIMARY KEY, refresh_hash TEXT NOT NULL UNIQUE, token_id INTEGER NOT NULL, client_id TEXT NOT NULL,
  access_expires_at TEXT NOT NULL, refresh_expires_at TEXT NOT NULL,
  rotated_at TEXT /* set when the refresh token was used: seeing it again means it leaked, and ends the grant */);
CREATE INDEX oauth_tokens_token ON oauth_tokens(token_id);
