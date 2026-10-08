/**
 * Authentication repository: sessions and Google account identity.
 *
 * This is the *port* — a small set of named operations. The SQLite adapter
 * implements it against `node:sqlite`. The service layer knows only this
 * interface, so the storage can be swapped for Postgres later without touching
 * business logic.
 */

import { randomBytes, createHmac, createHash } from 'node:crypto';

/**
 * An authenticated Store Hub account.
 *
 * This is the minimal identity metadata the server keeps. It is keyed by the
 * Google `sub` (stable subject identifier) so that the same Google account
 * always maps to the same Store Hub account, even if the email changes.
 *
 * @typedef {object} AccountRecord
 * @property {string} googleSub     Google's stable subject id (the primary key)
 * @property {string} email         Google account email
 * @property {string|null} displayName  Display name from Google profile
 * @property {string|null} avatarUrl    Profile picture URL from Google
 * @property {number} createdAt     Epoch ms when this account was first seen
 * @property {number} lastLoginAt   Epoch ms of most recent successful auth
 */

/**
 * A Store Hub authentication session.
 *
 * The session token is an opaque, high-entropy string returned to the client.
 * The server stores only its hash (HMAC-SHA256 keyed by the pepper). This way
 * a database leak does not yield usable sessions.
 *
 * @typedef {object} SessionRecord
 * @property {string} sessionLookup  Keyed HMAC of the session token (primary key)
 * @property {string} googleSub      The account this session belongs to
 * @property {number} createdAt      Epoch ms when session was created
 * @property {number} expiresAt      Epoch ms when session expires
 * @property {number|null} lastUsedAt  Epoch ms of last activity (for sliding TTL)
 * @property {string|null} userAgent   Optional client identifier for debugging
 */

const PUBLIC_ACCOUNT_FIELDS = 'google_sub, email, display_name, avatar_url, created_at, last_login_at';
const PUBLIC_SESSION_FIELDS = 'session_lookup, google_sub, created_at, expires_at, last_used_at, user_agent';

// Phase 4: the SQLite schema builder (`applyAuthMigrations`) and the SQLite
// opener (`openAuthDatabase`) that used to live here moved to
// ../test/support/sqlite-auth.js. This module is reachable from the runtime
// entry point, and the runtime is PostgreSQL-only.

/**
 * Maps a database row to a camelCase account record.
 * @param {object} row
 * @returns {AccountRecord}
 */
