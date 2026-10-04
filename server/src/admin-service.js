/**
 * The admin licence service: what the operator plane may do with licences.
 *
 * This module deliberately contains no licence *rules*. Creating, suspending,
 * reactivating and revoking are the same decisions the customer plane has
 * always made, and they are still made in ./service.js — this file only chooses
 * which of those existing operations to call and how to present the result.
 * Duplicating the rules here would give the project two answers to "can this
 * licence still be used", and the two would drift.
 *
 * Its real job is the projection. An admin screen shows more than a customer
 * screen does — expiry, activation, the bound account, install metadata, the
 * internal note — and "more" is where leaks come from. So the shape handed out
 * is written out field by field below, rather than the record being spread and
 * hoped over:
 *
 *   never present  codeHash, codeSalt, codeLookup, session tokens,
 *                  OAuth access/refresh tokens, the Google client secret
 *   present        ids, effective status, timestamps, bound account id,
 *                  platform/app-version/install metadata, internal note
 *
 * And the single exception is stated in one place: `createLicense` returns the
 * plaintext code, because an operator has to be able to read it once to hand it
 * to a customer. It is returned at creation and nowhere else, ever — the server
 * stores only the scrypt hash and cannot reconstruct it afterwards, which is the
 * property that makes "shown exactly once" a guarantee rather than a promise.
 */

import { ERROR_CODES, LicenseError } from './errors.js';
import { LICENSE_STATUSES, STATUS_EXPIRED, effectiveStatus } from './model.js';

/**
 * Statuses an operator may filter by.
 *
 * The three stored ones plus `expired`. Not the stored list: an operator looking
 * for "the licences that ran out" is asking about lapsed ones, and a filter
 * without `expired` would report the opposite of the truth.
 */
const ADMIN_FILTERABLE_STATUSES = Object.freeze([...LICENSE_STATUSES, STATUS_EXPIRED]);

/** Largest internal note accepted, so one request cannot stuff the row. */
const MAX_NOTE_LENGTH = 2000;

/** Largest reason string accepted on a status change. */
const MAX_REASON_LENGTH = 500;

/**
 * Shapes one licence record for the admin surface.
 *
 * An allowlist, written out. A field that is not named here cannot ship, so
 * adding a column to the licence table cannot accidentally start leaking it to
 * the operator screen.
 *
 * @param {import('./repository.js').LicenseRecord} record
 * @param {number} nowMs
 * @returns {object}
 */
export function adminLicenseView(record, nowMs) {
  return {
    id: record.id,
    /** Effective, so a lapsed licence reads as `expired` without a job having to write it. */
    status: effectiveStatus(record, nowMs),
    /** The stored status, kept alongside so an admin can tell *why* it expired. */
    storedStatus: record.status,
    createdAt: record.createdAt,
    activatedAt: record.activatedAt ?? null,
    expiresAt: record.expiresAt ?? null,
    linkedAccountId: record.linkedAccountId ?? null,
    lastVerifiedAt: record.lastVerifiedAt ?? null,
    note: record.note ?? null,
  };
}

/**
 * Shapes install metadata. An `installId` is included because it is what makes
 * a support conversation possible, and it is a random client-generated handle —
 * not a device fingerprint, and not anything about the shop's contents.
 *
 * @param {object} install
 * @returns {object}
 */
function adminInstallView(install) {
  return {
    installId: install.installId,
    platform: install.platform ?? null,
    appVersion: install.appVersion ?? null,
    firstSeenAt: install.firstSeenAt,
    lastSeenAt: install.lastSeenAt,
    lastVerifiedAt: install.lastVerifiedAt ?? null,
  };
}

/**
 * Trims an operator-supplied free-text field, refusing rather than silently
 * truncating so a note that arrives cut in half is obvious.
 *
 * @param {unknown} value
 * @param {string} field
 * @param {number} max
 * @param {boolean} required
 * @returns {string|null}
 */
function readText(value, field, max, required) {
  if (value === undefined || value === null) {
    if (required) {
      throw new LicenseError(ERROR_CODES.INVALID_REQUEST, { detail: `${field} is required` });
    }
    return null;
  }
  if (typeof value !== 'string') {
    throw new LicenseError(ERROR_CODES.INVALID_REQUEST, { detail: `${field} must be a string` });
  }
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) {
      throw new LicenseError(ERROR_CODES.INVALID_REQUEST, { detail: `${field} must not be empty` });
    }
    return null;
  }
  if (trimmed.length > max) {
    throw new LicenseError(ERROR_CODES.INVALID_REQUEST, {
      detail: `${field} exceeds ${max} characters`,
    });
  }
  return trimmed;
}

/**
 * @param {unknown} value
 * @returns {number|null} days, or null for perpetual
 */
function readExpiryDays(value) {
  if (value === undefined || value === null || value === '') return null;
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0 || days > 36500) {
    throw new LicenseError(ERROR_CODES.INVALID_REQUEST, {
      detail: 'expiresInDays must be a positive number of days (max 36500)',
    });
  }
  return Math.trunc(days);
}

