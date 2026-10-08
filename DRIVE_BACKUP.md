# Google Drive Backup & Restore — Design Document

This document describes Phase 6 of Store Hub: a customer-owned Google Drive backup destination. The Store Hub backend **never receives or stores customer business data** — it only brokers the Google OAuth authorisation.

---

## 1. What this is (and what it is not)

| Property | Decision |
|----------|----------|
| **Backup, not sync** | No background process, no continuous reconciliation. A snapshot runs at most once per week on app launch, only when every gate allows it. |
| **One latest file** | Exactly one file `storehub-backup.json` in the folder `Store Hub Backups`. Each successful backup replaces the previous one *after* the new file is verified. |
| **Complete logical snapshot** | Every IndexedDB store (`products, sales, purchases, suppliers, supplierInvoices, supplierPayments, settings`) is exported, wrapped in a versioned envelope, and uploaded. Not a raw database binary. |
| **Images excluded** | `products[].image`, `settings.logo`, and **any** data URL (`data:image|audio|video/...`) at any depth under any key are stripped. A future `photoDataUrl` field needs no code change. |
| **Backend never sees business data** | The backup JSON is uploaded from the device straight to `googleapis.com`. The Store Hub backend only holds the sealed Drive refresh token; it never handles the payload. |
| **Scope: `drive.file` only** | The app can only see the folder and files it created. The owner's other Drive contents are invisible to Store Hub. |
| **Restore is explicit & atomic** | The user chooses a backup, confirms, and `importAll` replaces the entire shop in one multi-store transaction. No partial restore is possible. |
| **No auto-restore on startup** | Restore is a deliberate user action from Settings. |

---

## 2. File format

```json
{
  "format": "storehub-backup",
  "version": 1,
  "createdAt": "2026-03-01T00:00:00.000Z",
  "appVersion": "1.0.0",
  "media": {
    "included": false,
    "policy": "product images and logos are excluded by design and are not restorable from a backup"
  },
  "counts": { "products": 12, "sales": 34, "purchases": 5, "suppliers": 3, "supplierInvoices": 8, "supplierPayments": 2 },
  "data": {
    "products": [...],
    "sales": [...],
    "purchases": [...],
    "suppliers": [...],
    "supplierInvoices": [...],
    "supplierPayments": [...],
    "settings": { "key": "app", "storeName": "محل ساهر", "openingBalance": 500, "logo": "" }
  }
}
```

- `format` — stable identifier, enables rejection of foreign files.
- `version` — **backup schema version**, distinct from `DB_VERSION`. Bumped only when the *file format* changes.
- `media.included: false` — written into the file so a future reader never has to guess whether images were lost or never included.
- `counts` — shown in Settings before the user confirms a restore.
- `data` — the seven sections, already media-free.

### Versioning & migration

- `BACKUP_VERSION = 1` at launch.
- `MIGRATIONS` registry is an empty hook. When v2 exists, a single entry at key `1` will upgrade v1 → v2.
- A newer version is **refused**, not guessed at. The message tells the user to update the app.
- Legacy bare `exportAll()` files (`{ app: 'saher', ... }`) are accepted and wrapped to the current envelope — one validator serves both the file-import button and Drive restore.

---

## 3. Media exclusion (images)

Two independent rules, so a future field cannot dodge the exclusion by renaming:

1. **By key** (case-insensitive, any depth): `image, images, logo, photo, photos, picture, pictures, avatar, thumbnail, thumbnails, media, attachment, attachments, gallery`
2. **By value**: any string starting with `data:image/`, `data:audio/`, or `data:video/` — whatever the key.

Result: the backup file contains **zero** data URLs. The `settings.logo` field exists but is an empty string. A product's `image` key is absent entirely.

---

## 4. Google Drive — scope & isolation

- **Scope**: `https://www.googleapis.com/auth/drive.file` — the narrowest scope that can create and manage a folder and its files.
- **Folder**: exactly one folder named `Store Hub Backups`. Found by exact name + folder MIME type. If deleted by hand, the app recreates it.
- **File**: exactly one file named `storehub-backup.json`. A weekly replacement uploads a *new* file, verifies it, then deletes the old one.
- **Queries**: every `files.list` call is either:
  - filtered to the exact folder name + MIME type, or
  - scoped to the folder's `id` via `'folder-id' in parents`.
  No user-wide listing, no `corpora=user`, no drive-root enumeration.
- **Verification**: after upload, `files.get` confirms the file exists, is not trashed, and its `size` matches the uploaded bytes. Only then is the previous file deleted.

---

## 5. Authorisation — backend's role

The Store Hub backend is **not on the data path**. It only brokers the OAuth consent that produces a Drive refresh token.

### Token storage

