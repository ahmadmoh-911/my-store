# Phase 2 Runtime PostgreSQL — Status Report (BLOCKED at Phase 6)

Branch: `phase2-runtime-pg` · workspace `C:\Users\Lenovo\Desktop\مشروع ساهر`
Commits: `7788d4e` (checkpoint) → `cab2bc1` (phase1 env) → `d91ba8a` → `170dda3` (phase4/5 connection layer)
Date: 2026-10-07

---

## 1. Summary

| Phase | Result |
|---|---|
| 1 — deterministic env loading | ✅ PASSED (`cab2bc1`) |
| 2 — live connection via the sync layer | ✅ PASSED (proven live through Supabase pooler port **6543**) |
| 3 — schema audit (live vs 001 vs repository contract) | ✅ AUDITED — findings below |
| 4 — connection hardening (no fallback, SSL, timeouts, boot check) | ✅ PASSED (`d91ba8a`, `170dda3`) |
| 5 — transactions on one client | ✅ PASSED (session ops, verified live) |
| 6 — live `test:live` writes with cleanup | ⛔ **BLOCKED** — two blockers documented below |

170/170 unit tests green. No live rows were ever written; live baseline row counts stay 0. No secrets printed or committed (`server/.env` gitignored; tracked-file grep clean; only placeholder strings exist in `.env.example` and old reports).

---

## 2. The synchronous-over-PostgreSQL problem and its solution

**Problem (empirically proven):** node-postgres is fully asynchronous, and no event-loop
pumping — including `deasync.loopWhile` — can drive its TCP/TLS handshake or a query from
inside a blocking call. Under deasync, timers and filesystem calls settle but the `pg`
connection never does: callback connect surfaced only `timeout expired` after
`connectionTimeoutMillis` (~8 s), i.e. the pump starves the pg protocol. A synchronous
wrapper over `pg` in-process is therefore impossible while keeping the repository ports
synchronous.

**Solution (zero new dependencies):** a worker-thread sync bridge.

- `server/src/pg-worker.js` owns one `pg` `Pool` and runs freely.
- `server/src/pg.js` creates the worker, posts `{op, text, params}` messages, and blocks on
  `Atomics.wait` over a `SharedArrayBuffer` result channel. Replies are published with
  `Atomics.store`/`notify`; failures are bounded by a caller-side deadline
  (`storehub-pg: 10s deadline`, `STOREHUB_PG_TIMEOUT`).
- The caller gets exactly the synchronous interface it already used: `query` / `exec` /
  `close`, plus `sessionBegin` / `sessionExec` / `sessionEnd` for real
  single-connection transactions (the SQLite `BEGIN IMMEDIATE … COMMIT` equivalent).
- Worker boot errors are surfaced as the real error; dereferenced-stale-reply races after
  a timed-out op are handled by matching the reply `id` inside the deadline loop.

