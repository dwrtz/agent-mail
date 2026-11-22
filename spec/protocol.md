# Protocol: agent-mail/0.1

This file is normative. Every instance built from this spec must produce and
accept exactly these shapes, so that separate builds interoperate.
`test-vectors.json` has worked examples of each; a build passes them all.

The protocol id on the wire is still `agent-mail/0.1`. Spec version 0.2 adds
three optional properties, marked **(0.2)** below: `am:alsoEncryptTo` on
actors, `am:copies` and `am:agent` on Notes. A 0.1 instance ignores them
(unknown properties are ignored) and interoperates unchanged; a 0.2 instance
must accept messages without them.

Documents are JSON in ActivityStreams 2.0 compact form. Consumers read the
properties as written here; no JSON-LD expansion is needed or done. Unknown
properties are ignored. URLs are `https`. (A test-only var allows
`http://localhost` and `http://127.0.0.1` so two local instances can talk.)

Base64url is RFC 4648 section 5 without padding. Base64 (in structured
header byte sequences) is standard with padding.

## 1. Identity and discovery

### 1.1 WebFinger (RFC 7033)

```
GET /.well-known/webfinger?resource=acct:alice@a.example
200 Content-Type: application/jrd+json
Access-Control-Allow-Origin: *

{"subject":"acct:alice@a.example",
 "aliases":["https://a.example/users/alice"],
 "links":[{"rel":"self","type":"application/activity+json","href":"https://a.example/users/alice"}]}
```

`resource` may also be the actor URL. The host part must equal the host of
`SITE_URL` (including the port, if any). Unknown: 404 `not_found`.

### 1.2 Actor document

`GET /users/<handle>` with `Content-Type: application/activity+json`:

```json
{
  "@context": ["https://www.w3.org/ns/activitystreams",
               "https://w3id.org/security/multikey/v1",
               {"am": "https://spekkr.com/dwrtz/agent-mail/ns#",
                "keyAgreement": {"@id": "https://w3id.org/security#keyAgreementMethod", "@type": "@id"}}],
  "id": "https://a.example/users/alice",
  "type": "Person",
  "preferredUsername": "alice",
  "name": "Alice",
  "inbox": "https://a.example/users/alice/inbox",
  "outbox": "https://a.example/users/alice/outbox",
  "assertionMethod": [{"id": "https://a.example/users/alice#sig-1", "type": "Multikey",
                       "controller": "https://a.example/users/alice", "publicKeyMultibase": "z6Mk..."}],
  "keyAgreement":    [{"id": "https://a.example/users/alice#enc-1", "type": "Multikey",
                       "controller": "https://a.example/users/alice", "publicKeyMultibase": "z6LS..."}],
  "am:protocol": "agent-mail/0.1",
  "am:readReceipts": false
}
```

**(0.2)** An actor whose owner gave agents their own keys also has

```json
  "keyAgreement": [{"id": "https://a.example/users/alice#enc-2", "type": "Multikey", "controller": "...", "publicKeyMultibase": "z6LS..."},
                   {"id": "https://a.example/users/alice#enc-1", "type": "Multikey", "controller": "...", "publicKeyMultibase": "z6LS..."}],
  "am:alsoEncryptTo": ["https://a.example/users/alice#enc-2"]
```

`am:alsoEncryptTo` lists up to 4 ids of entries in `keyAgreement`: the
*client keys*. They come first in `keyAgreement`, so the last entry is
always the owner's newest key. The property is absent when there are none.

- `assertionMethod`: Ed25519 signing keys (FEP-521a style). Multikey:
  `"z"` + base58btc(`0xed 0x01` + 32-byte public key).
- `keyAgreement`: X25519 HPKE keys. Multikey: `"z"` + base58btc(`0xec 0x01`
  + 32-byte public key). Senders use the **last** entry. Empty until the
  user sets up encryption. **(0.2)** Senders also seal a copy to each key
  named in `am:alsoEncryptTo` (section 3.2), ignoring ids that are not in
  `keyAgreement`, are not X25519, or name the last entry; at most the first
  4. Senders should not rely on an actor document older than 15 seconds
  when choosing keys.
