-- Store Hub — Supabase PostgreSQL Schema
-- Version: 001_initial_schema
-- Purpose: Clean PostgreSQL foundation for licensing, auth, admin, and Drive grants.
-- No customer operational data. No Supabase Auth migration (Phase 1 only).
-- Run on a fresh Supabase project with service_role key.

-- =============================================================================
-- EXTENSIONS
-- =============================================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- for gen_random_uuid()

-- =============================================================================
-- TABLE: licenses
-- =============================================================================
-- One licence per row. No store data ever.
-- Status values: 'active', 'suspended', 'revoked'
-- 'expired' is a DERIVED status (status='active' AND expires_at <= now())
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
    linked_account_id   TEXT,                      -- Google sub, FK to auth_accounts
    last_verified_at    TIMESTAMPTZ,               -- last successful verify
    note                TEXT                       -- internal admin note
);

-- Indexes
CREATE INDEX idx_licenses_code_lookup ON licenses (code_lookup);
CREATE INDEX idx_licenses_linked_account ON licenses (linked_account_id) WHERE linked_account_id IS NOT NULL;
CREATE INDEX idx_licenses_status_created ON licenses (status, created_at DESC);

-- =============================================================================
-- TABLE: license_tokens
-- =============================================================================
-- Opaque bearer sessions. Token itself never stored; only peppered HMAC (token_lookup).
-- revoked_at = NULL means active; non-NULL means revoked.
CREATE TABLE license_tokens (
    token_lookup        TEXT PRIMARY KEY,          -- HMAC(token, pepper)
    license_id          UUID NOT NULL REFERENCES licenses(id) ON DELETE RESTRICT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at        TIMESTAMPTZ,
    revoked_at          TIMESTAMPTZ                -- NULL = active
);

-- Indexes
CREATE INDEX idx_license_tokens_license ON license_tokens (license_id);
CREATE INDEX idx_license_tokens_revoked ON license_tokens (revoked_at) WHERE revoked_at IS NOT NULL;

-- =============================================================================
-- TABLE: license_installs
-- =============================================================================
-- Install metadata per licence. Composite PK matches current behavior.
-- No hard device limit; recording a new install must never fail.
CREATE TABLE license_installs (
    license_id          UUID NOT NULL REFERENCES licenses(id) ON DELETE RESTRICT,
    install_id          TEXT NOT NULL,
    platform            TEXT,
    app_version         TEXT,
    first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_verified_at    TIMESTAMPTZ,
    PRIMARY KEY (license_id, install_id)
);

-- Indexes
CREATE INDEX idx_license_installs_license ON license_installs (license_id);

-- =============================================================================
-- TABLE: license_events
-- =============================================================================
-- Append-only audit trail of licence state changes. Metadata only.
CREATE TABLE license_events (
    id                  BIGSERIAL PRIMARY KEY,      -- PostgreSQL identity
    license_id          UUID REFERENCES licenses(id) ON DELETE SET NULL,
    event               TEXT NOT NULL,              -- e.g. 'created', 'activated', 'verified', 'status_suspended'
    at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    install_id          TEXT,
    detail              TEXT
);

-- Indexes
CREATE INDEX idx_license_events_license_time ON license_events (license_id, at DESC);

