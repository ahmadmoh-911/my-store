/**
 * The licence service: every rule about who may use what, in one place.
 *
 * Above this module sit the HTTP routes, which only translate JSON into calls
 * and back. Below it sit the repository (storage) and the code helpers
 * (cryptography). Neither of those knows a business rule, and no rule lives
 * outside this file — which is what makes the rules testable without a socket.
 */

import {
  generateLicenseCode,
  normalizeLicenseCode,
  hashLicenseCode,
  verifyLicenseCode,
  lookupKey,
  generateSessionToken,
  hashSessionToken,
} from './codes.js';

import {
  STATUS_ACTIVE,
  STATUS_SUSPENDED,
  STATUS_REVOKED,
  STATUS_EXPIRED,
  LICENSE_STATUSES,
  effectiveStatus,
  entitlementFor,
  pickClientFields,
  fieldLimit,
} from './model.js';

import { ERROR_CODES, LicenseError } from './errors.js';

/** Platforms the client is allowed to report. Anything else is a bug or a probe. */
const KNOWN_PLATFORMS = new Set(['web', 'android', 'ios', 'unknown']);

/**
 * Builds the service.
 *
 * @param {{
 *   repository: import('./repository.js').LicenseRepository,
 *   config: ReturnType<typeof import('./config.js').loadConfig>,
 *   clock: () => number,
 *   log?: (message: string, detail?: unknown) => void,
 * }} deps
 */
