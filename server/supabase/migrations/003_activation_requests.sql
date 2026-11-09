-- Store Hub — Activation requests schema (003)
-- Version: 003_activation_requests
-- Purpose: Store customer activation and support requests so the admin
-- portal can review and act on them. No store data, no sale data.
--
-- This is an additive migration: it creates one new table and does not
-- modify any existing table. Safe to run on a live database.

-- One row per customer request. idempotency_key lets the client retry
-- safely without creating duplicate requests.
CREATE TABLE IF NOT EXISTS activation_requests (
    id                TEXT PRIMARY KEY,           -- client-generated UUID
    type              TEXT NOT NULL               -- 'activation' | 'device_transfer' | 'license_issue' | 'support'
                      CHECK (type IN ('activation','device_transfer','license_issue','support')),
    status            TEXT NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new','in_progress','completed','rejected')),
    store_name        TEXT NOT NULL,
    requester_name    TEXT NOT NULL,
    contact           TEXT,                       -- optional phone/email
    description       TEXT NOT NULL,
    app_version       TEXT,
    platform          TEXT,
    install_id        TEXT,                       -- random client-generated install handle
    google_sub        TEXT,                       -- set when the requester is signed in
    linked_license_id TEXT,                       -- admin may link a licence after review
    admin_note        TEXT,                       -- internal, never shown to customer
    resolved_by       TEXT,                       -- admin sub who changed status
    resolved_at       BIGINT,                     -- epoch ms of last status change
    created_at        BIGINT NOT NULL,
    updated_at        BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activation_requests_status ON activation_requests(status);
CREATE INDEX IF NOT EXISTS idx_activation_requests_created ON activation_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activation_requests_google_sub ON activation_requests(google_sub);

-- RLS: service role only, same as all other backend tables.
ALTER TABLE activation_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny_all_anon_activation_requests" ON activation_requests FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_auth_activation_requests" ON activation_requests FOR ALL TO authenticated USING (false) WITH CHECK (false);

-- End of migration.
