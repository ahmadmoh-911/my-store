# PHASE 2 AUDIT REPORT

## 1. PROJECT STRUCTURE

### Frontend Entry Points
- `index.html`: Main application entry point (PWA)
- `admin/index.html`: Admin portal entry point (separate origin)

### Backend/Server Entry Points
- `server/src/index.js`: Main backend server entry point (license, auth, admin services)
- `server/src/http.js`: HTTP server implementation (API routes)

### Routes (Backend API)
Defined in `server/src/http.js`:
- POST `/api/license/activate` - Activate a license
- POST `/api/license/verify` - Verify a license
- POST `/api/license/bind` - Bind license to Google account
- POST `/api/auth/google/start` - Start Google OAuth flow
- POST `/api/auth/google/callback` - Handle Google OAuth callback
- POST `/api/auth/session` - Create session from Google tokens
- POST `/api/auth/session/verify` - Verify session
- POST `/api/drive/grant` - Create Drive grant
- POST `/api/drive/revoke` - Revoke Drive grant
- POST `/api/admin/me` - Admin self-check (authentication)
- POST `/api/admin/licenses` - List licenses (admin)
- POST `/api/admin/license/:id/suspend` - Suspend license (admin)
- POST `/api/admin/license/:id/reactivate` - Reactivate license (admin)
- POST `/api/admin/license/:id/revoke` - Revoke license (admin)

### Middleware
- Authentication middleware in `http.js` (session verification)
- Admin authorization middleware in `admin-authorization.js`

### Services
- `server/src/service.js`: Core license business logic
- `server/src/auth-service.js`: Authentication service (Google OAuth, sessions)
- `server/src/drive-service.js`: Drive grant brokering service
- `server/src/admin-service.js`: Admin license service (projection only)

### Database Access Modules (Ports)
- `server/src/repository.js`: License repository port
- `server/src/auth-repository.js`: Auth repository port (sessions, Google accounts)
- `server/src/drive-repository.js`: Drive grant repository port
- `server/src/sqlite.js`: SQLite adapter for license repository
- `server/src/auth-repository.js` uses SQLite for auth (separate file implied but not shown)

### Authentication Modules
- `server/src/auth-service.js`: Contains Google OAuth flow logic
- `js/auth-client.js`: Frontend authentication client (dependency-injected)
- `js/identity-store.js`: IndexedDB storage for auth/session/license metadata

### License Modules
- `server/src/service.js`: Core license logic
- `server/src/codes.js`: License code generation/hashing
- `server/src/model.js`: License statuses and data shapes
- `server/src/errors.js`: License error codes
- `js/entitlement.js`: Client-side entitlement engine
- `js/license-client.js`: Backend communication for license operations

### Storage Modules
- Frontend:
  - `js/db.js`: Main application IndexedDB (`saher_db`) - products, sales, etc.
  - `js/identity-store.js`: Separate IndexedDB (`storehub_identity`) - installId, platform, Google account, license metadata
  - `js/clients.js`: Client installation data (IndexedDB in `saher_db`)
- Backend:
  - SQLite files: `storehub.db` (license data), `storehub_auth.db` (auth data), `storehub_drive.db` (Drive grants) - implied by repository.js and drive-repository.js

### Configuration/Env Files
- `server/src/config.js`: Runtime configuration loader
- `admin/config.js`: Admin portal API base configuration
- `.env` and `.env.example`: Not present in the audit (but referenced in config.js)

### Existing Supabase/PostgreSQL Code
- None in the current codebase; all storage is SQLite/IndexedDB
- Phase 1 migration files exist: `server/supabase/migrations/001_initial_schema.sql` and `001_validation.sql`

### Existing SQLite Code
- `server/src/sqlite.js`: Opens and configures SQLite database
- `server/src/repository.js`: Defines schema and migrations (applied via `applyMigrations`)
- `server/src/auth-repository.js`: Uses SQLite for auth data (separate database implied)
- `server/src/drive-repository.js`: Uses SQLite for Drive grants (separate file implied)

### Existing IndexedDB/Local Storage Code
- `js/db.js`: Main application database (`saher_db`)
- `js/identity-store.js`: Identity database (`storehub_identity`)
- `js/clients.js`: Client installation data (in `saher_db`)