- **Refresh token**: stored in its own PostgreSQL table `drive_grants`, never beside the `licenses` / `auth_accounts` / `auth_sessions` tables (since Phase 4 there is no local SQLite file at all; before that it was a dedicated `storehub_drive` file for the same separation reason). Schema:
  ```sql
  drive_grants(
    google_sub     TEXT PRIMARY KEY,
    refresh_cipher TEXT NOT NULL,   -- sealed with AES-256-GCM
    scopes         TEXT NOT NULL,   -- always 'drive.file'
    granted_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    revoked_at     INTEGER
  )
  ```
  No column can hold business data. No email, display name, or business field.

- **Sealing**: AES-256-GCM, key derived from `STOREHUB_PEPPER` via HKDF (info `storehub/drive-grant/v1`, salt `storehub-drive-grant`). Envelope format: `v1.<iv>.<tag>.<ciphertext>` base64url. A different pepper cannot open it; tampering is rejected.

- **Access tokens**: minted on demand by exchanging the refresh token with Google. Cached **in memory only** for the lifetime of the process — never written to disk. A weekly backup reuses the cached token; no Google round trip per request.

- **No tokens in frontend**: the refresh token never reaches IndexedDB. The local backup record (`identity-store.js` → `backup` store) carries metadata only: `lastSuccessAt`, `fileId`, `folderId`, `bytes`, `formatVersion`, `counts`, `status`, `lastError`. No token field exists and a comment forbids adding one.

### Consent flow

1. User taps **Connect Google Drive** in Settings → `/api/drive/connect/start` → returns a Google OAuth URL with `scope=drive.file` and PKCE.
2. The URL opens in a **same-origin popup**. The callback is `/api/drive/connect/callback` — a fixed page that posts the result to `window.opener` via `postMessage`. No return URL is read from the request (no open redirect).
3. `auth-service.completeAuth` receives the code, exchanges it, and hands the refresh token **directly** to the injected `driveGrantSink` (the Drive service). The token never crosses an HTTP boundary or a response body.
4. `completeAuth` returns `{ driveConnected: true }` — a boolean, never the credential.

### Intent separation

- `startAuth({ intent: 'customer' })` — identity scopes only (`openid email profile`). `drive: true` is ignored.
- `startAuth({ intent: 'drive' })` — requests `drive.file`. Only this flow can leave a grant behind.
- Admin and Drive callbacks refuse foreign intents.

---

## 6. Scheduling — when a backup runs

Trigger: **app launch only**. No timers, no background sync.

Gates (checked in order, cheapest first):

| Gate | Skip reason | Silent? |
|------|-------------|---------|
| `enabled` | `DISABLED` (config `STOREHUB_DRIVE=0`) | yes |
| `running` | `ALREADY_RUNNING` (another tab) | yes |
| `online` | `OFFLINE` (`navigator.onLine === false`) | yes |
| `authenticated` | `NOT_AUTHENTICATED` (no Google session) | yes |
| `entitled` | `NOT_ENTITLED` (licence expired/blocked) | yes |
| `driveConnected` | `DRIVE_NOT_CONNECTED` (no grant) | yes |
| `due` | `NOT_DUE` (< 7 days since last success) | yes |

A **manual** tap of "Back up now" in Settings passes `forced: true` which overrides only the `due` gate — all other gates still apply.

**Failure handling**: a failed backup leaves `lastSuccessAt` untouched, records `status: 'error'` and `lastError`, and retries on the next eligible launch. The local shop is never affected; the previous Drive backup remains restorable.

---

## 7. Restore — safety first

1. User opens Settings → Drive → **Restore** → sees a summary (counts, date, size).
2. User confirms explicitly (no silent auto-restore).
3. `fetchLatestBackup` downloads, parses, validates, strips media again, and returns a **prepared** object — nothing is written yet.
4. `applyRestore(db, prepared)`:
   - Takes a **safety snapshot** via `createBackup` (current shop, in memory only — never uploaded).
   - Delegates to `db.importAll(prepared.legacy)` — a single multi-store transaction. Either every store is replaced or none is.
   - Returns `{ restored, safetySnapshot, counts }`.

A failed/invalid restore **cannot corrupt** the local database: validation runs before any write, and the write is all-or-nothing.

---

## 8. Local metadata — what is stored

In `storehub_identity` (identity DB, version 2 → new `backup` store):

```js
{
  status: 'ok' | 'error' | 'running' | 'never',
  lastSuccessAt: '2026-03-01T00:00:00.000Z' | null,
  lastAttemptAt: '2026-03-01T00:00:00.000Z',
  lastError: '...' | null,
  folderId: '...',
  fileId: '...',
  bytes: 12345,
  formatVersion: 1,
  counts: { products: 12, sales: 34, ... }
}
```

**Never**: access token, refresh token, client secret, or any business data.

---

## 9. Isolation guarantees (tested)

