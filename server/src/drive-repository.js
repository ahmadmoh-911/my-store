/**
 * Google Drive grant storage — its own database, its own file, one table.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Why this is not another table in `storehub.db`
 * ─────────────────────────────────────────────────────────────────────────
 * Because of what it holds. A Drive refresh token is a long-lived credential
 * that can read and write the customer's own Drive. Keeping it in the same file
 * as the licence tables would mean a single dump of that file yields licences
 * *and* Drive access, and a future migration of the licence data would have to
 * decide what to do about a secret embedded in the middle of it.
 *
 * A separate file makes the blast radius a file path rather than a schema
 * migration: `storehub_drive.db` can be backed up, rotated or deleted on its own
 * terms, and nothing in it can be joined to licence or account data by accident.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * What is in this table, exhaustively
 * ─────────────────────────────────────────────────────────────────────────
 *   google_sub        — Google's stable account id. The join key, and the only
 *                       identity fact. No email, no display name, no avatar:
 *                       none of them are needed to refresh a token, and every one
 *                       of them is another piece of customer data to leak.
 *   refresh_cipher    — the refresh token, AES-256-GCM sealed under a key derived
 *                       from STOREHUB_PEPPER. Never stored, logged or returned in
 *                       the clear.
 *   scopes            — what Google actually granted, recorded verbatim so a
 *                       scope creep can be detected by reading one column.
 *   granted_at /
 *   updated_at /
 *   revoked_at        — lifecycle bookkeeping.
 *
 * There is no column that could hold a product, a sale, an inventory line, a
 * report, an invoice or a backup. That is not a promise, it is the schema — and
 * `server/test/drive.test.mjs` asserts it column by column.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * The access token is never stored
 * ─────────────────────────────────────────────────────────────────────────
 * Not here, not in `storehub.db`, not in the client. A short-lived access token
 * is minted on demand, handed to the browser for the length of one Drive call,
 * and kept in memory in the service for as long as it is valid. Storing one
 * would add a second credential to protect for no benefit.
 */

import { randomBytes, createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';

/**
 * @typedef {object} DriveGrant
 * @property {string} googleSub
 * @property {string} refreshToken   decrypted; never leaves the service layer
 * @property {string} scopes
 * @property {number} grantedAt
 * @property {number} updatedAt
 * @property {number|null} revokedAt
 */

/** Fixed info/salt so the derived key is stable across restarts. */
const KEY_INFO = 'storehub/drive-grant/v1';
const KEY_SALT = 'storehub-drive-grant';

/**
 * Derives the 32-byte grant key from the pepper.
 *
 * HKDF rather than a bare hash so the key is separated from any other use of the
 * same secret: the pepper also keys session HMACs and licence hashes, and
 * reusing it raw for encryption would tie three unrelated protections to one
 * value.
 *
 * @param {string} pepper
 * @returns {Buffer}
 */
export function deriveGrantKey(pepper) {
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(String(pepper), 'utf8'), Buffer.from(KEY_SALT, 'utf8'), Buffer.from(KEY_INFO, 'utf8'), 32),
  );
}

/**
 * @param {Buffer} key
 * @param {string} plaintext
 * @returns {string} `v1.<iv>.<tag>.<ciphertext>`, base64url
 */