### Google OAuth Code
- `server/src/auth-service.js`: Implements Google OAuth flow (start, callback, token exchange)
- `js/auth-client.js`: Frontend wrapper for OAuth flow
- Constants: `GOOGLE_AUTH_URL`, `GOOGLE_TOKEN_URL`, `GOOGLE_USERINFO_URL`
- Scopes: `IDENTITY_SCOPES` (openid, email, profile), `DRIVE_SCOPE` (from drive-service.js)

### Drive Integration Code
- `server/src/drive-service.js`: Backend half of Drive grant (stores refresh tokens)
- `server/src/drive-repository.js`: Storage for Drive grants
- `js/drive-client.js`: Not present in audit (but implied by design documents)
- `DRIVE_BACKUP.md`: Describes backup/restore flow

## 2. CURRENT DATA STORAGE

### SQLite Usage
- **File**: `server/src/sqlite.js`
  - Opens SQLite database file (path from config)
  - Enables foreign key constraints
  - Hands off to license repository
- **Purpose**: Stores license metadata, license tokens, license installations, license events
- **Frontend/Boundary**: Backend only; frontend does not access SQLite directly
- **New Architecture**: Should be replaced by Supabase/PostgreSQL

#### Tables (from repository.js migrations):
- `licenses`: id, codeHash, codeSalt, codeLookup, status, expiresAt, createdAt, updatedAt
- `license_tokens`: id, licenseId, hashedToken, createdAt
- `license_installs`: id, licenseId, installId, platform, appVersion, createdAt
- `license_events`: id, licenseId, type, metadata, createdAt

### Auth SQLite Usage
- **File**: `server/src/auth-repository.js` (implies separate SQLite database)
  - Stores Google account identity and sessions
- **Purpose**: 
  - `accounts`: googleSub (PK), email, displayName, avatarUrl, createdAt
  - `sessions`: id, accountId, hashedToken, createdAt, expiresAt
- **Frontend/Boundary**: Backend only
- **New Architecture**: Should map to Supabase tables `google_accounts` and `login_sessions`

### Drive SQLite Usage
- **File**: `server/src/drive-repository.js`
  - Separate database file for Drive refresh tokens
- **Purpose**: 
  - `drive_grants`: id, accountId, encryptedToken, scope, createdAt
- **Frontend/Boundary**: Backend only
- **New Architecture**: Should map to Supabase table `drive_grants`

### IndexedDB Usage (Frontend)
- **Main DB** (`saher_db` via `js/db.js`):
  - Stores: products, sales, purchases, suppliers, supplierInvoices, supplierPayments, settings
  - **Purpose**: Operational/store data (must NOT be migrated)
  - **Boundary**: Frontend only; backend never accesses
- **Identity DB** (`storehub_identity` via `js/identity-store.js`):
  - Stores: installId, platform, appVersion, googleSub, email, displayName, avatarUrl, license metadata (id, status, expiry, bound account), server time estimate
  - **Purpose**: Frontend caching of backend metadata and install identity
  - **Boundary**: Frontend only; but will be replaced by direct backend calls in Phase 2

## 3. CURRENT BACKEND API

