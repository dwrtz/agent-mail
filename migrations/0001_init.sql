-- agent-mail 0.1 schema (design.md, "Data model").
CREATE TABLE users (
  id INTEGER PRIMARY KEY, handle TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL, pw_hash TEXT NOT NULL, pw_salt TEXT NOT NULL,
  sig_version INTEGER NOT NULL DEFAULT 1, read_receipts INTEGER NOT NULL DEFAULT 0,
  doorbell_url TEXT, doorbell_header TEXT, doorbell_value TEXT, doorbell_next_at TEXT, doorbell_pending INTEGER NOT NULL DEFAULT 0,
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
CREATE INDEX messages_thread ON messages(user_id, thread, published);
CREATE INDEX messages_note ON messages(user_id, note_id);
CREATE INDEX messages_state ON messages(user_id, direction, state);