- No Drive route reads a request body (`session: true` guard, no body parsing).
- Posting a full backup envelope at **every** `/api/` endpoint leaves all three databases byte-identical.
- The Drive database (`storehub_drive`) has exactly one table (`drive_grants`) with six columns — none can hold business data.
- The Drive service exposes no method that accepts customer data (`recordGrant`, `getAccessToken`, `disconnect`, `describe`, `isConfigured`, `forgetCachedTokens`, `scope`).
- The client `drive-client.js` builds **only** `googleapis.com` URLs — the backend is never on the upload/download path.
- `backup.js` has zero `fetch` calls and zero Drive imports.

---

## 10. Production configuration (pending)

The following must be set in the server environment before Drive works in production:

| Variable | Purpose |
|----------|---------|
| `GOOGLE_CLIENT_ID` | OAuth client ID from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_DRIVE_REDIRECT_URI` | **Must be** `https://your-domain/api/drive/connect/callback` (exact match, registered for **Web application** in Google Cloud) |
| `GOOGLE_AUTH_REDIRECT_URI` | Customer sign-in: `https://your-domain/api/auth/google/callback` |
| `GOOGLE_ADMIN_REDIRECT_URI` | Admin portal: `https://your-domain/api/admin/auth/callback` |
| `STOREHUB_PEPPER` | ≥32-byte secret for sealing Drive grants (rotate with care — old grants become unreadable) |
| `SUPABASE_DB_URL` | PostgreSQL connection string — the Drive grant lives in the `drive_grants` table (`STOREHUB_DRIVE_DB` was removed in Phase 4 with the SQLite runtime) |
| `STOREHUB_DRIVE_FOLDER` | Optional folder name override (default: `Store Hub Backups`) |
| `STOREHUB_DRIVE=0` | Set to disable the feature entirely |

**Google Cloud project checklist**:
- Drive API enabled.
- OAuth consent screen configured (internal or external).
- `drive.file` scope added to the consent screen.
- **All three redirect URIs registered** for the Web application client.
- Test users added (if external).

---

## 11. Trust model — honest disclosure

| Actor | Can they… |
|-------|-----------|
| **Store Hub backend operator** | Decrypt the Drive refresh token (holds the pepper) and *in principle* reach the customer's Drive folder. But: the backend never receives backup contents, `drive.file` limits access to app-created files, and the customer can revoke at any time from their Google Account → Security → Third-party apps. |
| **Google** | Sees the backup file metadata (name, size, folder) and the OAuth tokens. Does not see the plaintext business data unless the backup file is inspected — the file is customer-owned and encrypted at rest by Google. |
| **Customer** | Owns the Drive folder and file. Can delete, download, or revoke the app's access at any time. The backup file is valid JSON — portable, readable, and restorable by a future app version. |

---

## 12. Future migration compatibility

- `BACKUP_VERSION` is distinct from `DB_VERSION`. Local schema changes (indexes, new columns) do not bump the backup version.
- `MIGRATIONS` registry is the single place to add upgrade logic. A v1 file will still restore on a v3 app because the migrations chain (1→2, 2→3) is explicit.
- New stores added to `saher_db` are **automatically** included in the backup because `BACKUP_SECTIONS` is derived from the live `STORES` enum — a store added later is a one-line change here and cannot be quietly forgotten.
- Media exclusion is by **content**, not just by key name, so a future `photoDataUrl` field is stripped without a code change.

---

## 13. Test coverage (summary)

| Suite | Tests | Key assertions |
|-------|-------|----------------|
| `server/test/drive.test.mjs` | 35 | Grant sealed at rest, `drive.file` scope, no business data in any DB, unauthenticated 401, `DRIVE_NOT_CONNECTED` distinct from `INVALID_SESSION`, cross-intent callback refusal, no body accepted on Drive routes, no token on disk, no hardcoded secrets. |
| `tests/drive-client.test.mjs` | 74 | Every URL → `googleapis.com`, replacement protocol (upload→verify→delete), failed upload keeps previous, failed verification keeps previous, folder search by name+MIME, file listing scoped to parent, no drive-wide queries, access token only. |
| `tests/backup.test.mjs` | 188 | Serialization completeness (live schema), format/version, image exclusion (key + value rules, bare data URLs, cyclic guard), validation (malformed/unsupported version/missing section/invalid record), restore (validated, atomic, safety snapshot, no images), scheduling gates, failure retry, isolation (no backend on path, no tokens in local record). |
| `tests/foundation.test.mjs` | 85 | Pre-existing — identity/shop separation, install ID, clock honesty. |
| **Total** | **382** | All pass. |

---

## 14. Known pre-existing issues (not regressions)