-- =============================================================================
-- TABLE: auth_accounts
-- =============================================================================
-- One row per Google account. PK = google_sub (stable subject identifier).
-- No OAuth tokens, no PKCE verifiers, no authorization codes stored here.
CREATE TABLE auth_accounts (
    google_sub          TEXT PRIMARY KEY,           -- Google's stable subject id
    email               TEXT NOT NULL,
    display_name        TEXT,
    avatar_url          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- TABLE: auth_sessions
-- =============================================================================
-- Session token never stored; only peppered HMAC (session_lookup).
-- Sliding TTL via last_used_at. Expired sessions cleaned up periodically.
CREATE TABLE auth_sessions (
    session_lookup      TEXT PRIMARY KEY,           -- HMAC(token, pepper)
    google_sub          TEXT NOT NULL REFERENCES auth_accounts(google_sub) ON DELETE RESTRICT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ NOT NULL,
    last_used_at        TIMESTAMPTZ,
    user_agent          TEXT
);

-- Indexes
CREATE INDEX idx_auth_sessions_google_sub ON auth_sessions (google_sub);
CREATE INDEX idx_auth_sessions_expires ON auth_sessions (expires_at);

-- =============================================================================
-- TABLE: drive_grants
-- =============================================================================
-- Encrypted Drive refresh tokens. One per Google account.
-- Encryption: AES-256-GCM keyed by HKDF(pepper). Format: v1.<iv>.<tag>.<ciphertext> (base64url)
-- Access tokens NEVER stored; minted on demand.
CREATE TABLE drive_grants (
    google_sub          TEXT PRIMARY KEY REFERENCES auth_accounts(google_sub) ON DELETE RESTRICT,
    refresh_cipher      TEXT NOT NULL,              -- v1.<iv>.<tag>.<ciphertext> base64url
    scopes              TEXT NOT NULL,              -- verbatim from Google (scope creep detection)
    granted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at          TIMESTAMPTZ                 -- NULL = active
);

-- =============================================================================
-- FOREIGN KEY RELATIONSHIPS (explicit for clarity)
-- =============================================================================
-- licenses.linked_account_id -> auth_accounts.google_sub
--   ON DELETE RESTRICT (prevent deleting account with bound licences)
-- license_tokens.license_id -> licenses.id
--   ON DELETE RESTRICT (prevent deleting licence with active tokens)
-- license_installs.license_id -> licenses.id
--   ON DELETE RESTRICT (prevent deleting licence with install history)
-- license_events.license_id -> licenses.id
--   ON DELETE SET NULL (events survive licence deletion for audit)
-- auth_sessions.google_sub -> auth_accounts.google_sub
--   ON DELETE RESTRICT (prevent deleting account with active sessions)
-- drive_grants.google_sub -> auth_accounts.google_sub
--   ON DELETE RESTRICT (prevent deleting account with Drive grants)

-- Note: All FKs use RESTRICT except license_events which uses SET NULL.
-- This prevents accidental cascading deletion of important licence/account history.

-- =============================================================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================================================
-- All backend tables are PRIVATE. Anon/public role MUST NOT access them.
-- Backend uses SUPABASE_SERVICE_ROLE_KEY (server-side only) which bypasses RLS.

ALTER TABLE licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE license_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE license_installs ENABLE ROW LEVEL SECURITY;
ALTER TABLE license_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE drive_grants ENABLE ROW LEVEL SECURITY;

-- Deny all access for anon/public role
CREATE POLICY "deny_all_anon_licenses" ON licenses FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_anon_license_tokens" ON license_tokens FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_anon_license_installs" ON license_installs FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_anon_license_events" ON license_events FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_anon_auth_accounts" ON auth_accounts FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_anon_auth_sessions" ON auth_sessions FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_anon_drive_grants" ON drive_grants FOR ALL TO anon USING (false) WITH CHECK (false);

-- Also deny for authenticated role (frontend users must not reach these tables directly)
CREATE POLICY "deny_all_auth_licenses" ON licenses FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_auth_license_tokens" ON license_tokens FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_auth_license_installs" ON license_installs FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_auth_license_events" ON license_events FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_auth_auth_accounts" ON auth_accounts FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_auth_auth_sessions" ON auth_sessions FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_auth_drive_grants" ON drive_grants FOR ALL TO authenticated USING (false) WITH CHECK (false);

-- Service role (backend) bypasses RLS automatically — no policy needed.

-- =============================================================================
-- VALIDATION HELPERS (for manual verification)
-- =============================================================================
-- These are not part of the schema but useful for smoke-testing after migration.

-- Check all tables exist
-- SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;

-- Check columns
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'licenses'
-- ORDER BY ordinal_position;

-- Check constraints
-- SELECT conname, contype, pg_get_constraintdef(oid)
-- FROM pg_constraint WHERE conrelid = 'licenses'::regclass;

-- Check indexes
-- SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname;

-- Check RLS
-- SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;

-- Check policies
-- SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual
-- FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname;

-- =============================================================================
-- END OF MIGRATION
-- =============================================================================