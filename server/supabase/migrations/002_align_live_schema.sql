-- Store Hub — Supabase PostgreSQL schema realignment (002)
-- Version: 002_align_live_schema
-- Purpose: make the live database host the repository contract that the backend
--   actually executes (the repositories in server/src are shared by the SQLite
--   and PostgreSQL paths, so their SQL defines the contract).
--
-- The 001 tables are all EMPTY (verified live: baseline row count 0 on every
-- table) and the application cannot serve its write paths against the 001
-- shape (hard blocker: licenses.owner_google_sub NOT NULL + FK with no honest
-- value at licence creation; plus naming/type drift). This migration therefore
-- rebuilds the empty tables to the repository contract. Authorized explicitly.
--
-- Idempotent: re-running it drops the (empty) contract tables and recreates the
-- same shape.
--
-- 001_initial_schema.sql and 001_validation.sql are never modified.

-- 1. Drop the 001-shaped tables (all empty), children before parents.
DROP TABLE IF EXISTS drive_grants;
DROP TABLE IF EXISTS login_sessions;
DROP TABLE IF EXISTS license_events;
DROP TABLE IF EXISTS license_tokens;
DROP TABLE IF EXISTS license_installations;
DROP TABLE IF EXISTS licenses;
DROP TABLE IF EXISTS google_accounts;

-- 2. Recreate to the repository contract.

-- Licences. TEXT id (the backend supplies a v4 UUID string), epoch-ms BIGINT
-- timestamps, nullable linked_account_id bound after creation. `expired` is a
-- derived status, never stored, so the CHECK covers only the three stored
-- values.
CREATE TABLE licenses (
    id                TEXT PRIMARY KEY,
    code_lookup       TEXT NOT NULL UNIQUE,
    code_salt         TEXT NOT NULL,
    code_hash         TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'suspended', 'revoked')),
    created_at        BIGINT NOT NULL,
    activated_at      BIGINT,
    expires_at        BIGINT,
    linked_account_id TEXT,
    last_verified_at  BIGINT,
    note              TEXT
);

-- Opaque bearer sessions; only the peppered HMAC is stored.
CREATE TABLE license_tokens (
    token_lookup TEXT PRIMARY KEY,
    license_id   TEXT NOT NULL REFERENCES licenses(id) ON DELETE RESTRICT,
    created_at   BIGINT NOT NULL,
    last_used_at BIGINT,
    revoked_at   BIGINT
);
CREATE INDEX IF NOT EXISTS idx_tokens_license ON license_tokens(license_id);

-- Install metadata per licence. No device cap is enforced (deliberate product
-- decision); this table exists for visibility.
CREATE TABLE license_installs (
    license_id       TEXT NOT NULL REFERENCES licenses(id) ON DELETE RESTRICT,
    install_id       TEXT NOT NULL,
    platform         TEXT,
    app_version      TEXT,
    first_seen_at    BIGINT NOT NULL,
    last_seen_at     BIGINT NOT NULL,
    last_verified_at BIGINT,
    PRIMARY KEY (license_id, install_id)
);
CREATE INDEX IF NOT EXISTS idx_installs_license ON license_installs(license_id);

-- Append-only audit trail of licence state changes.
CREATE TABLE license_events (
    id         BIGSERIAL PRIMARY KEY,
    license_id TEXT,
    event      TEXT NOT NULL,
    at         BIGINT NOT NULL,
    install_id TEXT,
    detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_license ON license_events(license_id, at);

-- One row per Google account; PK is the stable subject identifier.
CREATE TABLE auth_accounts (
    google_sub     TEXT PRIMARY KEY,
    email          TEXT NOT NULL,
    display_name   TEXT,
    avatar_url     TEXT,
    created_at     BIGINT NOT NULL,
    last_login_at  BIGINT NOT NULL
);

-- One row per active login session; the token itself is never stored.
CREATE TABLE auth_sessions (
    session_lookup TEXT PRIMARY KEY,
    google_sub     TEXT NOT NULL REFERENCES auth_accounts(google_sub) ON DELETE RESTRICT,
    created_at     BIGINT NOT NULL,
    expires_at     BIGINT NOT NULL,
    last_used_at   BIGINT,
    user_agent     TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_google_sub ON auth_sessions(google_sub);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON auth_sessions(expires_at);

-- Encrypted Drive refresh tokens, one per Google account. The refresh token is
-- sealed with AES-256-GCM (pepper-derived key); only the ciphertext is stored.
CREATE TABLE drive_grants (
    google_sub     TEXT PRIMARY KEY,
    refresh_cipher TEXT NOT NULL,
    scopes         TEXT NOT NULL,
    granted_at     BIGINT NOT NULL,
    updated_at     BIGINT NOT NULL,
    revoked_at     BIGINT
);

-- 3. RLS: every backend table is private. anon/authenticated get deny-all;
-- the service role (server-side only) bypasses RLS as before.
ALTER TABLE licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE license_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE license_installs ENABLE ROW LEVEL SECURITY;
ALTER TABLE license_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE drive_grants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "deny_all_anon_licenses" ON licenses FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_anon_license_tokens" ON license_tokens FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_anon_license_installs" ON license_installs FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_anon_license_events" ON license_events FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_anon_auth_accounts" ON auth_accounts FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_anon_auth_sessions" ON auth_sessions FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_anon_drive_grants" ON drive_grants FOR ALL TO anon USING (false) WITH CHECK (false);

CREATE POLICY "deny_all_auth_licenses" ON licenses FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_auth_license_tokens" ON license_tokens FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_auth_license_installs" ON license_installs FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_auth_license_events" ON license_events FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_auth_auth_accounts" ON auth_accounts FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_auth_auth_sessions" ON auth_sessions FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_auth_drive_grants" ON drive_grants FOR ALL TO authenticated USING (false) WITH CHECK (false);

-- End of migration.