- `js/restock.js` — untouched, pre-existing uncommitted changes.
- `MOBILE_POS_SALE_FIX_REPORT.md` — pre-existing untracked file.
- `dump/` — pre-existing build artefacts.
- `t05-head.mjs`, `t05-verify.mjs`, `t13-mid.mjs` — fail at HEAD with `ReferenceError: section is not defined` (unrelated to Phase 6).
- `js/icons.js` — `icon('cloud')` and `icon('spinner')` are missing; they degrade to empty string + console.warn (used by pre-existing export/import buttons). Not fixed here to avoid scope creep.
- Phase 5: the licence database contains no customer business table; the identity DB stores no OAuth token — both still hold after Phase 6 (Drive grants are in a third database).

---

## 15. Files added / modified in Phase 6

### New files (client)
- `js/backup.js` — envelope, media stripping, validation, restore preparation, safety snapshot.
- `js/drive-client.js` — Drive REST calls (`findBackupFolder`, `ensureBackupFolder`, `listBackupFiles`, `getFileMetadata`, `uploadBackupFile`, `downloadBackupFile`, `deleteBackupFile`, `publishLatestBackup`, `findLatestBackupFile`, `fetchLatestBackup`).
- `js/backup-scheduler.js` — `planBackup`, `performBackup`, `fetchPreparedBackup`, `maybeRunBackup` (weekly gate, silent skips, failure retry).
- `js/drive-auth-client.js` — four `/api/drive/*` calls + `connectDriveInPopup`.
- `tests/backup.test.mjs` — 188 tests against real `db.js` on fake IndexedDB.
- `tests/drive-client.test.mjs` — 74 tests with scripted Drive fake.

### New files (server)
- `server/src/drive-repository.js` — `drive_grants` schema, HKDF key derivation, AES-256-GCM seal/open.
- `server/src/drive-service.js` — token broker, in-memory access-token cache, `DRIVE_SCOPE`.
- `server/test/drive.test.mjs` — 35 backend tests.

### Modified files
- `js/identity-store.js` — `IDENTITY_DB_VERSION=2`, `IDENTITY_STORES.backup`, `saveBackupRecord`/`getBackupRecord`/`clearBackupRecord`, `readIdentitySummary` returns `backup`.
- `js/screens/settings.js` — Drive status group, connect/disconnect/backup/restore actions, refactored `doImport` onto shared `prepareRestore`/`applyRestore`, fixed pre-existing `confirmDialog` import bug.
- `js/main.js` — launch-time `maybeRunBackup` call after entitlement check (non-blocking).
- `sw.js` — `PRECACHE` + `backup.js`, `backup-scheduler.js`, `drive-client.js`, `drive-auth-client.js`; `BUILD` v17 → v18.
- `css/screens.css` — `.drive-status`, `.drive-status__error` (existing design tokens, no redesign).
- `server/src/config.js` — `readDriveConfig(env, memory)`.
- `server/src/errors.js` — `DRIVE_NOT_CONNECTED` (409).
- `server/src/http.js` — 5 Drive routes with `session: true` guard, `driveConsentPage` (postMessage popup).
- `server/src/auth-service.js` — `IDENTITY_SCOPES`, `startAuth({intent, drive})`, `driveGrantSink`, `driveConnected` boolean.
- `server/src/index.js` — async wiring (`openDriveDatabase` → `createDriveService` → `driveGrantSink` into `createAuthService`), returns repositories for testability.
- `server/test/helpers.mjs` — `createTestDriveApp` with in-memory Drive DB and scripted Google fetch.

---

## 16. Commit & verification

```bash
# Stage only Phase 6 files
git add \
  js/backup.js \
  js/drive-client.js \
  js/backup-scheduler.js \
  js/drive-auth-client.js \
  js/identity-store.js \
  js/screens/settings.js \
  js/main.js \
  sw.js \
  css/screens.css \
  server/src/drive-repository.js \
  server/src/drive-service.js \
  server/src/config.js \
  server/src/errors.js \
  server/src/http.js \
  server/src/auth-service.js \
  server/src/index.js \
  server/test/drive.test.mjs \
  server/test/helpers.mjs \
  tests/backup.test.mjs \
  tests/drive-client.test.mjs \
  DRIVE_BACKUP.md

git commit -m "feat: add Google Drive backup and restore foundation"
git push origin main
```

**Verification checklist**:
- [ ] All 382 tests pass (168 server + 85 foundation + 74 drive-client + 188 backup)
- [ ] Syntax check: `node --check` on all modified `.js`/`.mjs` files
- [ ] SW precache: `chk-sw-precache.mjs` reports zero missing/dead entries
- [ ] `git diff` shows only Phase 6 changes (no `js/restock.js`, no `MOBILE_POS_SALE_FIX_REPORT.md`, no `dump/`)
- [ ] Push succeeds, `origin/main` fast-forwards

---

**Commit hash**: (to be filled after push)  
**Push result**: (to be filled after push)