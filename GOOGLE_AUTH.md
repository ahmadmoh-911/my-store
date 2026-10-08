# Store Hub — Google Authentication Foundation

## Overview

This document describes the Google OAuth 2.0 authentication foundation for Store Hub. It enables users to sign in with their Google account, establishing a stable identity that can later be bound to a Store Hub licence.

**Key principle:** The backend is the *only* place that ever sees the Google Client Secret. The frontend never handles secrets, tokens, or authorization codes directly.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        FRONTEND (browser)                           │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐  │
│  │ auth-client  │───▶│ identity-    │    │ UI (future login     │  │
│  │ .js          │    │ store.js     │    │ screen)              │  │
│  └──────┬───────┘    └──────────────┘    └──────────────────────┘  │
│         │                                                ▲         │
│         │ fetch (credentials: include)                   │         │
│         ▼                                                │         │
│  ┌──────────────────────────────────────────────────────┐         │
│  │            Service Worker (offline cache)            │         │
│  └──────────────────────────────────────────────────────┘         │
└────────────────────────────────┬──────────────────────────────────┘
                                 │ HTTPS
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         BACKEND (Node.js)                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌───────────┐  │
│  │ http.js     │◀─│ auth-service│◀─│ auth-repo   │◀─│PostgreSQL │  │
│  │ (routes)    │  │ .js         │  │ .js         │  │ (hosted   │  │
│  └─────────────┘  └─────────────┘  └─────────────┘  │ Supabase) │  │
│         │                │                │           └───────────┘  │
│         │                │                │                          │
│         ▼                ▼                ▼                          │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                    Google OAuth 2.0                          │    │
│  │  accounts.google.com  ──▶  oauth2.googleapis.com             │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Start Auth** — Frontend calls `GET /api/auth/google/start` → Backend returns Google authorization URL with PKCE challenge → Frontend redirects user.
2. **User Consents** — Google prompts user → Redirects to `GOOGLE_REDIRECT_URI` with `code` and `state`.
3. **Callback** — Frontend callback page calls `GET /api/auth/me` → Backend exchanges code for tokens (using PKCE verifier), fetches user info, upserts account, creates session, sets HttpOnly cookie → Returns account info.
4. **Session** — Frontend stores account info in `identity-store` (IndexedDB) → Subsequent calls to `/api/auth/me` use HttpOnly cookie.
5. **Licence Binding** — Future phase: licence `bind` endpoint uses `googleSub` as `accountId`.

---

## Required Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 Client ID (Web application type) | Yes (prod) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 Client Secret | Yes (prod) |
| `GOOGLE_AUTH_REDIRECT_URI` | Customer sign-in callback (must match Google Cloud console) | Yes (prod) |
| `GOOGLE_ADMIN_REDIRECT_URI` | Admin portal callback (must match Google Cloud console) | Yes (prod) |
| `GOOGLE_DRIVE_REDIRECT_URI` | Drive connect callback (must match Google Cloud console) | Yes (prod) |
| `GOOGLE_REDIRECT_URI` | **Compatibility fallback** — used in development when per-flow URIs are not set. Must NOT be the only URI in production. | No |
| `STOREHUB_PEPPER` | Secret for hashing codes/sessions (32+ chars) | Yes (prod) |
| `SUPABASE_DB_URL` | PostgreSQL connection string — the only backend since Phase 4 (SQLite removed; the server refuses to start without it) | Yes |
| ~~`STOREHUB_DB`~~ | **Removed in Phase 4** — SQLite file path setting no longer exists | Retired |
| `STOREHUB_SESSION_TTL_MS` | Session lifetime in ms | No (default: 30 days) |
| `STOREHUB_CORS_ORIGINS` | Comma-separated allowed origins | No |
| `NODE_ENV` | `production` or `development` | No (default: development) |

**Never commit actual values.** Use a `.env` file locally (already in `.gitignore`).

---

## Local Development Setup

