# Phase 2 Runtime PostgreSQL — Final Report (COMPLETE)

Branch: `phase2-runtime-pg` · workspace `C:\Users\Lenovo\Desktop\مشروع ساهر`
Date: 2026-10-08

## 1. Summary

| Phase | Result |
|---|---|
| 1 — deterministic env loading | ✅ PASSED (`cab2bc1`) |
| 2 — live connection via the sync layer | ✅ PASSED |
| 3 — schema audit + realignment | ✅ COMPLETE (`002_align_live_schema` applied) |
| 4 — connection hardening | ✅ PASSED (`d91ba8a`, `170dda3`, `57d2dd3`) |
| 5 — transactions on one client | ✅ PASSED |
| 6 — live `test:live` with cleanup to exactly 0 | ✅ PASSED (33/33) |

170/170 unit tests green. The live database ends the run with **0 rows** on every
table (baseline 0 → tests → cleanup 0). No secrets printed or committed.

## 2. The synchronous-over-PostgreSQL problem and its solution

node-postgres is fully asynchronous, and no event-loop pumping (deasync
provably starves the connection handshake — only timers/fs settle under
`loopWhile`, the `pg` connect callback surfaced `timeout expired`). Repository
ports stay synchronous, so the pool runs in a worker thread and the caller
blocks on `Atomics.wait` over a `SharedArrayBuffer` result channel:

- `server/src/pg-worker.js` owns one `pg` Pool and publishes results with
  `Atomics.store`/`notify`; it also registers the int8→Number type parser so
  BIGINT timestamps and `COUNT(*)` come back as JS numbers, matching the SQLite
  backend (epoch-ms values are far below `Number.MAX_SAFE_INTEGER`).
- `server/src/pg.js` creates the worker, posts `{op, text, params}` messages,
  blocks with a strict deadline, and discards stale replies from timed-out ops
  by matching the reply `id`.
- Session ops (`sessionBegin`/`sessionExec`/`sessionEnd`) give SQLite's
  `BEGIN IMMEDIATE … COMMIT` real single-connection semantics.
- SSL on every connection, `connectionTimeoutMillis` 10 s, `statement_timeout`
  15 s → fast explicit failures, never a hang.
- `usePostgres` is enabled iff `SUPABASE_DB_URL` is set; the service-role-key
  fallback was deleted; boot runs `SELECT 1` and fails fast with a host-only
  message.

**`createPgDatabaseAdapter` (shared by all three PG repository adapters):**
named parameters `$name` → positional `$1…`, `BEGIN IMMEDIATE`/`COMMIT`/
`ROLLBACK` → session transaction, `run()` returns `{changes}` (rowCount),
SQLite-only `PRAGMA` is a no-op.

## 3. Phase 2 — live evidence (PASSED)

- `SELECT 1` through `pg.js` and a full `buildApplication()` boot (license/auth/
  drive repos + all services) work.
- Session round-trip (`BEGIN IMMEDIATE` → `ROLLBACK`) works; `COMMIT` without a
  transaction errors loudly; `run()` returns `{changes}`.
- **Network note:** port 5432 (session pooler, TLS) stalled for most of the
  session then recovered — the final `test:live` run passes through the real
  `SUPABASE_DB_URL` (5432, TLS), so **no `.env` change is required**. Port 6543
  (transaction pooler) was used earlier as an override while 5432 was down.

## 4. Phase 3 — schema audit and realignment (COMPLETE)

Audited live (read-only `information_schema`/`pg_catalog` + the Supabase MCP,
which is usable: `list_extensions`, `get_project_url`, `list_migrations`).

**Finding:** live == `001` exactly (baseline 0 everywhere), but `001`'s shape
cannot host the shared repositories — hard blocker `licenses.owner_google_sub
NOT NULL REFERENCES google_accounts` (license creation never supplies an owner;
binding is a later UPDATE), plus naming/type drift (`note`/`admin_note`,
`auth_accounts`/`google_accounts`, `auth_sessions`/`login_sessions`,
`license_installs`/`license_installations`, `event`/`at`/`install_id` columns,
`TIMESTAMPTZ` vs epoch-ms `BIGINT`, UUID vs TEXT ids).

**Resolution (user-authorized):** `server/supabase/migrations/002_align_live_schema.sql`
— an idempotent migration that rebuilds the **empty** tables on the repository
contract (safe because the baseline was 0; `001_*.sql` never modified). Applied
via the connection layer because the MCP `apply_migration` tool is unusable
(socket closes on DDL; no supabase CLI installed on this machine) — this MCP
limitation is reported, and the migration file is the committed source of truth
(40 statements, all applied; RLS re-enabled on the 7 tables with 14 deny
policies for `anon`/`authenticated`).

New live schema (verified after apply):

| Table | Notes |
|---|---|
| `licenses` | TEXT id PK, code_lookup UNIQUE, status CHECK(active/suspended/revoked), epoch-ms BIGINT, `linked_account_id` nullable, `note` |
| `license_tokens` | FK → licenses RESTRICT |
| `license_installs` | PK(license_id, install_id) → licenses RESTRICT |
| `license_events` | BIGSERIAL id, `event`/`at`/`install_id` |
| `auth_accounts` | google_sub PK |
| `auth_sessions` | FK → auth_accounts RESTRICT |
| `drive_grants` | google_sub PK |
All tables: RLS on, deny-all policies for `anon` and `authenticated` (service role bypasses).

## 5. Phase 6 — live test (PASSED)

`npm run test:live` → `server/scripts/pg-live.mjs`, 33 checks:

- **Auth:** upsertAccount → getAccount, createSession → resolveSession (sliding
  last_used_at), deleteSession, cleanupExpiredSessions.
- **License (full lifecycle, insert through the session BEGIN IMMEDIATE→COMMIT
  path):** insert, findById, findByCodeLookup (± secrets), bindAccount,
  markActivated, markVerified, setStatus (suspended/active), setNote,
  recordEvent + listEvents, upsertInstall (ON CONFLICT keep-one-row),
  insertToken/findToken/touchToken/revokeAllTokens, listLicenses.
- **Drive:** saveGrant → getGrant (AES-256-GCM roundtrip), upsert-replace,
  listGranted, revokeGrant, deleteGrant.
- **Contract checks:** `created_at` etc. come back as numbers (int8 decoded).
- **Cleanup:** `__test_*` rows removed in FK order → every table back to exactly
  0; verified on each run (and re-run twice to prove repeatability).

Notes:
- The script is PostgreSQL-only (no SQLite handle; `node:sqlite` is only ever
  imported lazily inside SQLite-only open functions that are never called).
- It reads `server/.env` via the same config loader as the runtime and connects
  with `SUPABASE_DB_URL` verbatim. `PG_LIVE_PORT` (default off, test-scoped)
  overrides only the port — used while 5432 was down; not needed now.

## 6. Repository payload

```
cab2bc1 phase1: deterministic env loading
d91ba8a phase4: worker-thread sync pg client, shared pool, boot check
170dda3 phase4/5: sync client compat layer (translation, sessions, shared db adapter)
cfac6b2 phase3: 002_align_live_schema migration
57d2dd3 phase4: drop deasync
+  int8 number parser, scripts/pg-live.mjs, test:live script (this session, committed next)
```

## 7. Repro commands

```powershell
cd "C:\Users\Lenovo\Desktop\مشروع ساهر\server"
npm test                # 170/170 unit (SQLite :memory:, untouched)
npm run test:live       # live Supabase, 33/33, cleanup to exactly 0
```