-- Store Hub — Supabase PostgreSQL Schema (Phase 1)
-- Version: 001_initial_schema
-- Purpose: Clean PostgreSQL foundation for backend metadata only.
-- No customer operational data. No Supabase Auth migration.
-- Designed from current Store Hub backend requirements.

-- =============================================================================
-- EXTENSIONS
-- =============================================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- for gen_random_uuid()

-- =============================================================================
-- TABLE: google_accounts
-- =============================================================================
-- One row per Google account. PK = google_sub (stable subject identifier).
-- No OAuth tokens, no PKCE verifiers, no authorization codes stored here.
CREATE TABLE google_accounts (
    google_sub          TEXT PRIMARY KEY,           -- Google's stable subject id
    email               TEXT NOT NULL,
    display_name        TEXT,
    avatar_url          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- TABLE: licenses
-- =============================================================================
-- One licence per row. No store data ever.
-- Status values: 'active', 'suspended', 'revoked'
-- 'expired' is a DERIVED status (status='active' AND expires_at <= now())
-- 'offline_grace', 'account_mismatch', etc. are derived runtime states, NOT stored.
CREATE TABLE licenses (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code_lookup         TEXT NOT NULL UNIQUE,      -- HMAC(keyed by pepper), unique index
    code_salt           TEXT NOT NULL,             -- per-licence scrypt salt
    code_hash           TEXT NOT NULL,             -- scrypt verifier
    status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'suspended', 'revoked')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    activated_at        TIMESTAMPTZ,               -- first successful activation
    expires_at          TIMESTAMPTZ,               -- null = perpetual
    owner_google_sub    TEXT NOT NULL REFERENCES google_accounts(google_sub) ON DELETE RESTRICT,
    last_verified_at    TIMESTAMPTZ,               -- last successful verify
    admin_note          TEXT                       -- internal admin note
);

-- Indexes
CREATE INDEX idx_licenses_owner ON licenses (owner_google_sub);
CREATE INDEX idx_licenses_status_created ON licenses (status, created_at DESC);

-- =============================================================================
-- TABLE: license_tokens
-- =============================================================================
-- Opaque bearer sessions. Token itself never stored; only peppered HMAC (token_lookup).
-- revoked_at = NULL means active; non-NULL means revoked.
CREATE TABLE license_tokens (
    token_lookup        TEXT PRIMARY KEY,           -- HMAC(token, pepper)
    license_id          UUID NOT NULL REFERENCES licenses(id) ON DELETE RESTRICT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at        TIMESTAMPTZ,
    revoked_at          TIMESTAMPTZ                -- NULL = active
);

-- Indexes
CREATE INDEX idx_license_tokens_license ON license_tokens (license_id);
CREATE INDEX idx_license_tokens_revoked ON license_tokens (revoked_at) WHERE revoked_at IS NOT NULL;

-- =============================================================================
-- TABLE: license_installations
-- =============================================================================
-- Install metadata per licence. Composite PK matches current behavior.
-- No hard device limit; recording a new install must never fail.
CREATE TABLE license_installations (
    license_id          UUID NOT NULL REFERENCES licenses(id) ON DELETE RESTRICT,
    installation_id     TEXT NOT NULL,
    platform            TEXT,
    app_version         TEXT,
    first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_verified_at    TIMESTAMPTZ,
    PRIMARY KEY (license_id, installation_id)
);

-- Indexes
-- No index on license_id alone; PRIMARY KEY (license_id, installation_id) covers prefix queries.

-- =============================================================================
-- TABLE: license_events
-- =============================================================================
-- Append-only audit trail of licence state changes. Metadata only.
CREATE TABLE license_events (
    id                  BIGSERIAL PRIMARY KEY,      -- PostgreSQL identity
    license_id          UUID REFERENCES licenses(id) ON DELETE SET NULL,
    event_type          TEXT NOT NULL,              -- e.g. 'created', 'activated', 'verified', 'status_suspended'
    occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    installation_id     TEXT,
    detail              TEXT
);

