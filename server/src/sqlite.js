/**
 * SQLite adapter for the licence repository.
 *
 * This is the only module that knows SQLite exists. It opens a file (or an
 * in-memory database for tests), turns on the connection settings the schema
 * depends on, and hands back the port defined in ./repository.js.
 *
 * Swapping to a hosted database for production means writing a sibling module
 * with the same `openLicenseDatabase` signature. Nothing above this layer
 * changes.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { createLicenseRepository, applyMigrations } from './repository.js';

/**
 * Opens a SQLite licence database.
 *
 * Foreign keys are enabled because `license_tokens` and `license_installs`
 * reference `licenses`; SQLite ignores those constraints by default, so
 * without this line they are decoration.
 *
 * @param {string} file absolute path, or ':memory:'
 * @param {{clock?: () => number}} [deps]
 * @returns {import('./repository.js').LicenseRepository}
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