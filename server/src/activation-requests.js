/**
 * Activation requests — what customers submit when they need help:
 *
 *   - activate:    "I bought a licence code, help me activate it"
 *   - device_transfer: "I moved to a new phone, move my licence"
 *   - license_issue:  "My licence stopped working / was revoked by mistake"
 *   - support:     general technical support
 *
 * The backend stores the request and lets an admin review it in the portal.
 * Approving a request does NOT issue a licence — that remains a separate
 * admin action (POST /api/admin/licenses). This keeps the two concerns
 * apart: request intake vs licence issuance.
 *
 * No customer data beyond what the customer voluntarily types is stored.
 * The google_sub is recorded only when the customer is already signed in,
 * so the admin can tie the request to an account without the customer
 * having to prove who they are twice.
 */

import { ERROR_CODES, LicenseError } from './errors.js';

/** Largest free-text fields accepted. */
const MAX_DESCRIPTION = 2000;
const MAX_STORE_NAME = 200;
const MAX_REQUESTER_NAME = 200;
const MAX_CONTACT = 200;

const VALID_TYPES = new Set(['activation', 'device_transfer', 'license_issue', 'support']);
const VALID_STATUSES = new Set(['new', 'in_progress', 'completed', 'rejected']);

/**
 * Reads a bounded text field, trimming and refusing oversized input.
 */
function readText(value, field, max, required) {
  if (value === undefined || value === null) {
    if (required) throw new LicenseError(ERROR_CODES.INVALID_REQUEST, { detail: `${field} is required` });
    return null;
  }
  if (typeof value !== 'string') throw new LicenseError(ERROR_CODES.INVALID_REQUEST, { detail: `${field} must be a string` });
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new LicenseError(ERROR_CODES.INVALID_REQUEST, { detail: `${field} must not be empty` });
    return null;
  }
  if (trimmed.length > max) throw new LicenseError(ERROR_CODES.INVALID_REQUEST, { detail: `${field} exceeds ${max} characters` });
  return trimmed;
}