export function createLicenseService({ repository, config, clock, log = () => {} }) {
  /**
   * The single source of "now" for this service.
   *
   * Every timestamp the backend produces — every response's `serverTime`, every
   * `expiresAt` comparison — comes from here. The client is never trusted for
   * time: a caller that can set the clock can talk its way past an expiry.
   * Injecting it also makes expiry testable without waiting a year.
   *
   * @returns {number} epoch milliseconds
   */
  function serverNow() {
    return Math.trunc(clock());
  }

  /**
   * Rejects a request whose reporting metadata is missing or implausible.
   *
   * Metadata is not decoration: `lastKnownPlatform` and `lastKnownAppVersion`
   * are the fields a support request will be answered with, so a client that
   * reports nonsense should be corrected now rather than believed later.
   *
   * @param {object} fields output of pickClientFields
   * @param {{requireInstallId: boolean}} rules
   * @returns {{installId: string|null, platform: string|null, appVersion: string|null}}
   */
  function validateInstallFields(fields, { requireInstallId }) {
    const installId = fields.installId ?? null;
    const platform = fields.platform ?? null;
    const appVersion = fields.appVersion ?? null;

    if (requireInstallId && !installId) {
      throw new LicenseError(ERROR_CODES.INVALID_REQUEST, {
        detail: 'installId is required',
      });
    }
    if (installId && installId.length > fieldLimit('installId')) {
      throw new LicenseError(ERROR_CODES.INVALID_REQUEST, {
        detail: 'installId too long',
      });
    }
    if (platform && !KNOWN_PLATFORMS.has(platform)) {
      throw new LicenseError(ERROR_CODES.INVALID_REQUEST, {
        detail: `unknown platform "${platform}"`,
      });
    }
    if (appVersion && appVersion.length > fieldLimit('appVersion')) {
      throw new LicenseError(ERROR_CODES.INVALID_REQUEST, {
        detail: 'appVersion too long',
      });
    }
    return { installId, platform, appVersion };
  }

  /**
   * Normalises a supplied code, turning a bad one into INVALID_LICENSE.
   *
   * @param {unknown} raw
   * @returns {string}
   */
  function requireCode(raw) {
    try {
      return normalizeLicenseCode(raw);
    } catch (err) {
      throw new LicenseError(ERROR_CODES.INVALID_LICENSE, { detail: err.message });
    }
  }

  /**
   * Fails unless the licence is currently usable, with the code that says why.
   *
   * Order matters: revoked outranks suspended outranks expired, because a
   * revoked licence must stay revoked even after its expiry date passes — the
   * later event must not soften the earlier one.
   *
   * @param {import('./repository.js').LicenseRecord} record
   * @param {number} now
   * @returns {void}
   * @throws {LicenseError}
   */
  function assertUsable(record, now) {
    const status = effectiveStatus(record, now);
    if (status === STATUS_ACTIVE) return;
    const codeByStatus = {
      [STATUS_REVOKED]: ERROR_CODES.LICENSE_REVOKED,
      [STATUS_SUSPENDED]: ERROR_CODES.LICENSE_SUSPENDED,
      [STATUS_EXPIRED]: ERROR_CODES.LICENSE_EXPIRED,
    };
    const code = codeByStatus[status];
    if (!code) {
      // Should not happen; defensive.
      throw new LicenseError(ERROR_CODES.INTERNAL_ERROR, {
        detail: `unexpected status ${status}`,
      });
    }
    throw new LicenseError(code, { detail: `licence ${record.id} is ${status}` });
  }

  /**
   * Looks up a licence by code and proves the code is correct.
   *
   * Two steps because they answer different questions. The HMAC lookup says
   * "this fingerprint is on file"; the scrypt verification says "and you
   * actually know the code". Only the second is a proof, and it only runs for a
   * row the first step found — so an attacker probing with junk codes pays one
   * cheap HMAC, never a scrypt.
   *
   * @param {string} code normalised
   * @param {number} now
   * @returns {import('./repository.js').LicenseRecord}
   */
  function authenticateByCode(code, now) {
    const lookup = lookupKey(code, config.pepper);
    const candidate = repository.findByCodeLookup(lookup, { includeSecrets: true });
    // No row, or a row whose code does not verify: both are reported
    // identically, so the endpoint cannot be used to enumerate valid codes.
    if (
      !candidate ||
      !verifyLicenseCode(
        code,
        { salt: candidate.codeSalt, hash: candidate.codeHash },
        config,
      )
    ) {
      throw new LicenseError(ERROR_CODES.LICENSE_NOT_FOUND);
    }
    assertUsable(candidate, now);
    return candidate;
  }

  /**
   * Resolves a bearer session token to its licence.
   *
   * @param {string|undefined} token
   * @param {number} now
   * @returns {import('./repository.js').LicenseRecord}
   */
  function authenticateBySession(token, now) {
    if (!token) {
      throw new LicenseError(ERROR_CODES.INVALID_SESSION, {
        detail: 'no session token supplied',
      });
    }
    const row = repository.findToken(hashSessionToken(token, config.pepper));
    if (!row || row.revokedAt !== null) {
      throw new LicenseError(ERROR_CODES.INVALID_SESSION, {
        detail: 'unknown or revoked token',
      });
    }
    const record = repository.findById(row.licenseId);
    if (!record) {
      throw new LicenseError(ERROR_CODES.INVALID_SESSION, {
        detail: 'token points at a missing licence',
      });
    }
    assertUsable(record, now);
    return record;
  }

  /**
   * Enforces "one licence, one account".
   *
   * The asymmetry is the point. A licence with no account yet accepts one — the
   * first bind is how it happens. Once bound it never changes hands: a second
   * bind to a different account is refused, and there is deliberately no
   * unbind operation. (Moving a licence between accounts is a support action
   * that should revoke and reissue, so it leaves an audit trail, rather than a
   * parameter someone can flip.)
   *
   * @param {import('./repository.js').LicenseRecord} record
   * @param {string|undefined|null} accountId
   * @returns {string|null} the account the licence is now bound to
   */
  function applyAccountBinding(record, accountId) {
    if (!accountId) return record.linkedAccountId ?? null;

    if (record.linkedAccountId === null) {
      repository.bindAccount(record.id, accountId);
      repository.recordEvent({
        licenseId: record.id,
        event: 'account_bound',
        detail: accountId,
      });
      log(`licence ${record.id} bound to account`);
      return accountId;
    }

    if (record.linkedAccountId === accountId) {
      // Re-binding to the same account is the client re-confirming, not a
      // reassignment. Idempotent by design.
      return record.linkedAccountId;
    }

    // Known account on both sides: this is someone else's licence.
    throw new LicenseError(ERROR_CODES.ACCOUNT_MISMATCH, {
      detail: `licence ${record.id} is bound elsewhere`,
    });
  }

  /**
   * Records install metadata. Never rejects: a product decision was made that
   * there is no hard device limit, so a new install is information, not an
   * error.
   *
   * @param {import('./repository.js').LicenseRecord} record
   * @param {{installId: string|null, platform: string|null, appVersion: string|null}} install
   * @returns {void}
   */
  function recordInstall(record, install) {
    if (!install.installId) return;
    repository.upsertInstall({
      licenseId: record.id,
      installId: install.installId,
      platform: install.platform,
      appVersion: install.appVersion,
    });
  }

  /**
   * Issues a session token and returns it in plaintext, exactly once.
   *
   * @param {string} licenseId
   * @returns {string}
   */
  function issueSessionToken(licenseId) {
    const token = generateSessionToken();
    repository.insertToken(hashSessionToken(token, config.pepper), licenseId);
    return token;
  }

  /* ---------------------------------------------------------------- *
   * Admin operations
   *
   * Reachable as plain functions only — no HTTP route exposes them. Issuing and
   * revoking licences is the one thing that must not be possible for anyone
   * holding a valid customer code; the admin surface arrives in a later phase,
   * with its own authentication, and it will call exactly these functions.
   * ---------------------------------------------------------------- */

  /**
   * Mints a licence.
   *
   * The plaintext code is returned to the caller and never stored. Once this
   * returns, the only copy that exists anywhere is whatever the operator wrote
   * down — which is the intended design: the server genuinely cannot leak a
   * code, because it never had one after this moment.
   *
   * @param {{expiresInDays?: number|null, note?: string, code?: string}} [options]
   *   `expiresInDays: null` (or omitted) means perpetual.
   * @returns {{license: object, code: string}}
   */
  function createLicense(options = {}) {
    const now = serverNow();
    const expiresAt =
      options.expiresInDays === null || options.expiresInDays === undefined
        ? null
        : now + Math.trunc(options.expiresInDays) * 86400000;

    if (expiresAt !== null && expiresAt <= now) {
      throw new LicenseError(ERROR_CODES.INVALID_REQUEST, {
        detail: 'expiresInDays must be positive',
      });
    }

    // Collisions are astronomically unlikely at 5.3×10^17 combinations, but
    // "unlikely" is not "impossible" and the cost of handling it is three lines.
    let record = null;
    let code = null;
    for (let attempt = 0; attempt < 5 && !record; attempt += 1) {
      const candidateCode = options.code
        ? normalizeLicenseCode(options.code)
        : generateLicenseCode();
      const { salt, hash } = hashLicenseCode(candidateCode, config);
      try {
        const inserted = repository.insert({
          id: repository.newId(),
          codeLookup: lookupKey(candidateCode, config.pepper),
          codeSalt: salt,
          codeHash: hash,
          status: STATUS_ACTIVE,
          createdAt: now,
          expiresAt,
          note: options.note ?? null,
        });
        record = inserted.record;
        code = candidateCode;
      } catch (err) {
        if (!String(err.message).includes('UNIQUE')) throw err;
        // Retry with a fresh code rather than reusing the operator's.
        if (options.code) throw err;
      }
    }
    if (!record) {
      throw new LicenseError(ERROR_CODES.INTERNAL_ERROR, {
        detail: 'could not find a free licence code',
      });
    }

    repository.recordEvent({ licenseId: record.id, event: 'created' });
    log(`licence ${record.id} created, expires ${expiresAt ?? 'never'}`);
    return {
      license: { ...entitlementFor(record, now), createdAt: record.createdAt },
      code,
    };
  }

  /**
   * @param {string} id
   * @param {'active'|'suspended'|'revoked'} status
   * @param {string} reason
   * @returns {object} the licence entitlement
   */
  function setStatus(id, status, reason) {
    if (!LICENSE_STATUSES.includes(status)) {
      throw new LicenseError(ERROR_CODES.INVALID_REQUEST, {
        detail: `unknown status "${status}"`,
      });
    }
    const now = serverNow();
    const existing = repository.findById(id);
    if (!existing) throw new LicenseError(ERROR_CODES.LICENSE_NOT_FOUND);

    repository.setStatus(id, status);
    repository.recordEvent({ licenseId: id, event: `status_${status}`, detail: reason });

    // Revocation must not leave a working session behind: the token would still
    // authenticate, and the only thing stopping use would be the client asking
    // politely every time.
    if (status === STATUS_REVOKED) {
      repository.revokeAllTokens(id);
      log(`licence ${id} revoked, all sessions invalidated`);
    } else {
      log(`licence ${id} set to ${status}${reason ? ` (${reason})` : ''}`);
    }

    return entitlementFor({ ...existing, status }, now);
  }

  /** @param {string} id @param {string} [reason] @returns {object} */
  function suspend(id, reason) {
    return setStatus(id, STATUS_SUSPENDED, reason);
  }

  /** @param {string} id @param {string} [reason] @returns {object} */
  function revoke(id, reason) {
    return setStatus(id, STATUS_REVOKED, reason);
  }

  /**
   * Lifts a suspension. Refuses a revoked licence: revocation is permanent,
   * and a "reactivate" that silently undid it would make the state machine
   * meaningless.
   *
   * @param {string} id
   * @param {string} [reason]
   * @returns {object}
   */
  function reactivate(id, reason) {
    const now = serverNow();
    const existing = repository.findById(id);
    if (!existing) throw new LicenseError(ERROR_CODES.LICENSE_NOT_FOUND);
    if (existing.status === STATUS_REVOKED) {
      throw new LicenseError(ERROR_CODES.LICENSE_REVOKED, {
        detail: 'a revoked licence cannot be reactivated; issue a new one',
      });
    }
    return setStatus(id, STATUS_ACTIVE, reason);
  }

  /**
   * @param {string} id
   * @returns {object} entitlement plus server-side metadata, for operator tools
   */
  function getLicense(id) {
    const now = serverNow();
    const record = repository.findById(id);
    if (!record) throw new LicenseError(ERROR_CODES.LICENSE_NOT_FOUND);
    return {
      ...entitlementFor(record, now),
      createdAt: record.createdAt,
      activatedAt: record.activatedAt,
      lastVerifiedAt: record.lastVerifiedAt,
      linkedAccountId: record.linkedAccountId,
      note: record.note,
      installs: repository.listInstalls(id),
    };
  }

  /* ---------------------------------------------------------------- *
   * Public API — the three endpoints' worth of behaviour
   * ---------------------------------------------------------------- */

  /**
   * POST /api/license/activate
   *
   * Turns a licence code into a working session for one install.
   *
   * @param {unknown} body
   * @returns {{license: object, sessionToken: string, linkedAccountId: string|null, serverTime: number}}
   */
  function activate(body) {
    const now = serverNow();
    const fields = pickClientFields(body);
    const code = requireCode(fields.licenseCode);
    const install = validateInstallFields(fields, { requireInstallId: true });

    const record = authenticateByCode(code, now);

    // accountId is optional here and is only ever a placeholder until the
    // identity phase supplies real account ids. An absent accountId simply
    // leaves the licence unbound; it does not claim the client is signed in.
    const linkedAccountId = applyAccountBinding(record, fields.accountId ?? null);

    repository.markActivated(record.id);
    recordInstall(record, install);
    const sessionToken = issueSessionToken(record.id);
    repository.recordEvent({
      licenseId: record.id,
      event: 'activated',
      installId: install.installId,
    });
    log(`licence ${record.id} activated by install ${install.installId}`);

    return {
      license: entitlementFor(record, now),
      sessionToken,
      linkedAccountId,
      serverTime: now,
    };
  }

  /**
   * POST /api/license/verify
   *
   * Answers "may this store keep running?" and refreshes what the server knows.
   * Authenticated by session token, so the licence code never travels again.
   *
   * @param {unknown} body
   * @returns {{license: object, serverTime: number}}
   */
  function verify(body) {
    const now = serverNow();
    const fields = pickClientFields(body);
    const install = validateInstallFields(fields, { requireInstallId: false });

    const record = authenticateBySession(fields.sessionToken, now);

    repository.markVerified(record.id);
    repository.touchToken(hashSessionToken(fields.sessionToken, config.pepper));
    recordInstall(record, install);
    repository.recordEvent({
      licenseId: record.id,
      event: 'verified',
      installId: install.installId,
    });

    return {
      license: entitlementFor(record, now),
      serverTime: now,
    };
  }

  /**
   * POST /api/license/bind
   *
   * Links a licence to an account. Present in the API now so the identity phase
   * has a contract to call; there is no OAuth here, and `accountId` is whatever
   * the caller asserts. Whoever is authenticated at that point is what makes the
   * claim trustworthy, and that decision belongs to the phase that adds real
   * identities.
   *
   * @param {unknown} body
   * @returns {{license: object, linkedAccountId: string|null, serverTime: number}}
   */
  function bind(body) {
    const now = serverNow();
    const fields = pickClientFields(body);

    if (!fields.accountId) {
      throw new LicenseError(ERROR_CODES.INVALID_REQUEST, {
        detail: 'accountId is required',
      });
    }

    // A session identifies the licence; a bare code is accepted so an operator
    // can bind during onboarding. The session path is the one a client uses.
    const record = fields.sessionToken
      ? authenticateBySession(fields.sessionToken, now)
      : authenticateByCode(requireCode(fields.licenseCode), now);

    const linkedAccountId = applyAccountBinding(record, fields.accountId);
    log(`licence ${record.id} binding evaluated -> ${linkedAccountId}`);

    return {
      license: entitlementFor(record, now),
      linkedAccountId,
      serverTime: now,
    };
  }

  return {
    // admin / operator plane
    createLicense,
    suspend,
    revoke,
    reactivate,
    setStatus,
    getLicense,
    // client plane
    activate,
    verify,
    bind,
    /** Server clock, re-exposed so routes and tests share one notion of now. */
    serverNow,
  };
}