- Key ids are `<actor>#sig-<n>` and `<actor>#enc-<n>`. An id names one key
  for ever: `n` is never reused after a key is removed.
- Every key's `controller` equals the actor `id`.
- `GET /users/<handle>/outbox` returns an empty `OrderedCollection`
  (`{"@context":"https://www.w3.org/ns/activitystreams","id":"<outbox>","type":"OrderedCollection","totalItems":0,"orderedItems":[]}`);
  messages are never public.

### 1.3 Signing key derivation (this implementation's choice; not visible on the wire)

`ed25519 seed = HKDF-SHA256(ikm = base64url-decode(SIGNING_SEED), salt = "agent-mail/0.1", info = "sig:<handle>:<version>", L = 32)`.
Version starts at 1. Vector: `signing_key_derivation`.

## 2. Request signatures (RFC 9421 + RFC 9530)

Every inbox POST and every attachment GET between instances is signed.

**POST** headers:

```
Content-Type: application/activity+json
Content-Digest: sha-256=:<base64 SHA-256 of the body>:
Signature-Input: am=("@method" "@target-uri" "content-type" "content-digest");created=<unix s>;expires=<created+300>;nonce="<base64url of 16 random bytes>";keyid="<actor>#sig-<n>";alg="ed25519";tag="agent-mail"
Signature: am=:<base64 Ed25519 signature over the signature base>:
```

**GET** (attachments): `Signature-Input: am=("@method" "@target-uri");created=...;expires=...;nonce="...";keyid="...";alg="ed25519";tag="agent-mail"`.

- The signature base is built exactly as RFC 9421 section 2.5:
  one line `"<component>": <value>` per covered component in order, then
  `"@signature-params": <the Signature-Input value after "am=">`, joined by
  `\n` with no trailing newline. `@method` is upper case; `@target-uri` is
  the absolute URL the request is sent to, including any query; header
  values are trimmed.
- Parameter order as shown. `alg` is always `ed25519`; `tag` is always
  `agent-mail`, and verifiers pick the Signature-Input member with
  `tag="agent-mail"` whatever its label.
- Verifiers: clock skew 300 s; lifetime at most 300 s; nonce 16-64
  characters, remembered per keyid for 15 minutes; key looked up by
  fetching the keyid's document URL (part before `#`) with
  `Accept: application/activity+json` and finding the entry in
  `assertionMethod` whose `id` equals the keyid.
- Vectors: `signed_post`, `signed_get`, and the RFC's own B.2.6 (Ed25519)
  and RFC 9530 example under `rfc_vectors`.

## 3. End-to-end encryption (HPKE, RFC 9180)

- Suite: mode base, KEM `0x0020` DHKEM(X25519, HKDF-SHA256), KDF `0x0001`
  HKDF-SHA256, AEAD `0x0001` AES-128-GCM. Single-shot seal/open.
- `info` = UTF-8 `agent-mail/0.1 note`.
- `aad` = UTF-8 `<Note id>` + `\n` + `<recipient actor id>`. This binds each
  ciphertext to its Note and its recipient: it cannot be replayed into
  another message or to another member.
- Plaintext = UTF-8 JSON:

```json
{"v":1,
 "summary":"Lunch?",
 "content":"Are you free for lunch on Friday?",
 "attachments":[{"url":"https://a.example/attachments/6b0c...","name":"hello.txt","mediaType":"text/plain",
                 "size":17,"key":"<base64url 32 bytes>","iv":"<base64url 12 bytes>"}]}
```

`summary` (subject) may be null. `content` is plain text, at most 65,536
characters. `attachments[].size` is the plaintext size; one entry per
`attachment` on the Note, matched by `url`. **(0.2)** An optional
`"agent": {"name": "<up to 80 characters>"}` says which agent wrote the
message; readers that do not know it ignore it.

