/**
 * Activation requests service: submission, listing, status updates,
 * authorisation, idempotency, and input validation.
 *
 * Uses a mock PostgreSQL client so no live database or network is required.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createActivationRequestService } from '../src/activation-requests.js';
import { ERROR_CODES } from '../src/errors.js';

/** Minimal mock pg client implementing `query(sql, params)`. */
function mockPg() {
  /** @type {Array<{sql:string, params:any[]}>} */
  const calls = [];
  /** @type {Map<string, object>} requests by id */
  const requests = new Map();
  let shouldFail = false;
  let failOnCall = null; // { nth: number, kind: 'write'|'read' }

  return {
    calls,
    requests,
    setShouldFail(value) { shouldFail = value; },
    setFailOnCall(kind, nth) { failOnCall = { kind, nth }; },
    clearFail() { failOnCall = null; },
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (shouldFail) throw new Error('injected pg failure');
      if (failOnCall) {
        const isWrite = /^\s*(INSERT|UPDATE|DELETE)/i.test(sql);
        const kind = isWrite ? 'write' : 'read';
        if (kind === failOnCall.kind) {
          failOnCall.nth -= 1;
          if (failOnCall.nth <= 0) {
            failOnCall.kind = null;
            throw new Error('injected pg failure');
          }
        }
      }

      // Normalise whitespace so multi-line template literals match.
      const s = sql.trim().replace(/\s+/g, ' ');

      // INSERT
      if (s.startsWith('INSERT INTO activation_requests')) {
        const id = params[0];
        if (requests.has(id)) {
          // Idempotent: return existing row without inserting again
          return { rows: [requests.get(id)] };
        }
        const row = {
          id,
          type: params[1],
          status: params[2],
          store_name: params[3],
          requester_name: params[4],
          contact: params[5],
          description: params[6],
          app_version: params[7],
          platform: params[8],
          install_id: params[9],
          google_sub: params[10],
          linked_license_id: null,
          admin_note: null,
          resolved_by: null,
          resolved_at: null,
          created_at: params[11],
          updated_at: params[12],
        };
        requests.set(id, row);
        return { rows: [row] };
      }

      // SELECT by id
      if (/^SELECT.*FROM activation_requests WHERE id = \$1/i.test(s)) {
        const row = requests.get(params[0]);
        if (!row) return { rows: [] };
        return { rows: [row] };
      }

      // SELECT list
      if (/^SELECT.*FROM activation_requests/i.test(s) && !s.includes('COUNT')) {
        let rows = [...requests.values()].sort((a, b) => b.created_at - a.created_at);
        if (params.length === 3) {
          // [status, limit, offset]
          rows = rows.filter((r) => r.status === params[0]);
          rows = rows.slice(params[2], params[2] + params[1]);
        } else if (params.length === 2) {
          // [limit, offset]
          rows = rows.slice(params[1], params[1] + params[0]);
        }
        return { rows };
      }

      // SELECT COUNT(*) (possibly with GROUP BY)
      if (/COUNT\s*\(/i.test(s)) {
        if (/GROUP BY\s+status/i.test(s)) {
          const agg = {};
          for (const r of requests.values()) agg[r.status] = (agg[r.status] || 0) + 1;
          return { rows: Object.entries(agg).map(([status, c]) => ({ status, c: String(c) })) };
        }
        let all = [...requests.values()];
        if (params.length === 1) all = all.filter((r) => r.status === params[0]);
        return { rows: [{ count: String(all.length) }] };
      }

      // UPDATE
      if (/^UPDATE activation_requests/i.test(s)) {
        const id = params[params.length - 1];
        const row = requests.get(id);
        if (!row) return { rows: [] };

        // Parse SET clause to map params positionally to fields
        const setMatch = s.match(/SET\s+([^)]+?)\s+WHERE/i);
        if (setMatch) {
          const fields = setMatch[1].split(',').map((p) => p.trim().split(' = ')[0]);
          let paramIdx = 0;
          for (const field of fields) {
            const value = params[paramIdx++];
            if (field === 'status') row.status = value;
            else if (field === 'admin_note') row.admin_note = value;
            else if (field === 'linked_license_id') row.linked_license_id = value;
            else if (field === 'resolved_by') row.resolved_by = value;
            else if (field === 'resolved_at') row.resolved_at = value;
            else if (field === 'updated_at') row.updated_at = value;
          }
        }
        requests.set(id, row);
        return { rows: [row] };
      }

      return { rows: [] };
    },
    close() {},
  };
}