export function sealGrant(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

/**
 * @param {Buffer} key
 * @param {string} sealed
 * @returns {string}
 * @throws when the ciphertext has been tampered with
 */
export function openGrant(key, sealed) {
  const parts = String(sealed).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('stored Drive grant is not in a readable format');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

// Phase 4: the SQLite schema builder (`applyDriveMigrations`) and the SQLite
// opener (`openDriveDatabase`) that used to live here moved to
// ../test/support/sqlite-drive.js. This module is reachable from the runtime
// entry point, and the runtime is PostgreSQL-only.

/**
 * Builds the grant repository (the port) over a database handle.
 *
 * @param {object} db duck-typed handle from the PostgreSQL adapter (runtime) or
 *   the test-only SQLite adapter (tests) — never a SQLite driver in the runtime
 * @param {{clock?: () => number, pepper: string}} deps
 */
export function createDriveRepository(db, { clock, pepper }) {
  const now = clock || (() => Date.now());
  const key = deriveGrantKey(pepper);

  const upsertStmt = db.prepare(`
    INSERT INTO drive_grants (google_sub, refresh_cipher, scopes, granted_at, updated_at, revoked_at)
    VALUES ($googleSub, $cipher, $scopes, $grantedAt, $updatedAt, NULL)
    ON CONFLICT(google_sub) DO UPDATE SET
      refresh_cipher = excluded.refresh_cipher,
      scopes         = excluded.scopes,
      updated_at     = excluded.updated_at,
      revoked_at     = NULL
  `);
  const getStmt = db.prepare(
    `SELECT google_sub, refresh_cipher, scopes, granted_at, updated_at, revoked_at
       FROM drive_grants WHERE google_sub = $googleSub`,
  );
  const revokeStmt = db.prepare(`UPDATE drive_grants SET revoked_at = $at WHERE google_sub = $googleSub`);
  const deleteStmt = db.prepare(`DELETE FROM drive_grants WHERE google_sub = $googleSub`);
  const listStmt = db.prepare(`SELECT google_sub FROM drive_grants WHERE revoked_at IS NULL`);

  /**
   * @param {string} googleSub
   * @param {string} refreshToken
   * @param {string} scopes
   * @returns {{googleSub: string, scopes: string, grantedAt: number}}
   */
  function saveGrant(googleSub, refreshToken, scopes) {
    const at = now();
    const existing = getStmt.get({ googleSub });
    upsertStmt.run({
      googleSub,
      cipher: sealGrant(key, refreshToken),
      scopes,
      grantedAt: existing?.granted_at ?? at,
      updatedAt: at,
    });
    return { googleSub, scopes, grantedAt: existing?.granted_at ?? at };
  }

  /**
   * @param {string} googleSub
   * @returns {DriveGrant|null} null when absent or revoked
   */
  function getGrant(googleSub) {
    const row = getStmt.get({ googleSub });
    if (!row) return null;
    if (row.revoked_at !== null && row.revoked_at !== undefined) return null;
    return {
      googleSub: row.google_sub,
      refreshToken: openGrant(key, row.refresh_cipher),
      scopes: row.scopes,
      grantedAt: row.granted_at,
      updatedAt: row.updated_at,
      revokedAt: null,
    };
  }

  /**
   * Marks a grant revoked. The row is kept rather than deleted so the record of
   * a withdrawal survives — and `getGrant` treats it as absent from that moment,
   * so a revoked credential cannot be used even though it is still on disk.
   *
   * @param {string} googleSub
   * @returns {boolean} whether a live grant was revoked
   */
  function revokeGrant(googleSub) {
    const before = getGrant(googleSub);
    if (!before) return false;
    revokeStmt.run({ googleSub, at: now() });
    return true;
  }

  /** Forgets a grant entirely (account deletion, not a user-facing action). */
  function deleteGrant(googleSub) {
    return deleteStmt.run({ googleSub }).changes > 0;
  }

  /** @returns {string[]} the subs holding a live grant */
  function listGranted() {
    return listStmt.all().map((r) => r.google_sub);
  }

  return {
    saveGrant,
    getGrant,
    revokeGrant,
    deleteGrant,
    listGranted,
    /**
     * Closes the handle.
     *
     * Statements are finalised on construction, so the table is queryable
     * immediately; this exists to match the other repositories' shape so
     * shutdown does not have to know which adapter is which.
     */
    close() {
      db.close();
    },
  };
}

/**
 * @typedef {ReturnType<typeof createDriveRepository>} DriveRepository
 */