- Vector: `hpke` (with a fixed `ikmE` so the output is reproducible) and
  RFC 9180 A.1.1 under `rfc_vectors`.

### 3.1 Attachment encryption

AES-256-GCM, a fresh random 32-byte key and 12-byte IV per file, no AAD.
Stored bytes = ciphertext followed by the 16-byte tag. The Note's
`am:size` and `am:digest` describe the stored bytes, so the fetcher checks
them before decrypting. Vector: `attachment`.

### 3.2 Copies for client keys (0.2)

For each key the recipient names in `am:alsoEncryptTo`, the sender seals
the **same plaintext** again, single-shot, with the same suite, the same
`info` and the same `aad` (`<Note id>\n<recipient actor id>`), and lists
the results on the Note:

```json
"am:copies": [{"keyId": "https://b.example/users/bob#enc-2", "enc": "<base64url 32 bytes>", "ct": "<base64url>"}]
```

- At most 4 entries. `am:encrypted` is unchanged and is always sealed to
  the recipient's last `keyAgreement` key, so a 0.1 receiver loses nothing.
- A receiver opens whichever block (`am:encrypted` or a copy) was sealed to
  a key it holds. The `aad` uses `am:encrypted.recipient` for every block.
- A sender does the same for its own stored copy with its own client keys.
- Each copy repeats the ciphertext. The whole activity must still fit the
  receiver's 262,144-byte inbox limit; a sender refuses a message that
  would not (413 `too_large` to its own client) rather than drop copies.
- Nothing proves that the blocks of one Note hold the same plaintext: only
  a holder of several of the keys could compare them. A sender can
  therefore show an owner and that owner's agent different text. Clients
  treat message text as untrusted input either way, and a client that
  re-sends a message on someone's say-so (an owner approving what an agent
  wrote) seals the plaintext it actually showed, never a ciphertext it was
  handed.
- A 0.2 receiver answers 400 `bad_activity` to an `am:copies` that is not
  an array of at most 4 objects with `keyId` (URL), `enc` (43 characters)
  and `ct` (base64url).

## 4. Activities

All activities have `"@context": ["https://www.w3.org/ns/activitystreams", {"am": "https://spekkr.com/dwrtz/agent-mail/ns#"}]`,
an `id` on the actor's origin (`<actor>/activities/<uuid>`), `actor`, `to`
(a non-empty array of actor ids, the members other than the actor, at most
49) and `published` (ISO 8601 UTC).

### 4.1 Create (a message)

One POST per recipient. Every copy has the same activity `id` and Note `id`;
only `am:encrypted` differs.

```json
{
  "@context": [...],
  "id": "https://a.example/users/alice/activities/<uuid>",
  "type": "Create",
  "actor": "https://a.example/users/alice",
  "published": "2026-11-17T02:00:00Z",
  "to": ["https://b.example/users/bob"],
  "object": {
    "id": "https://a.example/users/alice/notes/<uuid>",
    "type": "Note",
    "attributedTo": "https://a.example/users/alice",
    "to": ["https://b.example/users/bob"],
    "published": "2026-11-17T02:00:00Z",
    "context": "https://a.example/users/alice/threads/<uuid>",
    "inReplyTo": null,
    "content": "This message is end-to-end encrypted.",
    "am:seq": 1,
    "am:encrypted": {"kem": 32, "kdf": 1, "aead": 1,
                     "recipient": "https://b.example/users/bob",
                     "keyId": "https://b.example/users/bob#enc-1",
                     "enc": "<base64url 32 bytes>", "ct": "<base64url>"},
    "attachment": [{"type": "Document", "url": "https://a.example/attachments/<32 hex>",
                    "mediaType": "application/octet-stream", "am:size": 33,
                    "am:digest": "sha-256=:<base64>:"}]
  }
}
```

- `content` in the clear is always the fixed placeholder
  `This message is end-to-end encrypted.` (so a plain ActivityPub server
  shows something sensible). The real text is only in `am:encrypted`.