function toAccountRecord(row) {
  return {
    googleSub: row.google_sub,
    email: row.email,
    displayName: row.display_name ?? null,
    avatarUrl: row.avatar_url ?? null,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

/**
 * Maps a database row to a camelCase session record.
 * @param {object} row
 * @returns {SessionRecord}
 */
function toSessionRecord(row) {
  return {
    sessionLookup: row.session_lookup,
    googleSub: row.google_sub,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at ?? null,
    userAgent: row.user_agent ?? null,
  };
}

/**
 * Creates the authentication repository.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{clock: () => number, pepper: string}} deps
 * @returns {AuthRepository}
 */
export function createAuthRepository(db, { clock, pepper }) {
  const now = clock;

  // Helper: HMAC-SHA256 keyed by pepper
  function hashSessionToken(token) {
    return createHmac('sha256', pepper).update(`session:${token}`, 'utf8').digest('hex');
  }

  // Account operations
  const upsertAccountStmt = db.prepare(`
    INSERT INTO auth_accounts (google_sub, email, display_name, avatar_url, created_at, last_login_at)
    VALUES ($googleSub, $email, $displayName, $avatarUrl, $createdAt, $lastLoginAt)
    ON CONFLICT(google_sub) DO UPDATE SET
      email = excluded.email,
      display_name = excluded.display_name,
      avatar_url = excluded.avatar_url,
      last_login_at = excluded.last_login_at
  `);
  const getAccountStmt = db.prepare(`SELECT ${PUBLIC_ACCOUNT_FIELDS} FROM auth_accounts WHERE google_sub = $googleSub`);

  // Session operations
  const insertSessionStmt = db.prepare(`
    INSERT INTO auth_sessions (session_lookup, google_sub, created_at, expires_at, user_agent)
    VALUES ($sessionLookup, $googleSub, $createdAt, $expiresAt, $userAgent)
  `);
  const getSessionStmt = db.prepare(`SELECT ${PUBLIC_SESSION_FIELDS} FROM auth_sessions WHERE session_lookup = $sessionLookup`);
  const touchSessionStmt = db.prepare(`UPDATE auth_sessions SET last_used_at = $at WHERE session_lookup = $sessionLookup`);
  const deleteSessionStmt = db.prepare(`DELETE FROM auth_sessions WHERE session_lookup = $sessionLookup`);
  const deleteAllSessionsForAccountStmt = db.prepare(`DELETE FROM auth_sessions WHERE google_sub = $googleSub`);
  const cleanupExpiredStmt = db.prepare(`DELETE FROM auth_sessions WHERE expires_at <= $now`);

  /**
   * Upserts an account from Google identity data.
   *
   * @param {{googleSub: string, email: string, displayName?: string, avatarUrl?: string}} data
   * @returns {AccountRecord}
   */
  function upsertAccount(data) {
    const at = now();
    const existing = getAccountStmt.get({ googleSub: data.googleSub });
    upsertAccountStmt.run({
      googleSub: data.googleSub,
      email: data.email,
      displayName: data.displayName ?? null,
      avatarUrl: data.avatarUrl ?? null,
      createdAt: existing?.created_at ?? at,
      lastLoginAt: at,
    });
    return getAccount(data.googleSub);
  }

  /**
   * @param {string} googleSub
   * @returns {AccountRecord|null}
   */
  function getAccount(googleSub) {
    const row = getAccountStmt.get({ googleSub });
    return row ? toAccountRecord(row) : null;
  }

  /**
   * Creates a new session for the given account.
   *
   * @param {string} googleSub
   * @param {number} ttlMs
   * @param {string} [userAgent]
   * @returns {{sessionToken: string, sessionRecord: SessionRecord}}
   */
  function createSession(googleSub, ttlMs, userAgent) {
    const sessionToken = randomBytes(32).toString('base64url');
    const sessionLookup = hashSessionToken(sessionToken);
    const at = now();
    const expiresAt = at + ttlMs;

    insertSessionStmt.run({
      sessionLookup,
      googleSub,
      createdAt: at,
      expiresAt,
      userAgent: userAgent ?? null,
    });

    return {
      sessionToken,
      sessionRecord: {
        sessionLookup,
        googleSub,
        createdAt: at,
        expiresAt,
        lastUsedAt: null,
        userAgent: userAgent ?? null,
      },
    };
  }

  /**
   * Resolves a session token to its account, if valid and not expired.
   *
   * @param {string} sessionToken
   * @returns {{account: AccountRecord, session: SessionRecord}|null}
   */
  function resolveSession(sessionToken) {
    const sessionLookup = hashSessionToken(sessionToken);
    const sessionRow = getSessionStmt.get({ sessionLookup });
    if (!sessionRow) return null;

    const session = toSessionRecord(sessionRow);
    if (session.expiresAt <= now()) {
      // Expired — clean it up and return null
      deleteSessionStmt.run({ sessionLookup });
      return null;
    }

    const account = getAccount(session.googleSub);
    if (!account) {
      // Orphaned session — shouldn't happen with FK, but be safe
      deleteSessionStmt.run({ sessionLookup });
      return null;
    }

    // Update last_used_at (sliding window)
    touchSessionStmt.run({ sessionLookup, at: now() });
    session.lastUsedAt = now();

    return { account, session };
  }

  /**
   * Deletes a specific session (logout).
   *
   * @param {string} sessionToken
   * @returns {boolean} true if a session was deleted
   */
  function deleteSession(sessionToken) {
    const sessionLookup = hashSessionToken(sessionToken);
    const result = deleteSessionStmt.run({ sessionLookup });
    return result.changes > 0;
  }

  /**
   * Deletes all sessions for an account (revoke all).
   *
   * @param {string} googleSub
   * @returns {number} number of sessions deleted
   */
  function deleteAllSessionsForAccount(googleSub) {
    const result = deleteAllSessionsForAccountStmt.run({ googleSub });
    return result.changes;
  }

  /**
   * Removes expired sessions. Can be called periodically or on startup.
   *
   * @returns {number} number of sessions cleaned up
   */
  function cleanupExpiredSessions() {
    const result = cleanupExpiredStmt.run({ now: now() });
    return result.changes;
  }

  return {
    upsertAccount,
    getAccount,
    createSession,
    resolveSession,
    deleteSession,
    deleteAllSessionsForAccount,
    cleanupExpiredSessions,
    close() {
      db.close();
    },
  };
}

/**
 * @typedef {ReturnType<typeof createAuthRepository>} AuthRepository
 */