/**
 * Builds the admin licence service.
 *
 * @param {{
 *   licenseService: ReturnType<typeof import('./service.js').createLicenseService>,
 *   repository: import('./repository.js').LicenseRepository,
 *   clock: () => number,
 *   log?: (message: string, detail?: unknown) => void,
 * }} deps
 */
export function createAdminLicenseService({ licenseService, repository, clock, log = () => {} }) {
  /** @returns {number} the one clock every timestamp below comes from. */
  function serverNow() {
    return Math.trunc(clock());
  }

  /**
   * Lists licences, newest first.
   *
   * `status` filters on the status the operator sees, which includes the derived
   * `expired`. Passing the server clock down is what makes that filter agree with
   * the badges in the same response — a filter and a column that disagree would
   * be worse than either being absent.
   *
   * @param {{status?: string|null, limit?: number, offset?: number}} [options]
   * @returns {{licenses: object[], total: number, limit: number, offset: number, status: string|null}}
   */
  function listLicenses(options = {}) {
    const status = options.status ?? null;
    if (status !== null && !ADMIN_FILTERABLE_STATUSES.includes(status)) {
      throw new LicenseError(ERROR_CODES.INVALID_REQUEST, {
        detail: `status must be one of ${ADMIN_FILTERABLE_STATUSES.join(', ')}`,
      });
    }

    const now = serverNow();
    const { records, total } = repository.listLicenses({
      status,
      limit: options.limit,
      offset: options.offset,
      now,
    });
    return {
      licenses: records.map((record) => adminLicenseView(record, now)),
      total,
      limit: options.limit ?? 50,
      offset: options.offset ?? 0,
      status,
    };
  }

  /**
   * Reads one licence with everything an operator legitimately needs.
   *
   * Shaped as `{ license, installs }` to match every other write operation here,
   * so a client can read `body.license` without special-casing this one route.
   *
   * @param {string} id
   * @returns {{license: object, installs: object[]}}
   */
  function getLicense(id) {
    const record = repository.findById(id);
    if (!record) throw new LicenseError(ERROR_CODES.LICENSE_NOT_FOUND);
    return {
      license: adminLicenseView(record, serverNow()),
      installs: repository.listInstalls(id).map(adminInstallView),
    };
  }

  /**
   * Issues a licence and returns the plaintext code.
   *
   * The code appears in this response and nowhere else, ever — see the note at
   * the top of this file. It is not logged, not written to an event, and not
   * recoverable from the database afterwards.
   *
   * @param {{expiresInDays?: number|null, note?: string|null}} [options]
   * @returns {{license: object, code: string}}
   */
  function createLicense(options = {}) {
    const expiresInDays = readExpiryDays(options.expiresInDays);
    const note = readText(options.note, 'note', MAX_NOTE_LENGTH, false);

    const { license, code } = licenseService.createLicense({ expiresInDays, note });
    log(`admin issued licence ${license.id}`);
    // The code is deliberately not included in the log line above.
    return { license, code };
  }

  /**
   * @param {string} id
   * @param {unknown} [reason]
   * @returns {object}
   */
  function suspend(id, reason) {
    const result = licenseService.suspend(id, readText(reason, 'reason', MAX_REASON_LENGTH, false));
    return { license: result };
  }

  /**
   * @param {string} id
   * @param {unknown} [reason]
   * @returns {object}
   */
  function reactivate(id, reason) {
    const result = licenseService.reactivate(id, readText(reason, 'reason', MAX_REASON_LENGTH, false));
    return { license: result };
  }

  /**
   * @param {string} id
   * @param {unknown} [reason]
   * @returns {object}
   */
  function revoke(id, reason) {
    const result = licenseService.revoke(id, readText(reason, 'reason', MAX_REASON_LENGTH, false));
    return { license: result };
  }

  /**
   * Stores or clears the internal note.
   *
   * @param {string} id
   * @param {unknown} note
   * @returns {object}
   */
  function setNote(id, note) {
    const value = readText(note, 'note', MAX_NOTE_LENGTH, false);
    const record = repository.findById(id);
    if (!record) throw new LicenseError(ERROR_CODES.LICENSE_NOT_FOUND);

    repository.setNote(id, value);
    repository.recordEvent({
      licenseId: id,
      event: value === null ? 'note_cleared' : 'note_updated',
    });
    log(`admin updated the note on licence ${id}`);

    return { license: adminLicenseView({ ...record, note: value }, serverNow()) };
  }

  /**
   * Reads the state-change trail. Metadata only — the events are timestamps,
   * install ids and short reasons, never licence codes or session material.
   *
   * @param {string} id
   * @param {{limit?: number, offset?: number}} [options]
   * @returns {{events: object[], limit: number, offset: number}}
   */
  function listEvents(id, options = {}) {
    if (!repository.findById(id)) throw new LicenseError(ERROR_CODES.LICENSE_NOT_FOUND);
    return {
      events: repository.listEvents(id, options),
      limit: options.limit ?? 100,
      offset: options.offset ?? 0,
    };
  }

  return {
    listLicenses,
    getLicense,
    createLicense,
    suspend,
    reactivate,
    revoke,
    setNote,
    listEvents,
    serverNow,
  };
}