1. **Create a `.env` file** in the project root:
   ```bash
   GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your-client-secret
   GOOGLE_REDIRECT_URI=http://localhost:8787/api/auth/google/callback
   STOREHUB_PEPPER=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
   NODE_ENV=development
   ```

   > In development the single `GOOGLE_REDIRECT_URI` is accepted as a fallback for all three flows. Production requires all three per-flow variables.

2. **Configure Google Cloud Console:**
   - Go to APIs & Services → Credentials
   - Create or select "Web application" OAuth client
   - Add **all three** redirect URIs to **Authorized redirect URIs**:
     - `http://localhost:8787/api/auth/google/callback` (customer sign-in)
     - `http://localhost:8787/api/admin/auth/callback` (admin portal)
     - `http://localhost:8787/api/drive/connect/callback` (Drive connect)
   - Add `http://localhost:8787` to **Authorized JavaScript origins** (for CORS)

3. **Start the backend:**
   ```bash
   cd server && npm start
   ```

4. **Start the frontend** (served separately, e.g., `npx serve .` or VS Code Live Server)
   - Ensure frontend origin is in `STOREHUB_CORS_ORIGINS` or use the same host/port as the backend.

---

## Production Deployment

1. **Set all environment variables** on the server (no `.env` file in production).
2. **Update Google Cloud Console:**
   - Register **all three** production redirect URIs for the Web application client:
     - `https://api.yourdomain.com/api/auth/google/callback` (customer sign-in)
     - `https://api.yourdomain.com/api/admin/auth/callback` (admin portal)
     - `https://api.yourdomain.com/api/drive/connect/callback` (Drive connect)
   - Add production frontend origin to authorized JavaScript origins.
3. **Ensure HTTPS** — Google requires HTTPS for production redirect URIs (localhost is the only HTTP exception).
4. **Reverse proxy** — If using nginx/Apache, set `STOREHUB_TRUST_PROXY=1` and forward `X-Forwarded-For`.

---

## API Endpoints

### `GET /api/auth/google/start`
Initiates the OAuth flow.

**Response (200):**
```json
{
  "ok": true,
  "authUrl": "https://accounts.google.com/o/oauth2/v2/auth?...",
  "state": "base64url-state",
  "serverTime": 1700000000000
}
```

**Frontend action:** `window.location.href = response.authUrl`

### `GET /api/auth/google/callback`
Google redirects here with `?code=...&state=...`.

**Frontend action:** The callback page should call `GET /api/auth/me` to complete the session and get account info.

### `GET /api/auth/me`
Returns current authenticated account (uses HttpOnly session cookie).

**Response (200, authenticated):**
```json
{
  "ok": true,
  "authenticated": true,
  "account": {
    "googleSub": "123456789012345678901",
    "email": "user@example.com",
    "displayName": "User Name",
    "avatarUrl": "https://lh3.googleusercontent.com/...",
    "createdAt": 1690000000000,
    "lastLoginAt": 1700000000000
  },
  "serverTime": 1700000000000
}
```

**Response (200, not authenticated):**
```json
{
  "ok": true,
  "authenticated": false,
  "account": null,
  "serverTime": 1700000000000
}
```

### `POST /api/auth/logout`
Invalidates the server-side session and clears the cookie.

**Response (200):**
```json
{ "ok": true, "serverTime": 1700000000000 }
```

---

## Security Boundaries

### What the Backend Stores
| Table | Data | Purpose |
|-------|------|---------|
| `auth_accounts` | `google_sub` (PK), `email`, `display_name`, `avatar_url`, `created_at`, `last_login_at` | One row per Google account; `google_sub` is the immutable identifier. |
| `auth_sessions` | `session_lookup` (PK, HMAC), `google_sub`, `created_at`, `expires_at`, `last_used_at`, `user_agent` | Server-side sessions. Token itself is never stored — only its peppered HMAC. |

### What the Backend NEVER Stores
- ❌ Google access tokens or refresh tokens
- ❌ Store Hub business data (products, sales, inventory, invoices, customers, reports, backups)
- ❌ Google Client Secret in any response or log