/** Builds a service on a mock pg client. */
function buildService(opts = {}) {
  const pg = mockPg();
  let nowValue = Date.parse('2026-11-01T10:00:00.000Z');
  const clock = () => nowValue;
  const service = createActivationRequestService({
    pgClient: pg,
    clock,
    log: () => {},
  });
  return { service, pg, clock: { setNow: (v) => { nowValue = v; } } };
}

/** A valid minimal request payload. */
function validPayload(overrides = {}) {
  return {
    id: 'req-valid-001',
    type: 'activation',
    storeName: 'متجر النور',
    requesterName: 'أحمد محمد',
    contact: '+972599123456',
    description: 'أحتاج تفعيل الترخيص على هاتف جديد.',
    appVersion: '1.0.0',
    platform: 'android',
    installId: 'install-abc',
    googleSub: 'google-sub-123',
    ...overrides,
  };
}

/** ---------------------------------------------------------------- *
 *  1 · valid submission
 * ---------------------------------------------------------------- */

test('1. creates a valid activation request and returns it', async (t) => {
  const { service, pg } = buildService();

  const result = await service.submitRequest(validPayload());

  assert.equal(result.created, true);
  assert.equal(result.request.id, 'req-valid-001');
  assert.equal(result.request.status, 'new');
  assert.equal(result.request.storeName, 'متجر النور');
  assert.equal(result.request.googleSub, 'google-sub-123');
  assert.ok(result.request.createdAt);

  const inserts = pg.calls.filter((c) => /^\s*INSERT/i.test(c.sql));
  assert.equal(inserts.length, 1);
});

test('1b. stores optional fields as null when absent', async (t) => {
  const { service } = buildService();
  const { id, type, storeName, requesterName, description } = validPayload();

  const result = await service.submitRequest({ id, type, storeName, requesterName, description });

  assert.equal(result.request.contact, null);
  assert.equal(result.request.appVersion, null);
  assert.equal(result.request.platform, null);
  assert.equal(result.request.installId, null);
  assert.equal(result.request.googleSub, null);
});

/** ---------------------------------------------------------------- *
 *  2 · input validation (invalid / long fields)
 * ---------------------------------------------------------------- */

test('2. rejects missing required fields', async (t) => {
  const { service } = buildService();
  await assert.rejects(() => service.submitRequest({}), { code: ERROR_CODES.INVALID_REQUEST });
});

test('2b. rejects invalid type', async (t) => {
  const { service } = buildService();
  await assert.rejects(
    () => service.submitRequest(validPayload({ type: 'magic' })),
    { code: ERROR_CODES.INVALID_REQUEST }
  );
});

test('2c. rejects storeName exceeding 200 chars', async (t) => {
  const { service } = buildService();
  await assert.rejects(
    () => service.submitRequest(validPayload({ storeName: 'x'.repeat(201) })),
    { code: ERROR_CODES.INVALID_REQUEST }
  );
});

test('2d. rejects description exceeding 2000 chars', async (t) => {
  const { service } = buildService();
  await assert.rejects(
    () => service.submitRequest(validPayload({ description: 'x'.repeat(2001) })),
    { code: ERROR_CODES.INVALID_REQUEST }
  );
});

test('2e. rejects contact exceeding 200 chars', async (t) => {
  const { service } = buildService();
  await assert.rejects(
    () => service.submitRequest(validPayload({ contact: 'x'.repeat(201) })),
    { code: ERROR_CODES.INVALID_REQUEST }
  );
});

test('2f. trims whitespace and accepts empty optional contact', async (t) => {
  const { service } = buildService();
  const result = await service.submitRequest(
    validPayload({ contact: '   ', storeName: '  متجر  ' })
  );
  assert.equal(result.request.contact, null);
  assert.equal(result.request.storeName, 'متجر');
});

/** ---------------------------------------------------------------- *
 *  3 · idempotency (double submit / retry)
 * ---------------------------------------------------------------- */

