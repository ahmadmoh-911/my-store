/**
 * Test-only SQLite adapter for the auth repository.
 *
 * Phase 4 removed SQLite from the server runtime: production opens PostgreSQL
 * through src/pg-auth-repository.js and nothing in src/ imports this file.
 * It exists solely so the unit test suite can run against an in-memory
 * `node:sqlite` database (`:memory:`).
 *
 * `applyAuthMigrations` and `openAuthDatabase` moved here from
 * src/auth-repository.js, which keeps the runtime module free of SQLite code
 * while the port (`createAuthRepository`) stays in src for both adapters.
 */

import { DatabaseSync } from 'node:sqlite';

import { createAuthRepository } from '../../src/auth-repository.js';

/**
 * Creates the auth schema on an already-open database handle.
 *
 * Moved out of src/auth-repository.js in Phase 4 (SQLite DDL is test support).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {void}
 */
export function applyAuthMigrations(db) {
  db.exec(`
    -- One row per Google account. The primary key is google_sub so the same
    -- Google user always resolves to the same Store Hub account.
    CREATE TABLE IF NOT EXISTS auth_accounts (
      google_sub     TEXT PRIMARY KEY,
      email          TEXT NOT NULL,
      display_name   TEXT,
      avatar_url     TEXT,
      created_at     INTEGER NOT NULL,
      last_login_at  INTEGER NOT NULL
    );

    -- One row per active session. The session token itself is never stored;
    -- only its peppered HMAC (session_lookup) so a DB leak cannot be used to
    -- hijack sessions.
    CREATE TABLE IF NOT EXISTS auth_sessions (
      session_lookup TEXT PRIMARY KEY,
      google_sub     TEXT NOT NULL REFERENCES auth_accounts(google_sub),
      created_at     INTEGER NOT NULL,
      expires_at     INTEGER NOT NULL,
      last_used_at   INTEGER,
      user_agent     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_google_sub ON auth_sessions(google_sub);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON auth_sessions(expires_at);
  `);
}

/**
 * Opens a SQLite auth database and returns a ready repository.
 *
 * Shares the same database file as the licence data (separate tables).
 *
 * @param {string} file path, or ':memory:'
 * @param {{clock?: () => number, pepper: string}} deps
 * @returns {Promise<{db: import('node:sqlite').DatabaseSync, repo: import('../../src/auth-repository.js').AuthRepository}>}
 */
export async function openAuthDatabase(file, deps) {
  const clock = deps.clock || (() => Date.now());
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  if (file !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 5000');
  }
  applyAuthMigrations(db);
  return { db, repo: createAuthRepository(db, { clock, pepper: deps.pepper }) };
}
