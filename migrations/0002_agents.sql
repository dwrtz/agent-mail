-- agent-mail 0.2: agents (design.md, "Data model").
-- Scoped connector tokens, owner approvals, per-agent queue cursors, client keys, OAuth, doorbell headers.

-- Connector tokens: what the agent may do (scopes) and what it must ask the owner first (ask).
ALTER TABLE api_tokens ADD COLUMN scopes TEXT NOT NULL DEFAULT 'read send manage';
ALTER TABLE api_tokens ADD COLUMN ask TEXT NOT NULL DEFAULT 'first_contact policy members';
ALTER TABLE api_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'token'; /* token | oauth */
ALTER TABLE api_tokens ADD COLUMN client_id TEXT;

-- Client keys: extra X25519 keys (one per agent) that senders also encrypt to.
ALTER TABLE enc_keys ADD COLUMN kind TEXT NOT NULL DEFAULT 'primary'; /* primary | client */
ALTER TABLE enc_keys ADD COLUMN label TEXT;
ALTER TABLE enc_keys ADD COLUMN token_id INTEGER; /* a client key goes away with its token */
-- Key numbers are never reused: a sender holding an old actor document must not seal to a new key under an old id.
ALTER TABLE users ADD COLUMN key_seq INTEGER NOT NULL DEFAULT 0;

ALTER TABLE users ADD COLUMN doorbell_extra TEXT; /* JSON {"header-name":"value"} sent with every ring */
ALTER TABLE drafts ADD COLUMN sent_result TEXT;   /* set once sent, so a repeated send answers the same */

-- Actions an agent asked the owner to approve.
CREATE TABLE approvals (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, token_id INTEGER, agent TEXT NOT NULL,
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
  redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, scopes TEXT NOT NULL, ask TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE oauth_tokens (access_hash TEXT PRIMARY KEY, refresh_hash TEXT NOT NULL UNIQUE, token_id INTEGER NOT NULL, client_id TEXT NOT NULL,
  access_expires_at TEXT NOT NULL, refresh_expires_at TEXT NOT NULL);
CREATE INDEX oauth_tokens_token ON oauth_tokens(token_id);
