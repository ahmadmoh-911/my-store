/**
 * Test-only SQLite adapter for the licence repository.
 *
 * Phase 4 removed SQLite from the server runtime: production opens PostgreSQL
 * through src/pg-license-repository.js and nothing in src/ imports this file.
 * It exists solely so the unit test suite can run against an in-memory
 * `node:sqlite` database (`:memory:`), which is what every test does.
 *
 * The DDL below (`applyMigrations`) moved here from src/repository.js for the
 * same reason: it is SQLite schema syntax, and the runtime is PostgreSQL-only.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { createLicenseRepository } from '../../src/repository.js';

/**
 * Creates the licence schema on an already-open database handle.
 *
 * Moved out of src/repository.js in Phase 4: SQLite DDL has no place in a
 * PostgreSQL-only runtime, but the test suite still needs it.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {void}
 */
export function applyMigrations(db) {
  db.exec(`
    -- One licence. One row. No store data, ever.
    CREATE TABLE IF NOT EXISTS licenses (
      id                TEXT PRIMARY KEY,
      code_lookup       TEXT NOT NULL UNIQUE,
      code_salt         TEXT NOT NULL,
      code_hash         TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'active',
      created_at        INTEGER NOT NULL,
      activated_at      INTEGER,
      expires_at        INTEGER,
      linked_account_id TEXT,
      last_verified_at  INTEGER,
      note              TEXT
    );

    -- Opaque bearer sessions, so /verify never needs the licence code again.
    CREATE TABLE IF NOT EXISTS license_tokens (
      token_lookup TEXT PRIMARY KEY,
      license_id   TEXT NOT NULL REFERENCES licenses(id),
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tokens_license ON license_tokens(license_id);

    -- Install metadata per licence. No hard device limit is enforced (that was
    -- a deliberate product decision); this table is for visibility only.
    CREATE TABLE IF NOT EXISTS license_installs (
      license_id       TEXT NOT NULL REFERENCES licenses(id),
      install_id       TEXT NOT NULL,
      platform         TEXT,
      app_version      TEXT,
      first_seen_at    INTEGER NOT NULL,
      last_seen_at     INTEGER NOT NULL,
      last_verified_at INTEGER,
      PRIMARY KEY (license_id, install_id)
    );
    CREATE INDEX IF NOT EXISTS idx_installs_license ON license_installs(license_id);

    -- Append-only trail of licence state changes. Metadata only.
    CREATE TABLE IF NOT EXISTS license_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      license_id TEXT,
      event      TEXT NOT NULL,
      at         INTEGER NOT NULL,
      install_id TEXT,
      detail     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_license ON license_events(license_id, at);
  `);
}

/**
 * Opens a SQLite licence database.
 *
 * Foreign keys are enabled because `license_tokens` and `license_installs`
 * reference `licenses`; SQLite ignores those constraints by default, so
 * without this line they are decoration.
 *
 * @param {string} file absolute path, or ':memory:'
 * @param {{clock?: () => number}} [deps]
 * @returns {import('../../src/repository.js').LicenseRepository}
 */
export function openLicenseDatabase(file, deps = {}) {
  const clock = deps.clock || (() => Date.now());

  if (file !== ':memory:') {
    // Create the directory rather than failing on a fresh clone: the first run
    // should not require a mkdir the operator might forget.
    mkdirSync(dirname(file), { recursive: true });
  }

  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');

  if (file !== ':memory:') {
    // WAL keeps a crash mid-transaction from corrupting the file and lets a
    // reader proceed during a write. synchronous=NORMAL is the usual pairing:
    // durable against process death, which is the failure that actually happens.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 5000');
  }

  applyMigrations(db);

  return createLicenseRepository(db, { clock });
}