**Transport:** SSL is requested for every connection (`ssl: { rejectUnauthorized: false }`,
the documented node-pg setting for Supabase's self-signed chain), `connectionTimeoutMillis`
10 s, `statement_timeout` 15 s, so a stalled connection is a fast explicit error, never a hang.

**Runtime selection:** `usePostgres` is enabled **iff** `SUPABASE_DB_URL` is set
(`config.js`). The service-role-key fallback was deleted; `createSupabaseClient` throws if
no `SUPABASE_DB_URL`. `index.js` shares one client across all repositories and runs a boot
`SELECT 1` that fails fast with a host-only message (credentials never printed).

**Repository compatibility layer (`createPgDatabaseAdapter` in `pg.js`):**
- SQLite named parameters `$name` → PostgreSQL positional `$1…` (translated once at
  `prepare`, params object re-packed per call).
- `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` → real session transaction.
- `run()` returns `{ changes }` (rowCount) — required by `deleteGrant`/cleanup paths.
- SQLite-only `PRAGMA` on the PG path is a no-op.
- All three PG adapters now build their `db` through this shared adapter.

---

## 3. Phase 2 — live evidence (PASSED)

All timings through the real `pg.js` sync client, no test doubles:

- `SELECT 1` via pg.js: **OK in ~3.4 s** → `[{ "?column?": 1 }]`.
- Session round-trip: `BEGIN IMMEDIATE` → `ROLLBACK` OK; `COMMIT` without a transaction
  errors exactly once with `storehub-pg: COMMIT with no open transaction` (correct rollback
  idempotency, wrong-commit loudly).
- `run()` → `{ changes: 0 }` on a guaranteed-no-match DELETE.
- `repo.findById('<nonexistent>')` reached the database and returned a real PostgreSQL
  error (`column "linked_account_id" does not exist`) — proof that the full repository SQL
  path (translate → worker → pg → error mapping) is end-to-end alive.
- **Full stack boot** via `buildApplication()` in PostgreSQL mode: **OK in ~3.3 s**
  (boot `SELECT 1`, license/auth/drive repositories, all services), clean `close()`.

**Network note whose resolution is not in this repo:** credentials are valid (auth
succeeds). The `.env` value points at the session pooler on port **5432**, whose TLS
handshake now stalls from this machine (TCP to 5432/6543 fine; TLS never completes in
10–15 s; it worked once earlier in the session, then consistently stalled after a burst of
connection attempts). Port **6543** (transaction pooler, same database/credentials) works
reliably. The runtime connects via `SUPABASE_DB_URL` verbatim, and `server/.env` is the
user's file (never edited/committed), so switching requires the manual change below.

---

## 4. Phase 3 — schema audit (COMPLETE)

Audit performed live via read-only `information_schema`/`pg_catalog` queries (and the
Supabase MCP, which is usable again: `list_extensions`, `get_project_url` fine;
`list_migrations` returns `[]` — the schema exists out-of-band, not via the CLI ledger).

**Live database = exactly migration `001`:**
- 7 tables present, all columns/`NOT NULL`/defaults match `001_initial_schema.sql`.
- Keys: PKs/UNIQUEs on `licenses.code_lookup`, composite PK on `license_installations`,
  FKs with `RESTRICT` (and `license_events` `SET NULL`) — all as designed.
- RLS enabled on all 7 tables with deny-all policies for `anon` and `authenticated`;
  service role (the backend) bypasses RLS.
- `pgcrypto` extension installed. PostgreSQL 17.11, database `postgres`.
- **Baseline row counts: 0 on all 7 tables** (no pre-existing data to preserve/migrate).

**The mismatch (001/live vs the repository contract):** the runtime repositories
(`repository.js`, `auth-repository.js`, `drive-repository.js`) are shared between the
SQLite and PostgreSQL paths, so they execute the SQLite data-model contract. The live
schema was designed differently:

| Repository contract | Live (001) schema |
|---|---|
| `licenses.id` TEXT (crypto UUID string) | `licenses.id` UUID |
| `licenses.linked_account_id` nullable, bound later | `licenses.owner_google_sub TEXT NOT NULL REFERENCES google_accounts` |
| `licenses.note` | `licenses.admin_note` |
| `licenses.created_at/activated_at/expires_at/last_verified_at` epoch-ms INTEGER | same columns but `TIMESTAMPTZ` |
| `auth_accounts` / `auth_sessions` tables | `google_accounts` / `login_sessions` tables |
| `drive_grants` (identical shape) | `drive_grants` (only timestamp types differ) |

**Hard blocker for the runtime license write path:** `repository.insert()` creates a
license with no owner and binds the account later via `UPDATE`. Against the live schema
that insert must satisfy `owner_google_sub NOT NULL` + the FK to `google_accounts`, i.e.
an honest runtime/connection-layer-only fix cannot exist — any value there would be
fabricated data. Column/table/type aliasing on top would not fix that, so the repositories
cannot operate on the live schema as-is.

**Migration gate:** per the mission, `apply_migration` is only sanctioned for new
idempotent `002+` migrations when **a real live-vs-001 diff exists**. That diff provably
does not exist (live == 001 exactly), so a `002` that realigns the schema is a
schema-rewrite decision that the mission does not authorize me to make unilaterally. It is
also a *safe* operation here precisely because the baseline is 0.

---

## 5. Phase 6 blockers and the decision needed

The connection layer is proven; what remains is blocked on two things, both of which need
a human decision, not more code:

**Blocker A — live schema vs repository contract (license/auth write path).**
Choose one:
1. **Authorize a 002 migration** (I have the exact idempotent DDL ready) that realigns the
   live tables to the repository contract: `google_accounts → auth_accounts`,
   `login_sessions → auth_sessions`, `licenses.admin_note → note`,
   `owner_google_sub → linked_account_id` (nullable), epoch-ms integers for the
   timestamp columns, `id` TEXT. Safe on this project because all tables are empty;
   `001_initial_schema.sql` and `001_validation.sql` are never modified.
2. **Keep the 001 schema as the source of truth.** Then the license/auth write paths
   cannot use PostgreSQL without either fabricating the owner row or shipping a fresh
   repository contract — both out of scope for this task's allowed fix list.

**Blocker B — `SUPABASE_DB_URL` port.** On this network, the session pooler (5432) TLS is
currently unreachable while the transaction pooler (6543) works plaintext. Set
`server/.env` `SUPABASE_DB_URL` to port **6543** (same host/credentials) and Phase 6's live
run can proceed. (Alternatively wait out/stabilize 5432 TLS, which is a network condition,
not a code bug.)

**Stop condition applied honestly:** no destructive operations were performed, no
migrations were authored/applied, no live rows written, the SQLite test baseline is
untouched (170/170), and no secret was printed or committed. Per the mission rules this is
a documented BLOCKED report, not a workaround.

---

## 6. Repro commands (for when the blockers clear)

```powershell
# liveSELECT1/probes (system temp, out of repo): node C:\Users\Lenovo\AppData\Local\Temp\opencode\boot-stack.mjs
cd "C:\Users\Lenovo\Desktop\مشروع ساهر\server"
npm test            # 170 pass, SQLite :memory: (unchanged)
```

After the user switches `SUPABASE_DB_URL` to `:6543` (and, if chosen, authorizes the 002
schema realignment), the remaining work is Phase 6: a `test:live` script that creates
`__test_<random>` rows, exercises license/auth/drive repository operations, and cleans up
to exactly 0 in FK order.