test('3. same idempotency key returns existing request, no duplicate row', async (t) => {
  const { service, pg } = buildService();
  const payload = validPayload();

  const first = await service.submitRequest(payload);
  const second = await service.submitRequest(payload);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.request.id, second.request.id);

  const inserts = pg.calls.filter((c) => /^\s*INSERT/i.test(c.sql));
  assert.equal(inserts.length, 1, 'only one INSERT despite two submissions');
});

test('3b. a different id creates a separate request', async (t) => {
  const { service } = buildService();
  const first = await service.submitRequest(validPayload({ id: 'req-a' }));
  const second = await service.submitRequest(validPayload({ id: 'req-b' }));

  assert.equal(first.created, true);
  assert.equal(second.created, true);
  assert.notEqual(first.request.id, second.request.id);
});

/** ---------------------------------------------------------------- *
 *  4 · rate limiting is in http layer, not service
 * ---------------------------------------------------------------- */

test('4. service itself does not rate-limit (rate limit is in http layer)', async (t) => {
  const { service } = buildService();
  const results = await Promise.all([
    service.submitRequest(validPayload({ id: 'r-1' })),
    service.submitRequest(validPayload({ id: 'r-2' })),
    service.submitRequest(validPayload({ id: 'r-3' })),
  ]);
  assert.equal(results.every((r) => r.created === true), true);
});

/** ---------------------------------------------------------------- *
 *  5 · list + get + update (admin operations)
 * ---------------------------------------------------------------- */

test('5. lists requests newest first with pagination and status filter', async (t) => {
  const { service, clock } = buildService();
  await service.submitRequest(validPayload({ id: 'r-old', storeName: 'أ' }));
  clock.setNow(Date.parse('2026-11-01T10:00:01.000Z'));
  await service.submitRequest(validPayload({ id: 'r-new', storeName: 'ب' }));

  const all = await service.listRequests({});
  assert.equal(all.total, 2);
  assert.equal(all.requests[0].id, 'r-new');
  assert.equal(all.requests[1].id, 'r-old');

  const page = await service.listRequests({ limit: 1, offset: 1 });
  assert.equal(page.requests.length, 1);
  assert.equal(page.limit, 1);
  assert.equal(page.offset, 1);
});

test('5b. filters by status', async (t) => {
  const { service } = buildService();
  await service.submitRequest(validPayload({ id: 'r1' })); // status new
  await service.submitRequest(validPayload({ id: 'r2' })); // status new
  await service.updateRequest('r2', { status: 'completed', resolvedBy: 'admin-1' });

  const filtered = await service.listRequests({ status: 'completed' });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.requests[0].id, 'r2');
});

test('5c. rejects invalid status filter', async (t) => {
  const { service } = buildService();
  await assert.rejects(
    () => service.listRequests({ status: 'magic' }),
    { code: ERROR_CODES.INVALID_REQUEST }
  );
});

test('5d. getRequest returns one request by id', async (t) => {
  const { service } = buildService();
  await service.submitRequest(validPayload({ id: 'r-get' }));

  const req = await service.getRequest('r-get');
  assert.equal(req.id, 'r-get');
  assert.equal(req.storeName, 'متجر النور');
});

test('5e. getRequest rejects unknown id', async (t) => {
  const { service } = buildService();
  await assert.rejects(() => service.getRequest('nope'), { code: ERROR_CODES.INVALID_REQUEST });
});

test('5f. updateRequest changes status and records admin + time', async (t) => {
  const { service } = buildService();
  await service.submitRequest(validPayload({ id: 'r-upd' }));

  const updated = await service.updateRequest('r-upd', {
    status: 'completed',
    adminNote: 'تم التفعيل يدوياً',
    linkedLicenseId: 'lic-999',
    resolvedBy: 'admin-sub-42',
  });

  assert.equal(updated.status, 'completed');
  assert.equal(updated.adminNote, 'تم التفعيل يدوياً');
  assert.equal(updated.linkedLicenseId, 'lic-999');
  assert.equal(updated.resolvedBy, 'admin-sub-42');
  assert.ok(updated.resolvedAt);
});