### What the Frontend Stores (IndexedDB: `storehub_identity`)
| Store | Data |
|-------|------|
| `account` | `googleSub`, `email`, `displayName`, `avatarUrl`, `updatedAt` |
| `authSession` | `expiresAt`, `googleSub`, `email`, `displayName`, `avatarUrl` (no session token — it's HttpOnly) |
| `device` | `installId`, `platform`, `platformBuild` |
| `license` | Licence entitlement cache |
| `meta` | Schema version |

### What the Frontend NEVER Stores
- ❌ Google access/refresh tokens
- ❌ Authorization codes
- ❌ Any store business data in the auth stores

---

## PKCE & State

- **PKCE (RFC 7636)** is mandatory. The backend generates a `code_verifier` (64 bytes base64url) and sends its SHA256 `code_challenge` to Google. The verifier is stored server-side keyed by `state`.
- **State** is a 16-byte random value, stored with the PKCE verifier (10 min TTL). Prevents CSRF on the OAuth flow.
- Both are single-use and consumed on callback.

---

## Session Handling

- Sessions are **server-side only**. The frontend receives an HttpOnly, Secure (in production), SameSite=Lax cookie named `storehub_session`.
- Session TTL: 30 days default (`STOREHUB_SESSION_TTL_MS`).
- Sliding window: `last_used_at` updated on each `/api/auth/me` call.
- Logout revokes the session server-side and clears the cookie.
- `revokeAllSessions(googleSub)` available for admin/security actions.

---

## Licence Compatibility

The existing licence backend uses `accountId` for binding. This auth foundation provides:

- **Stable identifier:** `googleSub` (Google's `sub` claim) — never changes for a Google account.
- **Binding flow (future):** `POST /api/license/bind` with `accountId = googleSub`.
- **One licence → one Google account → one store** — enforced by the licence service (`LICENSE_ALREADY_BOUND`, `ACCOUNT_MISMATCH`).

No changes to the licence service were required in this phase.

---

## Testing

Run backend tests (includes auth tests):

```bash
cd server && node --test test/
```

Test coverage includes:
- OAuth configuration validation
- PKCE generation and verification
- Google callback handling (success, error, missing params)
- Account upsert (stable `sub`, email updates)
- Session creation, resolution, expiry, logout
- Business data never enters auth repository

**Mocking:** Google HTTP calls are mocked in tests — no real credentials needed.

---

## Files Added / Modified

### New Backend Files
- `server/src/auth-repository.js` — Auth port (the runtime adapter is PostgreSQL; the SQLite adapter moved to `server/test/support/sqlite-auth.js` in Phase 4)
- `server/src/auth-service.js` — OAuth flow, session management
- `server/test/auth.test.mjs` — Auth tests (to be created)

### Modified Backend Files
- `server/src/config.js` — Added `google` and `session` config sections
- `server/src/http.js` — Added auth routes, cookie handling, GET support
- `server/src/index.js` — Wired auth repository and service

### New Frontend Files
- `js/auth-client.js` — Frontend auth logic (startAuth, handleCallback, getMe, logout)

### Modified Frontend Files
- `js/identity-store.js` — Added `authSession` store, `saveAuthSession`, `getAuthSession`, `clearAuthSession`, `hasValidAuthSession`
- `sw.js` — BUILD `v15` → `v16`, added `auth-client.js` to PRECACHE

### Documentation
- `GOOGLE_AUTH.md` — This file

---

## Configuration Still Required (Manual)

You must provide these **before the auth endpoints will work**:

1. **Google Cloud Console:**
   - Create OAuth 2.0 Client ID (Web application)
   - Add production redirect URI
   - Add production frontend origin

2. **Server Environment:**
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI`
   - `STOREHUB_PEPPER` (generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)

Without these, the backend starts but `/api/auth/google/start` and `/callback` return `503` configuration errors.