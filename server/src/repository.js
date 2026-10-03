/**
 * Storage for licence metadata.
 *
 * This module is the *port*: a small set of named operations, nothing about
 * SQLite. `SqliteRepository` in ./sqlite-repository.js is the *adapter* that
 * implements it against Node's built-in `node:sqlite`, which is what runs in
 * development and in tests.
 *
 * The split exists because of a constraint the project set explicitly: local
 * development may use a simple store, but production architecture must not
 * depend on a local file being adequate. Every method below is expressible in
 * SQL that Postgres would accept unchanged, so a hosted database becomes a new
 * adapter rather than a rewrite of the licence logic — and the service layer,
 * which is where the rules actually live, never learns which one it is talking
 * to.
 */

import { randomUUID } from 'node:crypto';

/**
 * What a stored licence looks like.
 *
 * Note what is absent: no plaintext code, no customer name, no store contents,
 * no invoices. `codeHash`/`codeSalt` prove a code is correct; `codeLookup` finds
 * the row. Nothing here can reconstruct a code.
 *
 * @typedef {object} LicenseRecord
 * @property {string}   id              uuid, stable public handle
 * @property {string}   codeLookup      keyed HMAC, unique index
 * @property {string}   codeSalt        per-licence scrypt salt
 * @property {string}   codeHash        scrypt verifier
 * @property {'active'|'suspended'|'revoked'} status
 * @property {number}   createdAt       epoch ms, server clock
 * @property {number|null} activatedAt  epoch ms, first successful activation
 * @property {number|null} expiresAt    epoch ms, null = perpetual
 * @property {string|null} linkedAccountId  null until bound (Phase 3 supplies real ids)
 * @property {number|null} lastVerifiedAt   epoch ms of last successful verify
 * @property {string|null} note           internal note; never returned to a client
 */

/**
 * Columns returned unless secrets are explicitly requested.
 *
 * Code lookup, salt and hash are excluded by default so the common read path —
 * verifying a session, rendering a status — cannot accidentally carry hash
 * material into a log line or a response body.
 */
const PUBLIC_COLUMNS =
  'id, status, created_at, activated_at, expires_at, linked_account_id, last_verified_at, note';
const ALL_COLUMNS = '*';