-- Indexes
CREATE INDEX idx_license_events_license_time ON license_events (license_id, occurred_at DESC);

-- =============================================================================
-- TABLE: login_sessions
-- =============================================================================
-- Session token never stored; only peppered HMAC (session_lookup).
-- Sliding TTL via last_used_at. Expired sessions cleaned up periodically.
CREATE TABLE login_sessions (
    session_lookup      TEXT PRIMARY KEY,           -- HMAC(token, pepper)
    google_sub          TEXT NOT NULL REFERENCES google_accounts(google_sub) ON DELETE RESTRICT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ NOT NULL,
    last_used_at        TIMESTAMPTZ,
    user_agent          TEXT
);

-- Indexes
CREATE INDEX idx_login_sessions_google_sub ON login_sessions (google_sub);
CREATE INDEX idx_login_sessions_expires ON login_sessions (expires_at);

-- =============================================================================
-- TABLE: drive_grants
-- =============================================================================
-- Encrypted Drive refresh tokens. One per Google account.
-- Encryption: AES-256-GCM keyed by HKDF(pepper). Format: v1.<iv>.<tag>.<ciphertext> (base64url)
-- Access tokens NEVER stored; minted on demand.
CREATE TABLE drive_grants (
    google_sub          TEXT PRIMARY KEY REFERENCES google_accounts(google_sub) ON DELETE RESTRICT,
    refresh_cipher      TEXT NOT NULL,              -- v1.<iv>.<tag>.<ciphertext> base64url
    scopes              TEXT NOT NULL,              -- verbatim from Google (scope creep detection)
    granted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at          TIMESTAMPTZ                 -- NULL = active
);

-- =============================================================================
-- RELATIONSHIPS (explicit for clarity)
-- =============================================================================
-- licenses.owner_google_sub -> google_accounts.google_sub
--   ON DELETE RESTRICT (prevent deleting account with owned licences)
-- license_tokens.license_id -> licenses.id
--   ON DELETE RESTRICT (prevent deleting licence with active tokens)
-- license_installations.license_id -> licenses.id
--   ON DELETE RESTRICT (prevent deleting licence with installation history)
-- license_events.license_id -> licenses.id
--   ON DELETE SET NULL (events survive licence deletion for audit)
-- login_sessions.google_sub -> google_accounts.google_sub
--   ON DELETE RESTRICT (prevent deleting account with active sessions)
-- drive_grants.google_sub -> google_accounts.google_sub
--   ON DELETE RESTRICT (prevent deleting account with Drive grants)

-- Note: All FKs use RESTRICT except license_events which uses SET NULL.
-- This prevents accidental cascading deletion of important licence/account history.

-- =============================================================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================================================
-- All backend tables are PRIVATE. Anon/public role MUST NOT access them.
-- Backend uses SUPABASE_SERVICE_ROLE_KEY (server-side only) which bypasses RLS.

ALTER TABLE google_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE license_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE license_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE license_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE drive_grants ENABLE ROW LEVEL SECURITY;

-- Deny all access for anon/public role
CREATE POLICY "deny_all_anon_google_accounts" ON google_accounts FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_anon_licenses" ON licenses FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_anon_license_tokens" ON license_tokens FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_anon_license_installations" ON license_installations FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_anon_license_events" ON license_events FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_anon_login_sessions" ON login_sessions FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_anon_drive_grants" ON drive_grants FOR ALL TO anon USING (false) WITH CHECK (false);

-- Also deny for authenticated role (frontend users must not reach these tables directly)
CREATE POLICY "deny_all_auth_google_accounts" ON google_accounts FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_auth_licenses" ON licenses FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_auth_license_tokens" ON license_tokens FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_auth_license_installations" ON license_installations FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_auth_license_events" ON license_events FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_auth_login_sessions" ON login_sessions FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_auth_drive_grants" ON drive_grants FOR ALL TO authenticated USING (false) WITH CHECK (false);

-- Service role (backend) bypasses RLS automatically — no policy needed.

-- =============================================================================
-- END OF MIGRATION
-- =============================================================================