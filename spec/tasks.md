# Tasks

Work in this order. Finish each check before the next task.

1. **Set up.** npm package, `wrangler.jsonc` from `design.md`, `.dev.vars`
   with a test `SIGNING_SEED`, `src/shared`, `src/worker`, `src/ui`, the UI
   build script. Check: `npm run dev` serves a page titled `app_name`.
2. **Protocol library (`src/shared`).** Base64url, Multikey, Content-Digest,
   RFC 9421 sign/verify, HPKE seal/open, attachment AES-GCM, HKDF signing
   keys, activity validation. Check: `tests/vectors.test.ts` passes every
   vector in `test-vectors.json`, including the three RFC vectors.
3. **Schema and accounts (R1, R2).** Migration, sign-up/in/out, sessions,
   allow-list, Origin check. Check: allowed vs not-allowed sign-up.
4. **Keys and discovery (R3, R4).** Actor document, WebFinger, encryption
   key publish/remove. Check: R4's check.
5. **Inbox checks (R6).** In the table's order, plus the test-only routes
   (`design.md`). Check: an e2e case per row.
6. **Policy, queue, threads (R7, R8, R9).** Check: R7-R9 checks in the
   e2e suite.
7. **Sending (R5).** Resolve, prepare, outbox, queue consumer with retries,
   local delivery. Check: two local instances exchange a message.
8. **Attachments (R10) and read receipts (R11).**
9. **MCP (R12), doorbell (R13), CLI helper.**
10. **Web app (R14).**
11. **E2E.** `npm run e2e` across two instances; screenshots.
12. **Deploy and live test.** Deploy two instances (`design.md`, "Deploy")
    and run `e2e/live.ts` against them.