/** @param {import('node:sqlite').DatabaseSync} db @returns {void} */
function migrate(db) {
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
 * Maps a database row to a camelCase record.
 *
 * @param {object} row
 * @returns {LicenseRecord}
 */
function toRecord(row) {
  return {
    id: row.id,
    codeLookup: row.code_lookup ?? null,
    codeSalt: row.code_salt ?? null,
    codeHash: row.code_hash ?? null,
    status: row.status,
    createdAt: row.created_at,
    activatedAt: row.activated_at ?? null,
    expiresAt: row.expires_at ?? null,
    linkedAccountId: row.linked_account_id ?? null,
    lastVerifiedAt: row.last_verified_at ?? null,
    note: row.note ?? null,
  };
}

/**
 * Opens a licence database.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{clock: () => number}} deps
 * @returns {LicenseRepository}
 */
export function createLicenseRepository(db, { clock }) {
  const now = clock;

  const insertStmt = db.prepare(`
    INSERT INTO licenses (id, code_lookup, code_salt, code_hash, status, created_at, expires_at, note)
    VALUES ($id, $codeLookup, $codeSalt, $codeHash, $status, $createdAt, $expiresAt, $note)
  `);

  const byLookupStmt = db.prepare(
    `SELECT ${PUBLIC_COLUMNS} FROM licenses WHERE code_lookup = $lookup`,
  );
  const byLookupWithSecretsStmt = db.prepare(
    `SELECT ${ALL_COLUMNS} FROM licenses WHERE code_lookup = $lookup`,
  );
  const byIdStmt = db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM licenses WHERE id = $id`);
  const byIdWithSecretsStmt = db.prepare(`SELECT ${ALL_COLUMNS} FROM licenses WHERE id = $id`);

  const touchVerifiedStmt = db.prepare(
    `UPDATE licenses SET last_verified_at = $at WHERE id = $id`,
  );
  const activateStmt = db.prepare(
    `UPDATE licenses SET activated_at = COALESCE(activated_at, $at) WHERE id = $id`,
  );
  const bindAccountStmt = db.prepare(
    `UPDATE licenses SET linked_account_id = $accountId WHERE id = $id`,
  );
  const setStatusStmt = db.prepare(
    `UPDATE licenses SET status = $status WHERE id = $id`,
  );

  const insertTokenStmt = db.prepare(`
    INSERT INTO license_tokens (token_lookup, license_id, created_at) VALUES ($lookup, $licenseId, $at)
  `);
  const tokenByLookupStmt = db.prepare(
    `SELECT license_id, revoked_at FROM license_tokens WHERE token_lookup = $lookup`,
  );
  const touchTokenStmt = db.prepare(
    `UPDATE license_tokens SET last_used_at = $at WHERE token_lookup = $lookup`,
  );
  const revokeTokensStmt = db.prepare(
    `UPDATE license_tokens SET revoked_at = $at WHERE license_id = $licenseId AND revoked_at IS NULL`,
  );

  const upsertInstallStmt = db.prepare(`
    INSERT INTO license_installs (license_id, install_id, platform, app_version, first_seen_at, last_seen_at, last_verified_at)
    VALUES ($licenseId, $installId, $platform, $appVersion, $at, $at, $at)
    ON CONFLICT(license_id, install_id) DO UPDATE SET
      platform = excluded.platform,
      app_version = excluded.app_version,
      last_seen_at = excluded.last_seen_at
  `);
  const installsStmt = db.prepare(
    `SELECT install_id, platform, app_version, first_seen_at, last_seen_at, last_verified_at
     FROM license_installs WHERE license_id = $licenseId ORDER BY last_seen_at DESC`,
  );

  const insertEventStmt = db.prepare(
    `INSERT INTO license_events (license_id, event, at, install_id, detail) VALUES ($licenseId, $event, $at, $installId, $detail)`,
  );

  /** @returns {void} */
  function begin() {
    db.exec('BEGIN IMMEDIATE');
  }
  /** @returns {void} */
  function commit() {
    db.exec('COMMIT');
  }
  /** @returns {void} */
  function rollback() {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back; nothing to undo */
    }
  }

  /** @returns {LicenseRecord} */
  function newId() {
    return randomUUID();
  }

  /**
   * @param {LicenseRecord} record
   * @returns {{inserted: boolean, record: LicenseRecord}}
   */
  function insert(record) {
    begin();
    try {
      const at = now();
      insertStmt.run({
        id: record.id,
        codeLookup: record.codeLookup,
        codeSalt: record.codeSalt,
        codeHash: record.codeHash,
        status: record.status,
        createdAt: record.createdAt ?? at,
        expiresAt: record.expiresAt ?? null,
        note: record.note ?? null,
      });
      commit();
      const stored = byIdWithSecretsStmt.get({ id: record.id });
      return { inserted: true, record: toRecord(stored) };
    } catch (err) {
      rollback();
      throw err;
    }
  }

  /**
   * Finds a licence by its keyed code fingerprint.
   *
   * @param {string} lookup
   * @param {{includeSecrets?: boolean}} [options]
   * @returns {LicenseRecord|null}
   */
  function findByCodeLookup(lookup, options = {}) {
    const stmt = options.includeSecrets ? byLookupWithSecretsStmt : byLookupStmt;
    const row = stmt.get({ lookup });
    return row ? toRecord(row) : null;
  }

  /**
   * @param {string} id
   * @param {{includeSecrets?: boolean}} [options]
   * @returns {LicenseRecord|null}
   */
  function findById(id, options = {}) {
    const stmt = options.includeSecrets ? byIdWithSecretsStmt : byIdStmt;
    const row = stmt.get({ id });
    return row ? toRecord(row) : null;
  }

  /**
   * @param {string} id
   * @returns {void}
   */
  function markActivated(id) {
    activateStmt.run({ id, at: now() });
  }

  /**
   * @param {string} id
   * @returns {void}
   */
  function markVerified(id) {
    touchVerifiedStmt.run({ id, at: now() });
  }

  /**
   * Binds an account. The caller decides whether a rebind is allowed; this only
   * writes, so the "one licence, one account, forever" rule cannot be bypassed
   * by calling the repository directly.
   *
   * @param {string} id
   * @param {string} accountId
   * @returns {void}
   */
  function bindAccount(id, accountId) {
    bindAccountStmt.run({ id, accountId });
  }

  /**
   * @param {string} id
   * @param {'active'|'suspended'|'revoked'} status
   * @returns {void}
   */
  function setStatus(id, status) {
    setStatusStmt.run({ id, status });
  }

  /**
   * @param {string} tokenLookup
   * @param {string} licenseId
   * @returns {void}
   */
  function insertToken(tokenLookup, licenseId) {
    insertTokenStmt.run({ lookup: tokenLookup, licenseId, at: now() });
  }

  /**
   * @param {string} tokenLookup
   * @returns {{licenseId: string, revokedAt: number|null}|null}
   */
  function findToken(tokenLookup) {
    const row = tokenByLookupStmt.get({ lookup: tokenLookup });
    // Mapped explicitly: node:sqlite hands back raw snake_case column names, and
    // a row whose keys are `license_id`/`revoked_at` would leave the caller
    // reading undefined — which for `revokedAt` would make every session look
    // revoked rather than none of them.
    if (!row) return null;
    return {
      licenseId: row.license_id,
      revokedAt: row.revoked_at ?? null,
    };
  }

  /**
   * @param {string} tokenLookup
   * @returns {void}
   */
  function touchToken(tokenLookup) {
    touchTokenStmt.run({ lookup: tokenLookup, at: now() });
  }

  /**
   * @param {string} licenseId
   * @returns {void}
   */
  function revokeAllTokens(licenseId) {
    revokeTokensStmt.run({ licenseId, at: now() });
  }

  /**
   * Records install metadata, creating the row the first time this install is
   * seen. There is no device cap: recording a new install must never fail.
   *
   * @param {{licenseId: string, installId: string, platform?: string, appVersion?: string}} install
   * @returns {void}
   */
  function upsertInstall(install) {
    upsertInstallStmt.run({
      licenseId: install.licenseId,
      installId: install.installId,
      platform: install.platform ?? null,
      appVersion: install.appVersion ?? null,
      at: now(),
    });
  }

  /**
   * @param {string} licenseId
   * @returns {Array<{installId: string, platform: string|null, appVersion: string|null, firstSeenAt: number, lastSeenAt: number, lastVerifiedAt: number|null}>}
   */
  function listInstalls(licenseId) {
    return installsStmt.all({ licenseId }).map((row) => ({
      installId: row.install_id,
      platform: row.platform ?? null,
      appVersion: row.app_version ?? null,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      lastVerifiedAt: row.last_verified_at ?? null,
    }));
  }

  /**
   * @param {{licenseId?: string, event: string, installId?: string, detail?: string}} entry
   * @returns {void}
   */
  function recordEvent(entry) {
    insertEventStmt.run({
      licenseId: entry.licenseId ?? null,
      event: entry.event,
      at: now(),
      installId: entry.installId ?? null,
      detail: entry.detail ?? null,
    });
  }

  return {
    newId,
    insert,
    findByCodeLookup,
    findById,
    markActivated,
    markVerified,
    bindAccount,
    setStatus,
    insertToken,
    findToken,
    touchToken,
    revokeAllTokens,
    upsertInstall,
    listInstalls,
    recordEvent,
    /** Exposed for tests and for the admin surface added in a later phase. */
    close() {
      db.close();
    },
  };
}

/**
 * @typedef {ReturnType<typeof createLicenseRepository>} LicenseRepository
 */

/**
 * Creates the schema on an already-open database handle.
 *
 * Exported for the adapter and for tests that build their own handle.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {void}
 */
export { migrate as applyMigrations };