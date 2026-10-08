/**
 * Storage for licence metadata.
 *
 * This module is the *port*: a small set of named operations, nothing about
 * how rows are stored. Two adapters implement it: `./pg-license-repository.js`
 * against PostgreSQL — the only one the runtime uses since Phase 4 — and the
 * test-only SQLite adapter in ../test/support/sqlite-license.js, which the
 * unit suite runs against `:memory:`.
 *
 * The split exists because of a constraint the project set explicitly: local
 * development may use a simple store, but production architecture must not
 * depend on a local file being adequate. Every method below is expressible in
 * SQL that Postgres accepts unchanged, so the storage choice is an adapter
 * rather than a rewrite of the licence logic — and the service layer,
 * which is where the rules actually live, never learns which one it is talking
 * to. Phase 4 removed SQLite from the runtime entirely.
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
 * `db` is a duck-typed handle exposing `prepare()`/`exec()` — the PostgreSQL
 * adapter in ./pg-license-repository.js provides it in the runtime; the
 * test-only SQLite adapter provides it under test. Nothing reachable from the
 * server entry point imports a SQLite driver (Phase 4).
 *
 * @param {object} db
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
  const eventsStmt = db.prepare(
    `SELECT event, at, install_id, detail
     FROM license_events WHERE license_id = $licenseId ORDER BY at DESC, id DESC LIMIT $limit OFFSET $offset`,
  );
  const countStmt = db.prepare('SELECT COUNT(*) AS total FROM licenses');
  const countByEffectiveStatusStmt = db.prepare(
    `SELECT COUNT(*) AS total FROM licenses
     WHERE ($status = 'expired'
            AND status = 'active'
            AND expires_at IS NOT NULL
            AND expires_at <= $now)
        OR ($status <> 'expired' AND status = $status)`,
  );
  const listAllStmt = db.prepare(
    `SELECT ${PUBLIC_COLUMNS} FROM licenses ORDER BY created_at DESC, id DESC LIMIT $limit OFFSET $offset`,
  );
  // Filtering by the *effective* status, not the stored column. A stored-status
  // filter would put every lapsed licence in the "active" bucket, which is the
  // one thing an operator filtering by status is asking not to happen. The
  // `expired` predicate mirrors effectiveStatus() exactly: only a licence that is
  // otherwise active can be expired, so a suspended one still reports suspended.
  const listByEffectiveStatusStmt = db.prepare(
    `SELECT ${PUBLIC_COLUMNS} FROM licenses
     WHERE ($status = 'expired'
            AND status = 'active'
            AND expires_at IS NOT NULL
            AND expires_at <= $now)
        OR ($status <> 'expired' AND status = $status)
     ORDER BY created_at DESC, id DESC LIMIT $limit OFFSET $offset`,
  );

  const setNoteStmt = db.prepare(
    `UPDATE licenses SET note = $note WHERE id = $id`
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
    // Mapped explicitly: the database handle hands back raw snake_case column
    // names, and a row whose keys are `license_id`/`revoked_at` would leave the
    // caller reading undefined — which for `revokedAt` would make every session
    // look revoked rather than none of them.
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

  /**
   * Updates the internal note on a licence.
   *
   * @param {string} id
   * @param {string|null} note
   * @returns {void}
   */
  function setNote(id, note) {
    setNoteStmt.run({ id, note });
  }

  /**
   * Lists licences for the operator view, newest first.
   *
   * Three deliberate properties. It reads the *public* column list, so the code
   * lookup, salt and hash cannot reach an admin screen even by accident. The
   * `status` filter matches the status the outside world sees rather than the
   * stored column, so "expired" selects what the UI shows as expired. And it is a
   * port method rather than SQL written by a caller, so the day the storage moves
   * to Postgres this list is a query swap rather than a rewrite of whoever was
   * reaching past the repository.
   *
   * @param {{status?: string|null, limit?: number, offset?: number, now?: number}} [options]
   *   `now` is the server clock, used only to evaluate the derived `expired`
   *   status. Injected rather than read here so the predicate stays testable.
   * @returns {{records: LicenseRecord[], total: number}}
   */
  function listLicenses(options = {}) {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
    const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
    const status = options.status ?? null;
    const now = Math.trunc(options.now ?? clock());
    if (!status) {
      const rows = listAllStmt.all({ limit, offset });
      // Called with an empty object rather than no argument, so both paths read
      // the same and an explicit `undefined` can never become a bound parameter.
      return { records: rows.map(toRecord), total: countStmt.get({}).total };
    }

    const params = { status, now };
    return {
      records: listByEffectiveStatusStmt.all({ ...params, limit, offset }).map(toRecord),
      total: countByEffectiveStatusStmt.get(params).total,
    };
  }

  /**
   * Reads the state-change trail for one licence.
   *
   * @param {string} licenseId
   * @param {{limit?: number, offset?: number}} [options]
   * @returns {Array<{event: string, at: number, installId: string|null, detail: string|null}>}
   */
  function listEvents(licenseId, options = {}) {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500);
    const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
    return eventsStmt.all({ licenseId, limit, offset }).map((row) => ({
      event: row.event,
      at: row.at,
      installId: row.install_id ?? null,
      detail: row.detail ?? null,
    }));
  }

  return {
    newId,
    insert,
    findByCodeLookup,
    findById,
    listLicenses,
    listEvents,
    markActivated,
    markVerified,
    bindAccount,
    setStatus,
    setNote,
    insertToken,
    findToken,
    touchToken,
    revokeAllTokens,
    upsertInstall,
    listInstalls,
    recordEvent,
    close() {
      db.close();
    },
  };
}

/**
 * @typedef {ReturnType<typeof createLicenseRepository>} LicenseRepository
 */

// Phase 4: the SQLite schema builder (`applyMigrations`) that used to live here
// moved to ../test/support/sqlite-license.js. This module is reachable from the
// runtime entry point, and the runtime is PostgreSQL-only.