/** Builds the activation-request service around a PostgreSQL client. */
export function createActivationRequestService({ pgClient, clock = () => Date.now(), log = () => {} }) {
  /** @returns {number} epoch ms */
  function now() { return Math.trunc(clock()); }

  /**
   * Submits a new request. Idempotent under `idempotencyKey`: the same key
   * twice returns the same record without creating a duplicate.
   *
   * @param {{id, type, storeName, requesterName, contact, description,
   *           appVersion, platform, installId, googleSub, idempotencyKey}} input
   * @returns {{request: object, created: boolean}}
   */
  async function submitRequest(input) {
    const id = input.id;
    const type = readText(input.type, 'type', 50, true);
    if (!VALID_TYPES.has(type)) {
      throw new LicenseError(ERROR_CODES.INVALID_REQUEST, {
        detail: `type must be one of ${[...VALID_TYPES].join(', ')}`,
      });
    }
    const storeName = readText(input.storeName, 'storeName', MAX_STORE_NAME, true);
    const requesterName = readText(input.requesterName, 'requesterName', MAX_REQUESTER_NAME, true);
    const contact = readText(input.contact, 'contact', MAX_CONTACT, false);
    const description = readText(input.description, 'description', MAX_DESCRIPTION, true);
    const appVersion = readText(input.appVersion, 'appVersion', 50, false);
    const platform = readText(input.platform, 'platform', 50, false);
    const installId = readText(input.installId, 'installId', 100, false);
    const googleSub = readText(input.googleSub, 'googleSub', 100, false);

    const t = now();

    // Idempotency: if a request with this id already exists, return it.
    if (id) {
      const existing = await pgClient.query(
        'SELECT id, type, status, store_name, requester_name, contact, description, ' +
        'app_version, platform, install_id, google_sub, linked_license_id, admin_note, ' +
        'resolved_by, resolved_at, created_at, updated_at ' +
        'FROM activation_requests WHERE id = $1',
        [id]
      );
      if (existing.rows.length > 0) {
        const r = existing.rows[0];
        return { request: rowToRequest(r), created: false };
      }
    }

    const res = await pgClient.query(
      `INSERT INTO activation_requests (
        id, type, status, store_name, requester_name, contact, description,
        app_version, platform, install_id, google_sub, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING id, type, status, store_name, requester_name, contact, description,
                app_version, platform, install_id, google_sub, linked_license_id,
                admin_note, resolved_by, resolved_at, created_at, updated_at`,
      [
        id, type, 'new', storeName, requesterName, contact, description,
        appVersion, platform, installId, googleSub, t, t,
      ]
    );

    log('activation request created', { requestId: id, type, googleSub: googleSub ?? null });
    return { request: rowToRequest(res.rows[0]), created: true };
  }

  /**
   * Lists requests, newest first, with optional status filter and pagination.
   *
   * @param {{status?: string|null, limit?: number, offset?: number}} options
   * @returns {{requests: object[], total: number, limit: number, offset: number}}
   */
  async function listRequests(options = {}) {
    const status = options.status ?? null;
    if (status !== null && !VALID_STATUSES.has(status)) {
      throw new LicenseError(ERROR_CODES.INVALID_REQUEST, {
        detail: `status must be one of ${[...VALID_STATUSES].join(', ')}`,
      });
    }
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
    const offset = Math.max(Number(options.offset) || 0, 0);

    const params = [];
    let where = '';
    if (status) {
      params.push(status);
      where = `WHERE status = $${params.length}`;
    }
    params.push(limit, offset);

    const [rows, countResult] = await Promise.all([
      pgClient.query(
        `SELECT id, type, status, store_name, requester_name, contact, description,
                app_version, platform, install_id, google_sub, linked_license_id,
                admin_note, resolved_by, resolved_at, created_at, updated_at
         FROM activation_requests ${where}
         ORDER BY created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      ),
      pgClient.query(
        `SELECT COUNT(*) FROM activation_requests ${where}`,
        status ? [status] : []
      ),
    ]);

    return {
      requests: rows.rows.map(rowToRequest),
      total: parseInt(countResult.rows[0].count, 10),
      limit,
      offset,
      status,
    };
  }

  /**
   * Reads one request by id.
   */
  async function getRequest(id) {
    const res = await pgClient.query(
      `SELECT id, type, status, store_name, requester_name, contact, description,
                app_version, platform, install_id, google_sub, linked_license_id,
                admin_note, resolved_by, resolved_at, created_at, updated_at
       FROM activation_requests WHERE id = $1`,
      [id]
    );
    if (res.rows.length === 0) throw new LicenseError(ERROR_CODES.INVALID_REQUEST, { detail: 'request not found' });
    return rowToRequest(res.rows[0]);
  }

  /**
   * Updates the status (and optional admin note / linked licence) of a request.
   * Records who made the change and when.
   *
   * @param {string} id
   * @param {{status?, adminNote?, linkedLicenseId?, resolvedBy?}} input
   * @returns {object} the updated request
   */
  async function updateRequest(id, input = {}) {
    const current = await getRequest(id);

    const updates = [];
    const params = [];
    let paramIdx = 1;

    if (input.status !== undefined) {
      if (!VALID_STATUSES.has(input.status)) {
        throw new LicenseError(ERROR_CODES.INVALID_REQUEST, {
          detail: `status must be one of ${[...VALID_STATUSES].join(', ')}`,
        });
      }
      updates.push(`status = $${paramIdx++}`);
      params.push(input.status);
    }
    if (input.adminNote !== undefined) {
      const note = readText(input.adminNote, 'adminNote', 2000, false);
      updates.push(`admin_note = $${paramIdx++}`);
      params.push(note);
    }
    if (input.linkedLicenseId !== undefined) {
      updates.push(`linked_license_id = $${paramIdx++}`);
      params.push(input.linkedLicenseId || null);
    }
    if (input.resolvedBy !== undefined) {
      updates.push(`resolved_by = $${paramIdx++}`);
      params.push(input.resolvedBy || null);
    }

    // resolved_at changes whenever status changes
    if (input.status !== undefined && input.status !== current.status) {
      updates.push(`resolved_at = $${paramIdx++}`);
      params.push(now());
    }
    updates.push(`updated_at = $${paramIdx++}`);
    params.push(now());

    params.push(id);

    const res = await pgClient.query(
      `UPDATE activation_requests
       SET ${updates.join(', ')}
       WHERE id = $${paramIdx}
       RETURNING id, type, status, store_name, requester_name, contact, description,
                 app_version, platform, install_id, google_sub, linked_license_id,
                 admin_note, resolved_by, resolved_at, created_at, updated_at`,
      params
    );

    if (res.rows.length === 0) throw new LicenseError(ERROR_CODES.INVALID_REQUEST, { detail: 'request not found' });

    log('activation request updated', { requestId: id, status: input.status, resolvedBy: input.resolvedBy ?? null });
    return rowToRequest(res.rows[0]);
  }

  /** Count of requests by status — for the admin dashboard badge. */
  async function countsByStatus() {
    const res = await pgClient.query(
      `SELECT status, COUNT(*) AS c FROM activation_requests GROUP BY status`
    );
    const out = {};
    for (const s of VALID_STATUSES) out[s] = 0;
    for (const row of res.rows) out[row.status] = parseInt(row.c, 10);
    return out;
  }

  return {
    submitRequest,
    listRequests,
    getRequest,
    updateRequest,
    countsByStatus,
  };
}

/** Maps a database row to a camelCase request object. */
function rowToRequest(r) {
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    storeName: r.store_name,
    requesterName: r.requester_name,
    contact: r.contact ?? null,
    description: r.description,
    appVersion: r.app_version ?? null,
    platform: r.platform ?? null,
    installId: r.install_id ?? null,
    googleSub: r.google_sub ?? null,
    linkedLicenseId: r.linked_license_id ?? null,
    adminNote: r.admin_note ?? null,
    resolvedBy: r.resolved_by ?? null,
    resolvedAt: r.resolved_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
