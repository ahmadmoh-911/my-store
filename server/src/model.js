/**
 * The licence data model: statuses, record shapes, and the whitelist that keeps
 * client-supplied data out of the licence tables.
 */

/** The stored statuses. `expired` is deliberately absent — see `effectiveStatus`. */
export const STATUS_ACTIVE = 'active';
export const STATUS_SUSPENDED = 'suspended';
export const STATUS_REVOKED = 'revoked';

export const LICENSE_STATUSES = Object.freeze([
  STATUS_ACTIVE,
  STATUS_SUSPENDED,
  STATUS_REVOKED,
]);

/** The status the outside world sees, which includes the derived one. */
export const STATUS_EXPIRED = 'expired';

/**
 * The status a client should act on.
 *
 * `expired` is computed from `expiresAt` rather than stored, because a stored
 * expiry has to be written by something — a nightly job, or every reader
 * checking and flipping — and any of those is a window in which a lapsed
 * licence still reads as active. Deriving it means an expired licence is
 * expired the instant it lapses, with no job to forget to run.
 *
 * Only an otherwise-active licence expires: a suspended or revoked licence
 * keeps reporting why it stopped working, which is the more useful answer.
 *
 * @param {{status: string, expiresAt: number|null}} record
 * @param {number} nowMs server clock
 * @returns {'active'|'suspended'|'expired'|'revoked'}
 */
export function effectiveStatus(record, nowMs) {
  if (record.status === STATUS_SUSPENDED) return STATUS_SUSPENDED;
  if (record.status === STATUS_REVOKED) return STATUS_REVOKED;
  if (typeof record.expiresAt === 'number' && record.expiresAt <= nowMs) {
    return STATUS_EXPIRED;
  }
  return STATUS_ACTIVE;
}

/** @returns {boolean} true when the licence currently entitles the store to run. */
export function isEntitled(record, nowMs) {
  return effectiveStatus(record, nowMs) === STATUS_ACTIVE;
}

/* ------------------------------------------------------------------ *
 * What the client is allowed to send
 * ------------------------------------------------------------------ */

/** Fields describing the install. Metadata only — never store contents. */
const ALLOWED_CLIENT_FIELDS = Object.freeze([
  'installId',
  'platform',
  'appVersion',
]);

/** Hard limit on any client string, so one request cannot stuff the database. */
const MAX_FIELD_LENGTH = Object.freeze({
  installId: 64,
  platform: 32,
  appVersion: 32,
  accountId: 128,
  licenseCode: 64,
  sessionToken: 128,
});

/** @returns {number} the length cap for a known field. */
export function fieldLimit(field) {
  return MAX_FIELD_LENGTH[field] || 64;
}

/**
 * Reduces a request body to exactly the fields the licence layer understands.
 *
 * This is the enforcement point for the project's central security rule: the
 * backend stores licence and identity metadata *only*. A client that sends its
 * entire store — products, sales, invoices, customers, backup files — has those
 * keys dropped here, before any query runs. They are not ignored politely by
 * luck; they are removed by construction.
 *
 * Nothing is forwarded because a field "looks harmless". The list above is the
 * whole vocabulary.
 *
 * @param {unknown} body parsed JSON body
 * @returns {{installId?: string, platform?: string, appVersion?: string, accountId?: string, licenseCode?: string, sessionToken?: string}}
 */
export function pickClientFields(body) {
  const allowed = [
    ...ALLOWED_CLIENT_FIELDS,
    'accountId',
    'licenseCode',
    'sessionToken',
  ];
  const source = body && typeof body === 'object' ? body : {};
  const out = {};
  for (const field of allowed) {
    const value = source[field];
    if (typeof value === 'string' && value.length > 0) {
      out[field] = value.slice(0, fieldLimit(field));
    }
  }
  return out;
}

/** @returns {string[]} the names of keys the client sent that were discarded. */
export function rejectedClientFields(body) {
  const source = body && typeof body === 'object' ? body : {};
  const allowed = new Set([
    ...ALLOWED_CLIENT_FIELDS,
    'accountId',
    'licenseCode',
    'sessionToken',
  ]);
  return Object.keys(source).filter((key) => !allowed.has(key));
}

/**
 * The minimum entitlement payload handed to a client.
 *
 * Deliberately thin: id, status, and expiry. A client has no use for the code
 * hash, the creation timestamp, or the bound account id, and every field that
 * ships is a field that can leak from a stolen device or a bug report.
 *
 * @param {object} record licence record
 * @param {number} nowMs
 * @returns {{id: string, status: string, expiresAt: number|null}}
 */
export function entitlementFor(record, nowMs) {
  return {
    id: record.id,
    status: effectiveStatus(record, nowMs),
    expiresAt: record.expiresAt ?? null,
  };
}