- `context` is the thread id. `inReplyTo` is the Note answered, or null.
- `am:seq` counts this actor's activities (Create, Add, Remove) in this
  thread, from 1. It is not covered by the encryption, so an instance
  assigns it when the activity is actually sent.
- **(0.2)** `"am:copies"`: section 3.2. Optional.
- **(0.2)** `"am:agent": true` when the message was sent with an agent's
  token rather than by the owner. It is a statement by the sending
  instance; absent otherwise. Receivers show it and never act on it.
- `attachment` is optional (at most 10). Attachment URLs are on the
  actor's origin. `mediaType` on the wire is always
  `application/octet-stream`; the real type is inside the ciphertext.

### 4.2 Add and Remove (group membership)

```json
{"@context": [...], "id": "<actor>/activities/<uuid>", "type": "Add",
 "actor": "<thread creator>", "object": "<member added>",
 "target": "<thread id>", "to": ["<every member after the change, except actor>"],
 "am:members": ["<full member list after the change, creator included>"],
 "am:seq": 4, "published": "..."}
```

`Remove` is the same with `object` = the member removed; its `to` also
includes the removed member. A member leaving sends `Remove` with
`object` = `actor`. Only the creator (the actor before `/threads/` in the
thread id) may Add, or Remove someone else.

### 4.3 Read (receipt, opt-in)

```json
{"@context": [...], "id": "<reader>/activities/<uuid>", "type": "Read",
 "actor": "<reader>", "object": "<Note id>", "to": ["<Note author>"], "published": "..."}
```

Sent only by users who turned receipts on.

### 4.4 Anything else

`Follow`, `Like`, `Delete`, etc. get 422 `unsupported_activity`.

## 5. Inbox responses and error codes

| Status | `error` | When |
|---|---|---|
| 202 | (`{"status":"accepted"}` or `{"status":"duplicate"}`) | Accepted, or already received |
| 400 | `bad_request` | Missing or malformed query / body |
| 400 | `bad_activity` | Activity fails the shape rules above |
| 400 | `digest_mismatch` | Content-Digest missing, not sha-256, or wrong |
| 401 | `signature_missing` | No Signature-Input/Signature with tag agent-mail |
| 401 | `signature_invalid` | Malformed, missing components/params, wrong alg, or does not verify |
| 401 | `signature_expired` | `created` skewed by more than 300 s, or past `expires` |
| 401 | `key_unavailable` | keyid's actor cannot be fetched or does not list the key |
| 401 | `replayed_nonce` | `(keyid, nonce)` seen in the last 15 minutes |
| 403 | `actor_mismatch` | keyid belongs to a different actor than `actor` |
| 403 | `not_member` | Create in a known thread from a non-member |
| 403 | `not_thread_owner` | Add/Remove of someone else by a non-creator |
| 403 | `forbidden` | Attachment GET by an actor not sent that attachment |
| 404 | `not_found` | Unknown user, attachment or route |
| 413 | `too_large` | Inbox body over 256 KiB, attachment over 25 MiB |
| 415 | `unsupported_media_type` | Wrong Content-Type |
| 422 | `unsupported_activity` | Type not supported |
| 422 | `unsupported_encryption` | HPKE ids not 32/1/1 |
| 422 | `group_too_large` | More than 50 members |
| 422 | `not_addressed` | Inbox owner not in `to` / not the `am:encrypted.recipient` |
| 429 | `rate_limited` | Over 120 inbox POSTs per minute from one host; `Retry-After` set |

Body: `{"error":"<code>","detail":"<human text>"}`, `Content-Type: application/json`.

## 6. Doorbell body

```json
{"type":"agent-mail.doorbell","handle":"david@agent.example.com","unread":3,"requests":1,"at":"2026-11-17T02:00:05.000Z"}
```

Nothing else. The header named in settings carries the configured value,
and any extra headers the owner configured are sent with it. `unread` is
the largest number of unacked items any of the owner's agents has waiting.
