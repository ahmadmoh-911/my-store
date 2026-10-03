/**
 * Machine-readable error codes and the error type the whole backend throws.
 *
 * Every failure the client can act on has a stable code here. The `message` is
 * for humans debugging a log line and may change; the `code` is a contract and
 * must not. The client switches on the code, never on the text.
 */

export const ERROR_CODES = Object.freeze({
  /** Body was not JSON, or a field was missing / the wrong shape. */
  INVALID_REQUEST: 'INVALID_REQUEST',
  /** A code was supplied but is not even shaped like SH-XXXX-XXXX-XXXX. */
  INVALID_LICENSE: 'INVALID_LICENSE',
  /** Well-formed code, but nothing on the server matches it. */
  LICENSE_NOT_FOUND: 'LICENSE_NOT_FOUND',
  /** Valid licence, but already tied to a different account id. */
  LICENSE_ALREADY_BOUND: 'LICENSE_ALREADY_BOUND',
  /** Licence exists and the code is right, but an admin suspended it. */
  LICENSE_SUSPENDED: 'LICENSE_SUSPENDED',
  /** Licence exists and the code is right, but expiresAt is in the past. */
  LICENSE_EXPIRED: 'LICENSE_EXPIRED',
  /** Licence was permanently revoked. Never restorable. */
  LICENSE_REVOKED: 'LICENSE_REVOKED',
  /** The session's licence is bound to a different account than the request. */
  ACCOUNT_MISMATCH: 'ACCOUNT_MISMATCH',
  /** The bearer session token is unknown, revoked, or malformed. */
  INVALID_SESSION: 'INVALID_SESSION',
  /** Catch-all for unexpected server faults; details go to the log, not out. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

/** Short, non-leaking human text for each code. */
const MESSAGES = Object.freeze({
  [ERROR_CODES.INVALID_REQUEST]: 'The request body is missing required fields or is malformed.',
  [ERROR_CODES.INVALID_LICENSE]: 'The licence code is not in the expected format.',
  [ERROR_CODES.LICENSE_NOT_FOUND]: 'No licence matches those details.',
  [ERROR_CODES.LICENSE_ALREADY_BOUND]: 'This licence is already bound to another account.',
  [ERROR_CODES.LICENSE_SUSPENDED]: 'This licence is suspended.',
  [ERROR_CODES.LICENSE_EXPIRED]: 'This licence has expired.',
  [ERROR_CODES.LICENSE_REVOKED]: 'This licence has been revoked.',
  [ERROR_CODES.ACCOUNT_MISMATCH]: 'This licence belongs to a different account.',
  [ERROR_CODES.INVALID_SESSION]: 'The session token is missing, unknown, or revoked.',
  [ERROR_CODES.INTERNAL_ERROR]: 'The server could not complete the request.',
});

/**
 * HTTP status per error code.
 *
 * Deliberately blunt: a caller learns whether it was *their* request that was
 * wrong (4xx) or ours (5xx), nothing more. Statuses are not an authorisation
 * channel — the code carries the meaning.
 */
const STATUSES = Object.freeze({
  [ERROR_CODES.INVALID_REQUEST]: 400,
  [ERROR_CODES.INVALID_LICENSE]: 400,
  [ERROR_CODES.LICENSE_NOT_FOUND]: 404,
  [ERROR_CODES.LICENSE_ALREADY_BOUND]: 409,
  [ERROR_CODES.LICENSE_SUSPENDED]: 403,
  [ERROR_CODES.LICENSE_EXPIRED]: 403,
  [ERROR_CODES.LICENSE_REVOKED]: 403,
  [ERROR_CODES.ACCOUNT_MISMATCH]: 403,
  [ERROR_CODES.INVALID_SESSION]: 401,
  [ERROR_CODES.INTERNAL_ERROR]: 500,
});

/**
 * An error the client is allowed to see.
 *
 * @param {string} code One of ERROR_CODES.
 * @param {{message?: string, status?: number, detail?: unknown}} [options]
 */
export class LicenseError extends Error {
  constructor(code, options = {}) {
    const message = options.message || MESSAGES[code] || 'Unknown error.';
    super(message);
    this.name = 'LicenseError';
    this.code = code;
    this.status = options.status || STATUSES[code] || 500;
    /** Server-side only. Logged, never serialised into a response. */
    this.detail = options.detail;
  }
}

/** @returns {boolean} true when `value` is a usable LicenseError. */
export function isLicenseError(value) {
  return value instanceof LicenseError;
}

/**
 * The JSON body shape for a failure. Built here so no route handler can invent
 * its own error format by accident.
 *
 * @param {string} code
 * @param {number} serverTime epoch ms, generated on the server
 * @param {string} [message] override text for the log line
 */
export function errorBody(code, serverTime, message) {
  return {
    ok: false,
    error: { code, message: message || MESSAGES[code] || 'Unknown error.' },
    serverTime,
  };
}