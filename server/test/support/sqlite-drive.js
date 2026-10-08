/**
 * Test-only SQLite adapter for the Drive grant repository.
 *
 * Phase 4 removed SQLite from the server runtime: production opens PostgreSQL
 * through src/pg-drive-repository.js and nothing in src/ imports this file.
 * It exists solely so the unit test suite can run against an in-memory
 * `node:sqlite` database (`:memory:`).
 *
 * `applyDriveMigrations` and `openDriveDatabase` moved here from
 * src/drive-repository.js, which keeps the runtime module free of SQLite code
 * while the port (`createDriveRepository`) stays in src for both adapters.
 */

import { DatabaseSync } from 'node:sqlite';

import { createDriveRepository } from '../../src/drive-repository.js';

/**
 * Creates the Drive grant schema on an open handle.
 *
 * Moved out of src/drive-repository.js in Phase 4 (SQLite DDL is test support).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {void}
 */
export function applyDriveMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS drive_grants (
      google_sub     TEXT PRIMARY KEY,
      refresh_cipher TEXT NOT NULL,
      scopes         TEXT NOT NULL,
      granted_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      revoked_at     INTEGER
    );
  `);
}

/**
 * Opens the Drive grant database.
 *
 * Its own file, always. Sharing a file with the licence database would defeat
 * the entire reason this module exists.
 *
 * @param {string} file path, or ':memory:'
 * @param {{clock?: () => number, pepper: string}} deps
 * @returns {Promise<{db: import('node:sqlite').DatabaseSync, repo: import('../../src/drive-repository.js').DriveRepository}>}
 */
export async function openDriveDatabase(file, deps) {
  const clock = deps.clock || (() => Date.now());
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  if (file !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 5000');
  }
  applyDriveMigrations(db);
  return { db, repo: createDriveRepository(db, { clock, pepper: deps.pepper }) };
}