test('5g. rejects invalid status on update', async (t) => {
  const { service } = buildService();
  await service.submitRequest(validPayload({ id: 'r-bad' }));
  await assert.rejects(
    () => service.updateRequest('r-bad', { status: 'magic' }),
    { code: ERROR_CODES.INVALID_REQUEST }
  );
});

test('5h. countsByStatus returns tally per status', async (t) => {
  const { service } = buildService();
  await service.submitRequest(validPayload({ id: 'r1' })); // new
  await service.submitRequest(validPayload({ id: 'r2' })); // new
  await service.updateRequest('r2', { status: 'completed', resolvedBy: 'admin-1' });

  const counts = await service.countsByStatus();
  assert.equal(counts.new, 1);
  assert.equal(counts.completed, 1);
  assert.equal(counts.in_progress, 0);
  assert.equal(counts.rejected, 0);
});

/** ---------------------------------------------------------------- *
 *  6 · authorisation boundaries
 * ---------------------------------------------------------------- */

test('6. submitRequest stores client googleSub verbatim (not verified as proof)', async (t) => {
  const { service } = buildService();
  const result = await service.submitRequest(
    validPayload({ googleSub: 'client-claimed-sub-999' })
  );
  assert.equal(result.request.googleSub, 'client-claimed-sub-999');
});

test('6b. updateRequest stores resolvedBy as provided (authorisation enforced at HTTP layer)', async (t) => {
  const { service } = buildService();
  await service.submitRequest(validPayload({ id: 'r-auth' }));

  const updated = await service.updateRequest('r-auth', {
    status: 'rejected',
    resolvedBy: 'anyone-can-put-this',
  });
  assert.equal(updated.resolvedBy, 'anyone-can-put-this');
  assert.equal(updated.status, 'rejected');
});

/** ---------------------------------------------------------------- *
 *  7 · internal notes
 * ---------------------------------------------------------------- */

test('7. admin note stored on update; submit path never accepts adminNote', async (t) => {
  const { service } = buildService();
  await service.submitRequest(validPayload({ id: 'r-note' }));

  await service.updateRequest('r-note', {
    adminNote: 'internal: customer owes money',
    resolvedBy: 'admin-sub-1',
  });

  const fetched = await service.getRequest('r-note');
  assert.equal(fetched.adminNote, 'internal: customer owes money');

  const created = await service.submitRequest(validPayload({ id: 'r-note2' }));
  assert.equal(created.request.adminNote, null);
});

/** ---------------------------------------------------------------- *
 *  8 · database failure without false success
 * ---------------------------------------------------------------- */

test('8. INSERT failure throws and leaves no partial request', async (t) => {
  const { service, pg } = buildService();
  pg.setFailOnCall('write', 1);

  await assert.rejects(() => service.submitRequest(validPayload({ id: 'r-fail' })), /injected pg failure/);
  pg.clearFail();

  const all = await service.listRequests({});
  assert.equal(all.total, 0);
});

test('8b. UPDATE failure throws and leaves original status unchanged', async (t) => {
  const { service, pg } = buildService();
  await service.submitRequest(validPayload({ id: 'r-updfail' }));
  pg.setFailOnCall('write', 1); // the UPDATE call is the 1st write after INSERT already done

  await assert.rejects(
    () => service.updateRequest('r-updfail', { status: 'completed' }),
    /injected pg failure/
  );
  pg.clearFail();

  const stillNew = await service.getRequest('r-updfail');
  assert.equal(stillNew.status, 'new');
});

/** ---------------------------------------------------------------- *
 *  9 · isolation: unknown id is not found
 * ---------------------------------------------------------------- */

test('9. getRequest on unknown id returns not-found', async (t) => {
  const { service } = buildService();
  await service.submitRequest(validPayload({ id: 'r-owner' }));
  await assert.rejects(() => service.getRequest('r-other'), { code: ERROR_CODES.INVALID_REQUEST });
});

/** ---------------------------------------------------------------- *
 *  10 · client identity is not trusted for authorisation
 * ---------------------------------------------------------------- */

test('10. googleSub from client is stored verbatim; service does not verify it', async (t) => {
  const { service } = buildService();
  const result = await service.submitRequest(
    validPayload({ googleSub: 'totally-fake-sub' })
  );
  assert.equal(result.request.googleSub, 'totally-fake-sub');
});