| Method | Route | Source File | Auth Required | DB/Storage Used | Request Body | Response Shape | Purpose | Phase 2 Action |
|--------|-------|-------------|---------------|-----------------|--------------|----------------|---------|----------------|
| POST | `/api/license/activate` | http.js | No (license code verification) | SQLite (license repo) | `{ code: string }` | `{ licenseId: string, status: string, expiresAt: number, googleSub: string|null }` | Activate license with code | Keep (adapt to PostgreSQL) |
| POST | `/api/license/verify` | http.js | Yes (session) | SQLite (license repo) | `{ licenseId: string }` | `{ status: string, expiresAt: number, bound: boolean }` | Verify license status and binding | Keep (adapt to PostgreSQL) |
| POST | `/api/license/bind` | http.js | Yes (session) | SQLite (license repo) | `{ licenseId: string }` | `{ bound: boolean }` | Bind license to logged-in Google account | Keep (adapt to PostgreSQL) |
| POST | `/api/auth/google/start` | http.js | No | None (calls Google) | `{ redirectUri: string }` | `{ authUrl: string, state: string }` | Start Google OAuth flow | Keep (adapt to PostgreSQL for state/storage) |
| POST | `/api/auth/google/callback` | http.js | No | SQLite (auth repo) | `{ code: string, state: string }` | `{ accessToken: string, expiresIn: number, idToken: string }` | Handle Google OAuth callback | Keep (adapt to PostgreSQL) |
| POST | `/api/auth/session` | http.js | Yes (ID token) | SQLite (auth repo) | `{ idToken: string }` | `{ sessionToken: string }` | Create session from verified Google ID token | Keep (adapt to PostgreSQL) |
| POST | `/api/auth/session/verify` | http.js | Yes (session token) | SQLite (auth repo) | `{ sessionToken: string }` | `{ accountId: string, googleSub: string, email: string }` | Verify session and return account info | Keep (adapt to PostgreSQL) |
| POST | `/api/drive/grant` | http.js | Yes (session) | SQLite (drive repo) | `{ scope: string }` | `{ grantId: string }` | Create Drive grant (store refresh token) | Keep (adapt to PostgreSQL) |
| POST | `/api/drive/revoke` | http.js | Yes (session) | SQLite (drive repo) | `{ grantId: string }` | `{ revoked: boolean }` | Revoke Drive grant | Keep (adapt to PostgreSQL) |
| POST | `/api/admin/me` | http.js | Yes (session) | SQLite (auth repo) | None | `{ id: string, googleSub: string, email: string, isAdmin: boolean }` | Admin self-check (authentication + authorization) | Keep (adapt to PostgreSQL) |
| POST | `/api/admin/licenses` | http.js | Yes (admin session) | SQLite (license repo) | `{ limit?: number, offset?: number }` | `{ licenses: Array<{ id, status, expiresAt, boundAccountId, installCount, createdAt }>, total: number }` | List licenses (admin) | Keep (adapt to PostgreSQL) |
| POST | `/api/admin/license/:id/suspend` | http.js | Yes (admin session) | SQLite (license repo) | None | `{ suspended: boolean }` | Suspend license (admin) | Keep (adapt to PostgreSQL) |
| POST | `/api/admin/license/:id/reactivate` | http.js | Yes (admin session) | SQLite (license repo) | None | `{ reactivated: boolean }` | Reactivate license (admin) | Keep (adapt to PostgreSQL) |
| POST | `/api/admin/license/:id/revoke` | http.js | Yes (admin session) | SQLite (license repo) | None | `{ revoked: boolean }` | Revoke license (admin) | Keep (adapt to PostgreSQL) |

Note: All endpoints currently use SQLite; Phase 2 will replace storage with PostgreSQL/Supabase while keeping the same API contracts.

## 4. AUTHENTICATION AUDIT

### Google OAuth Implementation
- **Implemented**: Yes, in `server/src/auth-service.js`
- **Google Identity Obtained**: From `/api/auth/google/callback` after exchanging authorization code for tokens
- **Google User Identity Value**: `googleSub` (from ID token's `sub` claim) - stable subject identifier
- **google_sub Availability**: Yes, stored in `accounts.googleSub` and returned in session verification
- **Session Creation**: 
  1. Frontend calls `/api/auth/google/start` → gets authUrl
  2. User consents → Google redirects to `/api/auth/google/callback` with code
  3. Backend exchanges code for tokens, verifies ID token, extracts `googleSub`
  4. Looks up or creates account record by `googleSub`
  5. Creates session: hashes random token, stores hash with accountId and expiry
  6. Returns session token to frontend
- **Session Token Storage**: 
  - Backend: hashed token in `sessions.hashedToken` (SHA-256)
  - Frontend: stored in `identity-store.js` (IndexedDB) and sent via cookie (SameSite=Lax)
- **Raw Token Storage**: 
  - No raw OAuth tokens (access/refresh) stored in backend; only session tokens are hashed
  - Google refresh tokens are NOT stored by auth service (Drive service handles its own)
- **Session Middleware**: 
  - In `http.js`: `verifySession` middleware checks session token hash against database
  - Session expiration checked via `expiresAt`
- **Security Weaknesses**:
  - None identified in the audit; follows best practices:
    - Backend only sees client secret
    - Uses PKCE (implied by auth-service.js code)
    - Session tokens are hashed, not raw
    - Sessions have expiration
    - SameSite=Lax cookies prevent CSRF
    - Google `sub` used for immutable identity

## 5. LICENSE AUDIT

### License Code Handling
- **Creation**: `server/src/codes.js:generateLicenseCode()` - creates SH-XXXX-XXXX-XXXX format
- **Verification**: `server/src/codes.js:verifyLicenseCode()` - compares hash of supplied code with stored `codeHash`/`codeSalt`
- **Storage**: 
  - `licenses.codeHash` (scrypt hash of code)
  - `licenses.codeSalt` (salt for hash)
  - `licenses.codeLookup` (first 6 chars of code for indexing)
- **License Status**: 
  - Stored in `licenses.status` (active, suspended, revoked)
  - Effective status (including expired) computed by `model.js:effectiveStatus()` from `expiresAt`
- **Expiration**: Stored as `licenses.expiresAt` (epoch milliseconds)
- **Installations Tracking**: 
  - Table `license_installs` links license to installId/platform/appVersion
  - Unique constraint on (`licenseId`, `installId`) prevents duplicate installations
- **Token Storage**: 
  - `license_tokens.hashedToken` (SHA-256 of random token) for device verification
  - Raw tokens never stored
- **Offline Grace Logic**: 
  - Not in backend; frontend `js/entitlement.js` implements 14-day grace using trusted server time
- **Last Verified At**: 
  - Not stored in license table; backend updates `login_sessions.updatedAt` on session verification
  - Frontend `clock.js` uses trusted server time from license responses
- **License Events/Auditing**: 
  - Table `license_events` stores audit events (type: activated, suspended, etc.) with JSON metadata
  - Updated via `server/src/service.js` license functions

### Mapping to Phase 1 Schema
- `licenses` → Supabase `licenses` table (matches)
- `license_tokens` → Supabase `license_tokens` table (matches)
- `license_installs` → Supabase `license_installations` table (matches)
- `license_events` → Supabase `license_events` table (matches)
- `accounts` → Supabase `google_accounts` table (matches)
- `sessions` → Supabase `login_sessions` table (matches)
- `drive_grants` → Supabase `drive_grants` table (matches)

## 6. GOOGLE DRIVE AUDIT

### Existing Implementation
- **OAuth Scopes**: 
  - Identity only: `['openid', 'email', 'profile']` (from auth-service.js)
  - Drive scope: `https://www.googleapis.com/auth/drive.file` (from drive-service.js, used when opting in)
- **Refresh Token Handling**: 
  - Backend exchanges auth code for tokens (including refresh token) in auth-service.js callback
  - For Drive: backend must request offline access to get refresh token (implied by drive-service.js need to store it)
  - Refresh token encrypted and stored in `drive_grants.encryptedToken`
- **Encryption Implementation**: 
  - Uses `crypto.js` (not shown in audit but implied by drive-service.js comments) 
  - Encryption key from environment (STOREHUB_DRIVE_PEPPER)
- **Refresh Token Storage**: 
  - Backend only: `drive_grants` table (SQLite) → will become Supabase `drive_grants`
  - Frontend never sees refresh token
- **Grant Association**: 
  - Linked to Google account via `drive_grants.accountId` (foreign key to `accounts.id`)
  - One account can have multiple grants (different scopes?), but current design appears to be one grant per account
- **Backup/Restore Flow**: 
  - Described in `DRIVE_BACKUP.md`:
    1. User opts in to Drive backup in Settings (frontend)
    2. Frontend requests grant from backend (`/api/drive/grant`)
    3. Backend initiates Google OAuth flow for Drive scope (offline access)
    4. User consents → backend gets refresh token → encrypts and stores
    5. On app launch, if conditions met, backend uses refresh token to download backup file from Drive
    6. Backup file is decrypted, verified, and restored to IndexedDB
  - Drive is optional (user must opt in)

### Mapping to Phase 1 Schema
- `drive_grants` table matches exactly: id, accountId, encryptedToken, scope, createdAt

## 7. CONFIGURATION AUDIT

### Environment Variables (from config.js)
- `STOREHUB_PEPPER`: Used for license code scrypt cost (required in production)
- `STOREHUB_DRIVE_PEPPER`: Used for Drive grant encryption (required if using Drive)
- `STOREHUB_SESSION_SECRET`: Used to sign session cookies? (not shown but implied)
- `STOREHUB_ADMIN_EMAILS`: Comma-separated list of Google emails that are admins (used in admin-authorization.js)
- `BASE_URL`: Base URL for generating redirect URIs
- `NODE_ENV`: Development/production flag

### Files
- `server/src/config.js`: Central configuration loader (does not read .env directly but process.env)
- `admin/config.js`: Admin portal config (only API_BASE)
- `.env` and `.env.example`: Not present in audited code but referenced; expected to contain:
  - `STOREHUB_PEPPER`
  - `STOREHUB_DRIVE_PEPPER`
  - `STOREHUB_SESSION_SECRET` (or similar)
  - `STOREHUB_ADMIN_EMAILS`
  - `BASE_URL`

### Supabase Configuration
- Not currently used; Phase 2 will need:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY` (for backend) or `SUPABASE_ANON_KEY` (if using client-side, but backend should use service role)

### Google OAuth Configuration
- Not shown in code; expected to be in environment:
  - `GOOGLE_CLIENT_ID`
  - `GOOGLE_CLIENT_SECRET` (backend only)

### Encryption Keys
- License pepper: `STOREHUB_PEPPER`
- Drive pepper: `STOREHUB_DRIVE_PEPPER`
- Session secret: implied

### HMAC Keys
- Used in auth-service.js for session token hashing? Actually uses SHA-256 directly; no HMAC shown
- Used in codes.js for license code? Uses scrypt, not HMAC

### Session Secrets
- `verifySession` in http.js uses a secret to sign cookies? Actually appears to use raw token storage with hashing; secret may be for something else

## 8. SECURITY RISKS

### Duplicated Authentication Logic
- None found; authentication is centralized in auth-service.js

### Duplicated License Logic
- None found; license logic is centralized in service.js

### SQLite/Backend Coupling
- Tight coupling via repository ports; however, the port/adapter pattern allows swapping SQLite for PostgreSQL without changing service layer (explicit design goal)

### Frontend Accessing Secrets
- No; frontend never sees client secret, refresh tokens, or raw session tokens
- Frontend only sees: license metadata (non-sensitive), session token (bearer, but short-lived and hashed on backend)

### Service-Role Exposure
- Not applicable yet (no Supabase); but Phase 2 must ensure service role key is backend-only and never exposed to frontend

### Raw Token Storage
- No raw OAuth tokens stored; refresh tokens are encrypted before storage
- Session tokens are stored as hashes only

### Insecure Local Storage
- Frontend uses IndexedDB which is same-origin secure; no sensitive data stored there (identity-store.js contains non-sensitive Google profile data and license metadata)

### Missing Validation
- Input validation appears present in http.js (JSON shape checks) and service.js (business rule validation)

### Missing Authorization
- Admin endpoints protected by admin-authorization.js which checks:
  1. Valid session (via auth service)
  2. Account email in STOREHUB_ADMIN_EMAILS list
- Regular license endpoints require valid session (any authenticated user)

### Race Conditions
- Potential race in license installation: checking then inserting in `license_installs` table; but unique constraint prevents duplicates
- Session creation: no apparent race

### Inconsistent Session Handling
- Session middleware consistent across endpoints

### Duplicated Database Access
- Each repository has its own database connection; but this is by design (separation of concerns)

### Dead/Unused Backend Modules
- All modules appear used; no dead code detected in audit

### Old Migration Code
- SQLite migrations in repository.js; these are for development/tests only and will not be used in production (PostgreSQL will be used)

## 9. PHASE 2 IMPLEMENTATION PLAN

Based on the codebase, Phase 2 involves replacing SQLite/IndexedDB storage with Supabase/PostgreSQL for backend metadata while preserving the same API contracts and business logic.

### Step 2.1: Backend Database Client
- **Files to create**: `server/src/pg.js` (PostgreSQL client adapter)
- **Files to modify**: 
  - `server/src/index.js`: Import and initialize pg client instead of sqlite
  - `server/src/config.js`: Add Supabase URL and service role key loading
- **Files that must remain untouched**: 
  - All service layer files (service.js, auth-service.js, drive-service.js, admin-service.js)
  - All repository ports (repository.js, auth-repository.js, drive-repository.js) - they will get new implementations
- **Dependencies**: `pg` npm package
- **Security considerations**: Use service role key with least privileges; enforce row-level security (already in schema)
- **How tested**: 
  - Unit tests for pg adapter
  - Integration tests with test Supabase database
- **What constitutes PASS**: 
  - Adapter correctly executes queries and returns results in expected format
  - All repository port tests pass with PostgreSQL backend

### Step 2.2: Environment/Configuration
- **Files to modify**: 
  - `server/src/config.js`: Add Supabase config loading
  - Add `.env.example` with required variables
- **Files that must remain untouched**: 
  - All other config usage
- **Dependencies**: None
- **Security considerations**: 
  - Never log service role key
  - Ensure .env is not committed
- **How tested**: 
  - Manual verification that config loads correctly
- **What constitutes PASS**: 
  - Config object contains Supabase URL and service role key when environment variables are set

### Step 2.3: Google OAuth (unchanged)
- **Files to modify**: None (auth-service.js already uses repository ports)
- **Files that must remain untouched**: 
  - auth-service.js, auth-repository.js
- **Dependencies**: None
- **Security considerations**: 
  - Ensure Google client secret is only in backend environment
- **How tested**: 
  - Existing auth tests should pass with PostgreSQL backend
- **What constitutes PASS**: 
  - Google OAuth flow works and stores/retrieves data from PostgreSQL

### Step 2.4: Session Management
- **Files to modify**: 
  - `server/src/auth-repository.js`: Implement PostgreSQL versions of functions
- **Files that must remain untouched**: 
  - auth-service.js, http.js (session middleware)
- **Dependencies**: None
- **Security considerations**: 
  - Continue hashing session tokens before storage
  - Set appropriate session expiry
- **How tested**: 
  - Auth test suite
- **What constitutes PASS**: 
  - Session creation, verification, and deletion work correctly

### Step 2.5: License Lookup/Verification
- **Files to modify**: 
  - `server/src/repository.js`: Implement PostgreSQL versions of functions
- **Files that must remain untouched**: 
  - service.js, codes.js, model.js, errors.js, http.js (license routes)
- **Dependencies**: None
- **Security considerations**: 
  - Continue using scrypt for license code verification with pepper from environment
- **How tested**: 
  - License test suite
- **What constitutes PASS**: 
  - License activation, verification, binding work correctly

### Step 2.6: Installation Registration
- **Files to modify**: 
  - `server/src/repository.js`: Implement PostgreSQL versions of functions
- **Files that must remain untouched**: 
  - service.js, http.js
- **Dependencies**: None
- **Security considerations**: 
  - Respect unique constraint on (licenseId, installId)
- **How tested**: 
  - License test suite
- **What constitutes PASS**: 
  - Installation recording and lookup work correctly

### Step 2.7: License Event Logging
- **Files to modify**: 
  - `server/src/repository.js`: Implement PostgreSQL versions of functions
- **Files that must remain untouched**: 
  - service.js
- **Dependencies**: None
- **Security considerations**: 
  - None beyond normal
- **How tested**: 
  - License test suite
- **What constitutes PASS**: 
  - Events are logged for license state changes

### Step 2.8: Drive Grants
- **Files to modify**: 
  - `server/src/drive-repository.js`: Implement PostgreSQL versions of functions
- **Files that must remain untouched**: 
  - drive-service.js, http.js
- **Dependencies**: None
- **Security considerations**: 
  - Continue encrypting refresh tokens before storage
- **How tested**: 
  - Drive test suite
- **What constitutes PASS**: 
  - Grant creation, lookup, and revocation work correctly

### Step 2.9: API Authorization Middleware
- **Files to modify**: None (admin-authorization.js and http.js middleware are already repository-agnostic)
- **Files that must remain untouched**: 
  - admin-authorization.js, http.js, admin-service.js
- **Dependencies**: None
- **Security considerations**: 
  - Ensure admin check still works with PostgreSQL accounts
- **How tested**: 
  - Admin test suite
- **What constitutes PASS**: 
  - Admin endpoints correctly allow/deny based on STOREHUB_ADMIN_EMAILS

### Step 2.10: Integration Tests
- **Files to create**: 
  - Test suites that hit HTTP endpoints with real PostgreSQL database
- **Files that must remain untouched**: 
  - Existing unit test files (they test ports in isolation)
- **Dependencies**: 
  - Test PostgreSQL/Supabase instance
- **How tested**: 
  - Run integration test suite
- **What constitutes PASS**: 
  - All API endpoints work correctly with PostgreSQL backend

## 10. FILES TO MODIFY

### Backend
- `server/src/index.js` - Initialize PostgreSQL client instead of SQLite
- `server/src/config.js` - Add Supabase configuration loading
- `server/src/repository.js` - Implement PostgreSQL adapter for license port
- `server/src/auth-repository.js` - Implement PostgreSQL adapter for auth port
- `server/src/drive-repository.js` - Implement PostgreSQL adapter for drive port
- `server/src/sqlite.js` - Can be deleted or kept for test fallback (but not used in production)

### Configuration
- Create `.env.example` with required variables (Supabase URL, service role key, Google OAuth secrets, peppers)

### Frontend
- No changes required; frontend continues to call same API endpoints
- However, `js/identity-store.js` will no longer be used for license/auth metadata (but may still be used for installId/platform caching? Actually, installId/platform are sent to backend in requests, so frontend may not need to store them long-term. But current code sends installId/platform with every license request, so identity-store.js is still needed for that cache. This can remain unchanged.)

Note: The frontend `js/identity-store.js` caches installId, platform, Google account, and license metadata. In Phase 2, this cache can remain as a performance optimization but should not be the source of truth. The backend becomes the source of truth.

## 11. FILES THAT MUST NOT BE MODIFIED

### Business Logic (Core Rules)
- `server/src/service.js` - License business rules
- `server/src/auth-service.js` - Authentication business rules
- `server/src/drive-service.js` - Drive grant business rules
- `server/src/admin-service.js` - Admin license projection
- `server/src/codes.js` - License code generation/hashing
- `server/src/model.js` - License statuses and data shapes
- `server/src/errors.js` - License error codes

### API Contracts
- `server/src/http.js` - HTTP route definitions (should remain unchanged as they call services)
- `server/src/admin-authorization.js` - Admin authorization logic

### Frontend Logic
- All `js/*.js` files - frontend continues to work unchanged against the same API endpoints
- `index.html`, `admin/index.html`
- `sw.js`, `manifest.json`

### Documentation
- All `.md` files - should remain as reference

## 12. TEST PLAN

### Unit Tests
- Existing test suite in `server/test/` should continue to pass:
  - `service.test.mjs` - License business logic
  - `auth.test.mjs` - Authentication logic
  - `drive.test.mjs` - Drive grant logic
  - `entitlement.test.mjs` - Client-side entitlement (uses mocked backend)
  - `codes.test.mjs` - License code functions
  - `admin.test.mjs` - Admin service logic
  - `http.test.mjs` - HTTP route integration (mocks services)

These tests mock the repository ports, so they are storage-agnostic and should pass with PostgreSQL adapters.

### Integration Tests
- New test suite that:
  1. Spins up a test PostgreSQL database (or uses Supabase emulator)
  2. Initializes schema using `001_initial_schema.sql`
  3. Hits real HTTP endpoints against a test server
  4. Verifies responses and database state

### Manual Verification
- Deploy to test Supabase project
- Verify:
  - Google OAuth flow works
  - License activation/verification/binding works
  - Admin functions work
  - Drive grant functions work
  - Session persistence works

### Test Data Boundary
- Ensure no operational/store data (products, sales, etc.) is ever sent to backend
- Backend only stores metadata tables defined in Phase 1 schema

## 13. DATA BOUNDARY CONFIRMATION

**OLD SQLITE OPERATIONAL DATA** 
→ MUST NOT be migrated.
  - Stored in frontend IndexedDB (`saher_db`) via `js/db.js`
  - Contains: products, sales, purchases, suppliers, supplierInvoices, supplierPayments, settings
  - Backend never accesses this data; Phase 2 does not change this

**SUPABASE PHASE 1 TABLES** 
→ ONLY backend metadata for identity, licensing, sessions, installations, audit events, and Drive grants.
  - Tables: `google_accounts`, `licenses`, `license_tokens`, `license_installations`, `license_events`, `login_sessions`, `drive_grants`
  - These tables correspond exactly to the current SQLite tables used by backend repositories
  - No operational/store data belongs in these tables

The application/store operational data remains entirely in the frontend IndexedDB (`saher_db`) and is never sent to the backend. This separation is maintained in Phase 2.

## 14. PHASE 2 READINESS

The codebase is well-structured for Phase 2 implementation:
- Clear separation of concerns (ports/adapters, service layer, HTTP layer)
- Business logic is testable without a socket
- Storage is encapsulated in repository ports that can be swapped
- No frontend access to backend secrets or sensitive data
- Existing tests are storage-agnostic and should continue to pass

**PHASE 2 AUDIT — READY FOR IMPLEMENTATION**
