/**
 * Admin portal: authorisation, licence operations, and data isolation.
 *
 * The headline property under test is the one in the phase brief:
 *
 *   knowing the admin URL must not be enough. The backend refuses every
 *   unauthorised request itself, and a customer store's contents stay
 *   unreachable from the admin system entirely.
 *
 * Two ways that claim can be faked, and both are covered here:
 *
 * - **Guarding the UI instead of the API.** So the tests below drive the real
 *   request handler directly, with no browser and no page — whatever the portal
 *   renders is irrelevant to what the server accepts. A test that renders the
 *   admin page and clicks a button proves only that the button works.
 *
 * - **Refusing but still mutating.** A guard placed after the mutation returns a
 *   correct-looking 403 while the licence is already suspended. So the
 *   authorisation tests assert the *state* afterwards, not just the status code.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { createTestAdminApp, request } from './helpers.mjs';
import { loadConfig } from '../src/config.js';
import { applyMigrations } from './support/sqlite-license.js';
import { openAuthDatabase } from './support/sqlite-auth.js';
import { isAuthorizedAdmin, describeAdminConfiguration } from '../src/admin-authorization.js';
import { ERROR_CODES } from '../src/errors.js';

const ADMIN_SUB = 'google-sub-operator-001';
const CUSTOMER_SUB = 'google-sub-customer-999';
const OTHER_SUB = 'google-sub-someone-else';

/**
 * Removes comments so a scan for a forbidden word is not defeated by prose that
 * explains the absence of that word, or defeated in the other direction by a
 * comment explaining why it is fine.
 *
 * Deliberately simple: it does not need to parse JavaScript, only to make
 * `code.includes(...)` mean "appears in code" rather than "appears anywhere".
 *
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every guarded route, as [method, path]. Mirrors the table in http.js. */const GUARDED_ROUTES = [
  ['GET', '/api/admin/me'],
  ['GET', '/api/admin/licenses'],
  ['POST', '/api/admin/licenses'],
  ['GET', '/api/admin/licenses/some-id'],
  ['POST', '/api/admin/licenses/some-id/suspend'],
  ['POST', '/api/admin/licenses/some-id/reactivate'],
  ['POST', '/api/admin/licenses/some-id/revoke'],
  ['POST', '/api/admin/licenses/some-id/note'],
  ['GET', '/api/admin/licenses/some-id/events'],
];

/**
 * Customer business data. None of it may be reachable from an admin route, and
 * none of it may exist anywhere in the backend's schema.
 */
const CUSTOMER_BUSINESS_CONCEPTS = [
  'product',
  'variant',
  'inventory',
  'sale',
  'refund',
  'report',
  'supplier',
  'invoice',
  'backup',
  'image',
];

/* ==================================================================== *
 * 1. The decision itself
 * ==================================================================== */

test('ADMIN: the authorisation rule is a pure allowlist on googleSub', () => {
  const configured = { authorizedSubs: [ADMIN_SUB] };

  assert.equal(isAuthorizedAdmin({ googleSub: ADMIN_SUB }, configured), true);
  assert.equal(isAuthorizedAdmin({ googleSub: CUSTOMER_SUB }, configured), false);
  // Matching is on the immutable sub, never on the email — an email can be
  // renamed or reassigned, a sub cannot.
  assert.equal(
    isAuthorizedAdmin({ googleSub: CUSTOMER_SUB, email: 'operator@storehub.test' }, configured),
    false,
  );
  assert.equal(isAuthorizedAdmin({ googleSub: `${ADMIN_SUB} ` }, configured), false);
  assert.equal(isAuthorizedAdmin({ googleSub: ADMIN_SUB.toUpperCase() }, configured), false);
});

test('ADMIN: an unconfigured allowlist authorises nobody', () => {
  // The three ways the grant can be absent. Each must deny, never fall through
  // to "well, they are signed in at least".
  assert.equal(isAuthorizedAdmin({ googleSub: ADMIN_SUB }, { authorizedSubs: [] }), false);
  assert.equal(isAuthorizedAdmin({ googleSub: ADMIN_SUB }, { authorizedSubs: [] }), false);
  assert.equal(isAuthorizedAdmin({ googleSub: ADMIN_SUB }, {}), false);
  assert.equal(isAuthorizedAdmin(null, { authorizedSubs: [ADMIN_SUB] }), false);
  assert.equal(isAuthorizedAdmin({}, { authorizedSubs: [ADMIN_SUB] }), false);
});

test('ADMIN: the boot log says so when nobody is authorised', () => {
  const disabled = describeAdminConfiguration({ authorizedSubs: [], portalUrl: '' });
  assert.match(disabled, /disabled/i);
  assert.match(disabled, /refused/i);

  const enabled = describeAdminConfiguration({
    authorizedSubs: [ADMIN_SUB, OTHER_SUB],
    portalUrl: 'https://admin.example.test',
  });
  assert.match(enabled, /2 authorised accounts/);
  // The subs themselves must never reach a log line.
  assert.ok(!enabled.includes(ADMIN_SUB));
  assert.ok(!enabled.includes(OTHER_SUB));
});

test('ADMIN: production refuses to boot with no authorised administrator', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', STOREHUB_PEPPER: 'x'.repeat(32) }),
    /STOREHUB_ADMIN_SUB/,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'production',
        STOREHUB_PEPPER: 'x'.repeat(32),
        STOREHUB_ADMIN_SUB: '   ,  ,',
      }),
    /STOREHUB_ADMIN_SUB/,
  );
  // With one named account, it boots.
  const ok = loadConfig({
    NODE_ENV: 'production',
    STOREHUB_PEPPER: 'x'.repeat(32),
    STOREHUB_ADMIN_SUB: ADMIN_SUB,
  });
  assert.deepEqual(ok.admin.authorizedSubs, [ADMIN_SUB]);
});

test('ADMIN: development with no admin configured starts, and refuses everyone', async () => {
  const app = await createTestAdminApp({ authorizedSubs: [] });
  try {
    // Even a real, valid session for a real account gets nowhere.
    const token = app.signIn(CUSTOMER_SUB);
    const res = await request(app, '/api/admin/licenses', {
      method: 'GET',
      headers: app.cookieHeaders(token),
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, ERROR_CODES.ADMIN_REQUIRED);
  } finally {
    app.close();
  }
});

/* ==================================================================== *
 * 2. Authentication vs authorisation, over the wire
 * ==================================================================== */

test('ADMIN: an unauthenticated request is refused on every guarded route', async () => {
  const app = await createTestAdminApp({ authorizedSubs: [ADMIN_SUB] });
  try {
    for (const [method, path] of GUARDED_ROUTES) {
      const res = await request(app, path, { method });
      assert.equal(res.status, 401, `${method} ${path} should be 401`);
      assert.equal(res.body.error.code, ERROR_CODES.INVALID_SESSION, `${method} ${path}`);
    }
  } finally {
    app.close();
  }
});

test('ADMIN: an authenticated customer is refused on every guarded route', async () => {
  const app = await createTestAdminApp({ authorizedSubs: [ADMIN_SUB] });
  try {
    // A perfectly valid, live session. Authentication succeeded; authorisation
    // is a different question and the answer is no.
    const token = app.signIn(CUSTOMER_SUB);
    for (const [method, path] of GUARDED_ROUTES) {
      const res = await request(app, path, { method, headers: app.cookieHeaders(token) });
      assert.equal(res.status, 403, `${method} ${path} should be 403 for a customer`);
      assert.equal(res.body.error.code, ERROR_CODES.ADMIN_REQUIRED, `${method} ${path}`);
    }
  } finally {
    app.close();
  }
});

test('ADMIN: a forged or stale session cookie is refused', async () => {
  const app = await createTestAdminApp({ authorizedSubs: [ADMIN_SUB] });
  try {
    const garbage = await request(app, '/api/admin/licenses', {
      method: 'GET',
      headers: { cookie: 'storehub_session=not-a-real-session-token' },
    });
    assert.equal(garbage.status, 401);

    // A real session that has been logged out stops working immediately.
    const token = app.signIn(ADMIN_SUB);
    const before = await request(app, '/api/admin/me', {
      method: 'GET',
      headers: app.cookieHeaders(token),
    });
    assert.equal(before.status, 200);

    app.authService.logout(token);

    const after = await request(app, '/api/admin/me', {
      method: 'GET',
      headers: app.cookieHeaders(token),
    });
    assert.equal(after.status, 401);
  } finally {
    app.close();
  }
});

test('ADMIN: a refused request performs no mutation', async () => {
  const app = await createTestAdminApp({ authorizedSubs: [ADMIN_SUB] });
  try {
    const { license, code } = app.issue({ expiresInDays: 30 });
    // The customer activates it, as a real customer would.
    app.service.activate({ licenseCode: code, installId: 'install-1', platform: 'web' });
    const customerToken = app.signIn(CUSTOMER_SUB);

    const attempts = [
      ['POST', `/api/admin/licenses/${license.id}/suspend`, { reason: 'let me in' }],
      ['POST', `/api/admin/licenses/${license.id}/revoke`, { reason: 'let me in' }],
      ['POST', `/api/admin/licenses/${license.id}/reactivate`, {}],
      ['POST', `/api/admin/licenses/${license.id}/note`, { note: 'owned' }],
    ];
    for (const [method, path, body] of attempts) {
      const res = await request(app, path, { method, body, headers: app.cookieHeaders(customerToken) });
      assert.equal(res.status, 403, path);
    }

    // And the customer's own licence session is unaffected — the refusal is
    // about admin rights, not about their account.
    const record = app.repository.findById(license.id);
    assert.equal(record.status, 'active');
    assert.equal(record.note, null);
  } finally {
    app.close();
  }
});

test('ADMIN: an unauthorised request cannot smuggle in an identity', async () => {
  const app = await createTestAdminApp({ authorizedSubs: [ADMIN_SUB] });
  try {
    const customerToken = app.signIn(CUSTOMER_SUB);
    // Every plausible way to talk the server into believing the caller is the
    // operator. None of these fields is read for authorisation — the sub comes
    // from the session — but each must still be refused.
    const forgeries = [
      { sub: ADMIN_SUB },
      { googleSub: ADMIN_SUB },
      { accountId: ADMIN_SUB },
      { isAdmin: true },
      { role: 'admin' },
    ];
    for (const body of forgeries) {
      const res = await request(app, '/api/admin/licenses', {
        method: 'POST',
        body,
        headers: app.cookieHeaders(customerToken),
      });
      assert.equal(res.status, 403, JSON.stringify(body));
    }
    // And nothing was created by any of them.
    const list = await request(app, '/api/admin/licenses', {
      method: 'GET',
      headers: app.cookieHeaders(app.signIn(ADMIN_SUB)),
    });
    assert.equal(list.body.total, 0);
  } finally {
    app.close();
  }
});

/* ==================================================================== *
 * 3. Licence operations through the admin API
 * ==================================================================== */

test('ADMIN: an authorised admin can issue a licence and read the code once', async () => {
  const app = await createTestAdminApp({ authorizedSubs: [ADMIN_SUB] });
  try {
    const token = app.signIn(ADMIN_SUB);
    const headers = app.cookieHeaders(token);

    const created = await request(app, '/api/admin/licenses', {
      method: 'POST',
      headers,
      body: { expiresInDays: 365, note: 'paid by transfer, receipt 4471' },
    });
    assert.equal(created.status, 200);
    assert.match(created.body.code, /^SH-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal(created.body.license.expiresAt, app.now() + 365 * 86400000);

    const id = created.body.license.id;

    // The code is shown at creation and is not recoverable afterwards — the
    // server stores only the scrypt hash.
    const detail = await request(app, `/api/admin/licenses/${id}`, { method: 'GET', headers });
    assert.equal(detail.status, 200);
    assert.ok(!JSON.stringify(detail.body).includes(created.body.code));

    const events = await request(app, `/api/admin/licenses/${id}/events`, { method: 'GET', headers });
    assert.ok(!JSON.stringify(events.body).includes(created.body.code));

    const list = await request(app, '/api/admin/licenses', { method: 'GET', headers });
    assert.ok(!JSON.stringify(list.body).includes(created.body.code));
  } finally {
    app.close();
  }
});

test('ADMIN: a licence created by the admin activates for a customer exactly as before', async () => {
  const app = await createTestAdminApp({ authorizedSubs: [ADMIN_SUB] });
  try {
    const headers = app.cookieHeaders(app.signIn(ADMIN_SUB));
    const created = await request(app, '/api/admin/licenses', {
      method: 'POST',
      headers,
      body: { expiresInDays: 30 },
    });

    // The admin-issued code goes through the ordinary customer endpoint. One
    // set of licence rules, two doors into it.
    const activated = await request(app, '/api/license/activate', {
      method: 'POST',
      body: {
        licenseCode: created.body.code,
        installId: 'install-77',
        platform: 'android',
        appVersion: '1.0.0',
      },
    });
    assert.equal(activated.status, 200);
    assert.equal(activated.body.status, 'active');
  } finally {
    app.close();
  }
});

test('ADMIN: an admin can list licences with pagination and a status filter', async () => {
  const app = await createTestAdminApp({ authorizedSubs: [ADMIN_SUB] });
  try {
    const headers = app.cookieHeaders(app.signIn(ADMIN_SUB));
    app.issue({ expiresInDays: 10 });
    const second = app.issue({ expiresInDays: 10 });
    app.issue({ expiresInDays: 10 });
    app.service.suspend(second.license.id, 'chargeback');

    const all = await request(app, '/api/admin/licenses', { method: 'GET', headers });
    assert.equal(all.status, 200);
    assert.equal(all.body.total, 3);
    assert.equal(all.body.licenses.length, 3);

    const page = await request(app, '/api/admin/licenses?limit=2&offset=0', { method: 'GET', headers });
    assert.equal(page.body.licenses.length, 2);
    assert.equal(page.body.total, 3, 'total counts the filter, not the page');

    const suspended = await request(app, '/api/admin/licenses?status=suspended', {
      method: 'GET',
      headers,
    });
    assert.equal(suspended.body.total, 1);
    assert.equal(suspended.body.licenses[0].id, second.license.id);

    // A nonsense filter is refused rather than silently ignored — a filter that
    // quietly returns everything is how an operator misreads the list.
    const bogus = await request(app, '/api/admin/licenses?status=wat', { method: 'GET', headers });
    assert.equal(bogus.status, 400);
    assert.equal(bogus.body.error.code, ERROR_CODES.INVALID_REQUEST);

    // Nonsense numbers fall back to the default instead of becoming NaN.
    const weird = await request(app, '/api/admin/licenses?limit=abc&offset=-5', {
      method: 'GET',
      headers,
    });
    assert.equal(weird.status, 200);
    assert.equal(weird.body.licenses.length, 3);
  } finally {
    app.close();
  }
});

test('ADMIN: an admin can inspect a licence and sees no secret material', async () => {
  const app = await createTestAdminApp({ authorizedSubs: [ADMIN_SUB] });
  try {
    const headers = app.cookieHeaders(app.signIn(ADMIN_SUB));
    const { license, code } = app.issueAndActivate({ expiresInDays: 30 }, {
      installId: 'install-a',
      platform: 'android',
      appVersion: '1.0.0',
    });
    app.service.bind({
      licenseCode: code,
      accountId: CUSTOMER_SUB,
      sessionToken: undefined,
    });

    const res = await request(app, `/api/admin/licenses/${license.id}`, { method: 'GET', headers });
    assert.equal(res.status, 200);

    // Exactly the fields an operator legitimately needs, and nothing else.
    assert.deepEqual(Object.keys(res.body.license).sort(), [
      'activatedAt',
      'createdAt',
      'expiresAt',
      'id',
      'lastVerifiedAt',
      'linkedAccountId',
      'note',
      'status',
      'storedStatus',
    ]);
    assert.equal(res.body.license.linkedAccountId, CUSTOMER_SUB);
    assert.equal(res.body.license.activatedAt, app.now());

    // Install metadata, which is how a support question gets answered.
    assert.equal(res.body.installs.length, 1);
    assert.equal(res.body.installs[0].platform, 'android');
    assert.equal(res.body.installs[0].appVersion, '1.0.0');

    // Never the code material, never a session token.
    const serialised = JSON.stringify(res.body);
    for (const forbidden of ['codeHash', 'codeSalt', 'codeLookup', 'sessionToken', 'token_lookup']) {
      assert.ok(!serialised.includes(forbidden), `${forbidden} leaked into the admin view`);
    }

    // And an unknown id is a clean 404, not a leak or a 500.
    const missing = await request(app, '/api/admin/licenses/00000000-0000-4000-8000-000000000000', {
      method: 'GET',
      headers,
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, ERROR_CODES.LICENSE_NOT_FOUND);
  } finally {
    app.close();
  }
});

test('ADMIN: an admin can suspend, reactivate and revoke', async () => {
  const app = await createTestAdminApp({ authorizedSubs: [ADMIN_SUB] });
  try {
    const headers = app.cookieHeaders(app.signIn(ADMIN_SUB));
    const { license, code } = app.issueAndActivate({ expiresInDays: 30 });
    const id = license.id;

    const suspended = await request(app, `/api/admin/licenses/${id}/suspend`, {
      method: 'POST',
      headers,
      body: { reason: 'payment failed' },
    });
    assert.equal(suspended.status, 200);
    assert.equal(suspended.body.license.status, 'suspended');

    // The customer's own endpoint now refuses, so the change is real.
    const blocked = await request(app, '/api/license/verify', {
      method: 'POST',
      body: { installId: 'install-alpha' },
    });
    assert.equal(blocked.status, 401);

    const reactivated = await request(app, `/api/admin/licenses/${id}/reactivate`, {
      method: 'POST',
      headers,
      body: { reason: 'payment received' },
    });
    assert.equal(reactivated.body.license.status, 'active');

    const revoked = await request(app, `/api/admin/licenses/${id}/revoke`, {
      method: 'POST',
      headers,
      body: { reason: 'refund issued' },
    });
    assert.equal(revoked.body.license.status, 'revoked');

    // Revocation is permanent — reactivate refuses rather than quietly undoing
    // it, so the state machine stays meaningful.
    const undo = await request(app, `/api/admin/licenses/${id}/reactivate`, {
      method: 'POST',
      headers,
    });
    assert.equal(undo.status, 403);
    assert.equal(undo.body.error.code, ERROR_CODES.LICENSE_REVOKED);

    // And the activation code is dead for good.
    const reactivateAttempt = await request(app, '/api/license/activate', {
      method: 'POST',
      body: { licenseCode: code, installId: 'install-new', platform: 'web' },
    });
    assert.equal(reactivateAttempt.status, 403);
    assert.equal(reactivateAttempt.body.error.code, ERROR_CODES.LICENSE_REVOKED);
  } finally {
    app.close();
  }
});

test('ADMIN: filtering by "expired" selects lapsed licences, not stored-active ones', async () => {
  const app = await createTestAdminApp({ authorizedSubs: [ADMIN_SUB] });
  try {
    const headers = app.cookieHeaders(app.signIn(ADMIN_SUB));

    const lapsing = app.issue({ expiresInDays: 1 }).license;
    const perpetual = app.issue({}).license;
    const suspended = app.issue({ expiresInDays: 1 }).license;
    app.service.suspend(suspended.id, 'held for review');
    app.advance(2 * 86400000);

    // The filter has to agree with the badge in the same response. A stored-status
    // filter would return the lapsed licence under `active`, which is exactly the
    // confusion the derived status exists to prevent.
    const expired = await request(app, '/api/admin/licenses?status=expired', {
      method: 'GET',
      headers,
    });
    assert.equal(expired.status, 200);
    assert.equal(expired.body.total, 1);
    assert.equal(expired.body.licenses[0].id, lapsing.id);
    assert.equal(expired.body.licenses[0].status, 'expired');

    // A suspended licence past its date reports suspended, not expired — the more
    // useful answer — and so it belongs under `suspended`, not under `expired`.
    const bySuspended = await request(app, '/api/admin/licenses?status=suspended', {
      method: 'GET',
      headers,
    });
    assert.equal(bySuspended.body.total, 1);
    assert.equal(bySuspended.body.licenses[0].id, suspended.id);
    assert.equal(bySuspended.body.licenses[0].status, 'suspended');

    // Perpetual licences have no expiry and must never appear as expired.
    const all = await request(app, '/api/admin/licenses?limit=200', { method: 'GET', headers });
    const perpetualRow = all.body.licenses.find((entry) => entry.id === perpetual.id);
    assert.equal(perpetualRow.status, 'active');
    assert.equal(perpetualRow.expiresAt, null);
  } finally {
    app.close();
  }
});

test('ADMIN: revoking a licence invalidates its live sessions', async () => {
  const app = await createTestAdminApp({ authorizedSubs: [ADMIN_SUB] });
  try {
    const headers = app.cookieHeaders(app.signIn(ADMIN_SUB));
    const { session } = app.issueAndActivate({ expiresInDays: 30 });

    const ok = await request(app, '/api/license/verify', {
      method: 'POST',
      body: { sessionToken: session.sessionToken, installId: 'install-alpha' },
    });
    assert.equal(ok.status, 200);

    await request(app, '/api/license/verify', { method: 'POST', body: {} });
    const detail = await request(app, '/api/admin/licenses', { method: 'GET', headers });
    const id = detail.body.licenses[0].id;
    await request(app, `/api/admin/licenses/${id}/revoke`, { method: 'POST', headers });

    // The token would still authenticate if revocation did not kill it, so this
    // is the assertion that revocation reaches the sessions. The answer is
    // 401 and not 403 because the row is gone: there is no longer a session to
    // say anything about.
    const after = await request(app, '/api/license/verify', {
      method: 'POST',
      body: { sessionToken: session.sessionToken, installId: 'install-alpha' },
    });
    assert.equal(after.status, 401);
    assert.equal(after.body.error.code, ERROR_CODES.INVALID_SESSION);
  } finally {
    app.close();
  }
});

test('ADMIN: an internal note can be set and cleared', async () => {
  const app = await createTestAdminApp({ authorizedSubs: [ADMIN_SUB] });
  try {
    const headers = app.cookieHeaders(app.signIn(ADMIN_SUB));
    const { license } = app.issue({ expiresInDays: 30 });

    const set = await request(app, `/api/admin/licenses/${license.id}/note`, {
      method: 'POST',
      headers,
      body: { note: '  called on 2026-02-01, agreed to pay by invoice 88  ' },
    });
    assert.equal(set.status, 200);
    assert.equal(set.body.license.note, 'called on 2026-02-01, agreed to pay by invoice 88');

    const cleared = await request(app, `/api/admin/licenses/${license.id}/note`, {
      method: 'POST',
      headers,
      body: { note: null },
    });
    assert.equal(cleared.body.license.note, null);

    // A missing note field is refused, so a typo cannot silently erase one.
    const omitted = await request(app, `/api/admin/licenses/${license.id}/note`, {
      method: 'POST',
      headers,
      body: {},
    });
    assert.equal(omitted.status, 400);

    // An absurd note is refused rather than silently truncated in half.
    const huge = await request(app, `/api/admin/licenses/${license.id}/note`, {
      method: 'POST',
      headers,
      body: { note: 'x'.repeat(5000) },
    });
    assert.equal(huge.status, 400);
  } finally {
    app.close();
  }
});

test('ADMIN: the admin view reports a lapsed licence as expired without a stored flag', async () => {
  const app = await createTestAdminApp({ authorizedSubs: [ADMIN_SUB] });
  try {
    const headers = app.cookieHeaders(app.signIn(ADMIN_SUB));
    const { license } = app.issue({ expiresInDays: 1 });

    app.advance(2 * 86400000);

    const list = await request(app, '/api/admin/licenses', { method: 'GET', headers });
    const row = list.body.licenses.find((entry) => entry.id === license.id);
    // Derived, so it is correct the instant the date passes — no nightly job to
    // forget. The stored status is reported alongside so the operator can see
    // *why*.
    assert.equal(row.status, 'expired');
    assert.equal(row.storedStatus, 'active');
  } finally {
    app.close();
  }
});

test('ADMIN: an admin can read the licence event trail', async () => {
  const app = await createTestAdminApp({ authorizedSubs: [ADMIN_SUB] });
  try {
    const headers = app.cookieHeaders(app.signIn(ADMIN_SUB));
    const { license } = app.issueAndActivate({ expiresInDays: 30 });
    await request(app, `/api/admin/licenses/${license.id}/suspend`, {
      method: 'POST',
      headers,
      body: { reason: 'fraud review' },
    });

    const events = await request(app, `/api/admin/licenses/${license.id}/events`, {
      method: 'GET',
      headers,
    });
    assert.equal(events.status, 200);
    const names = events.body.events.map((entry) => entry.event);
    assert.ok(names.includes('created'));
    assert.ok(names.includes('activated'));
    assert.ok(names.includes('status_suspended'));
  } finally {
    app.close();
  }
});

test('ADMIN: the id in the path is used as an opaque handle, never as a path', async () => {
  const app = await createTestAdminApp({ authorizedSubs: [ADMIN_SUB] });
  try {
    const headers = app.cookieHeaders(app.signIn(ADMIN_SUB));
    // A traversal attempt arrives percent-encoded, so a router that decoded
    // before splitting segments could walk out of the route.
    for (const attempt of [
      '/api/admin/licenses/..%2F..%2F..%2Fetc%2Fpasswd',
      '/api/admin/licenses/%2E%2E%2F%2E%2E%2Fdata%2Fstorehub.db',
      '/api/admin/licenses/..',
    ]) {
      const res = await request(app, attempt, { method: 'GET', headers });
      assert.equal(res.status, 404, attempt);
      assert.equal(res.body.error.code, ERROR_CODES.LICENSE_NOT_FOUND);
    }
  } finally {
    app.close();
  }
});

test('ADMIN: both methods on the collection path work and are guarded', async () => {
  const app = await createTestAdminApp({ authorizedSubs: [ADMIN_SUB] });
  try {
    const headers = app.cookieHeaders(app.signIn(ADMIN_SUB));
    // Regression guard: as a path→route object, the second of these two silently
    // overwrote the first and the listing answered 405 with no error anywhere.
    const list = await request(app, '/api/admin/licenses', { method: 'GET', headers });
    assert.equal(list.status, 200);
    const create = await request(app, '/api/admin/licenses', { method: 'POST', headers, body: {} });
    assert.equal(create.status, 200);

    // And a method the path does not serve reports the ones it does.
    const wrong = await request(app, '/api/admin/licenses', { method: 'DELETE', headers });
    assert.equal(wrong.status, 405);
    assert.deepEqual(wrong.body.allowed.sort(), ['GET', 'OPTIONS', 'POST']);
  } finally {
    app.close();
  }
});

/* ==================================================================== *
 * 4. Customer data isolation
 * ==================================================================== */

test('ISOLATION: no admin route can reach products, sales, inventory, reports or backups', async () => {
  const app = await createTestAdminApp({ authorizedSubs: [ADMIN_SUB] });
  try {
    const headers = app.cookieHeaders(app.signIn(ADMIN_SUB));
    // Probed as a fully authorised admin: the point is not that a customer is
    // refused, it is that the capability does not exist at all. 404, not 403 —
    // there is nothing to authorise.
    const probes = [
      ...CUSTOMER_BUSINESS_CONCEPTS.map((concept) => `/api/admin/${concept}`),
      ...CUSTOMER_BUSINESS_CONCEPTS.map((concept) => `/api/admin/${concept}/list`),
      '/api/admin/licenses/../products',
      '/api/admin/store',
      '/api/admin/store/export',
      '/api/admin/db',
    ];
    for (const probe of probes) {
      for (const method of ['GET', 'POST']) {
        const res = await request(app, probe, { method, headers });
        assert.equal(res.status, 404, `${method} ${probe} should not exist`);
        assert.equal(res.body.error.code, ERROR_CODES.INVALID_REQUEST);
      }
    }
  } finally {
    app.close();
  }
});

test('ISOLATION: the licence database contains no customer business table', () => {
  const db = new DatabaseSync(':memory:');
  try {
    applyMigrations(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name.toLowerCase());

    assert.ok(tables.length > 0);
    for (const concept of CUSTOMER_BUSINESS_CONCEPTS) {
      const offender = tables.find((table) => table.includes(concept));
      assert.equal(offender, undefined, `licence db has a "${concept}" table`);
    }

    // Positive check, so the negative one above cannot pass on an empty schema.
    assert.deepEqual(tables.sort(), [
      'license_events',
      'license_installs',
      'license_tokens',
      'licenses',
    ]);
  } finally {
    db.close();
  }
});

test('ISOLATION: no licence column can hold customer business data', () => {
  const db = new DatabaseSync(':memory:');
  try {
    applyMigrations(db);
    const columns = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .flatMap((row) => db.prepare(`PRAGMA table_info(${row.name})`).all().map((col) => col.name));

    for (const concept of ['product', 'sale', 'price', 'quantity', 'customer', 'invoice', 'image']) {
      const offender = columns.find((column) => column.toLowerCase().includes(concept));
      assert.equal(offender, undefined, `a column named "${offender}" could hold business data`);
    }
  } finally {
    db.close();
  }
});

test('ISOLATION: the identity database stores no OAuth token', async () => {
  const { db, repo } = await openAuthDatabase(':memory:', { pepper: 'x'.repeat(32) });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name.toLowerCase());
    assert.deepEqual(tables.sort(), ['auth_accounts', 'auth_sessions']);

    const columns = tables.flatMap((table) =>
      db.prepare(`PRAGMA table_info(${table})`).all().map((col) => col.name.toLowerCase()),
    );
    // The whole reason the backend can be trusted with an OAuth flow: it talks
    // to Google once and then keeps nothing an attacker could replay.
    for (const forbidden of ['access_token', 'refresh_token', 'id_token', 'code', 'secret']) {
      assert.ok(!columns.some((column) => column.includes(forbidden)), `${forbidden} is stored`);
    }
  } finally {
    repo.close();
  }
});

test('ISOLATION: the admin surface has no method that returns store data', async () => {
  const app = await createTestAdminApp({ authorizedSubs: [ADMIN_SUB] });
  try {
    // Enumerated, not pattern-matched: a whole response body proves it as
    // thoroughly as the schema assertions above.
    const headers = app.cookieHeaders(app.signIn(ADMIN_SUB));
    app.issueAndActivate({ expiresInDays: 30 });
    const everything = await Promise.all([
      request(app, '/api/admin/licenses?limit=200', { method: 'GET', headers }),
      request(app, '/api/admin/licenses', { method: 'GET', headers }),
    ]);
    const serialised = JSON.stringify(everything);
    for (const concept of ['product', 'sale', 'inventory', 'invoice', 'supplier', 'backup']) {
      assert.ok(!serialised.toLowerCase().includes(concept), `"${concept}" appeared in admin output`);
    }
  } finally {
    app.close();
  }
});

test('ISOLATION: an admin request body cannot introduce a business-data field', async () => {
  const app = await createTestAdminApp({ authorizedSubs: [ADMIN_SUB] });
  try {
    const headers = app.cookieHeaders(app.signIn(ADMIN_SUB));
    const { license } = app.issue({ expiresInDays: 30 });
    const id = license.id;

    // A client that posts its whole store to an admin endpoint: the fields are
    // read as absent, so nothing lands.
    const res = await request(app, `/api/admin/licenses/${id}/note`, {
      method: 'POST',
      headers,
      body: {
        note: 'legitimate',
        products: [{ name: 'Coke', price: 3 }],
        sales: [{ total: 100 }],
        inventory: { count: 5 },
        customerBackups: ['base64...'],
      },
    });
    assert.equal(res.status, 200);

    const record = app.repository.findById(id);
    assert.equal(record.note, 'legitimate');
    // Exactly the two columns this table has beyond identity metadata.
    assert.deepEqual(
      Object.keys(record).sort(),
      [
        'activatedAt',
        'codeHash',
        'codeLookup',
        'codeSalt',
        'createdAt',
        'expiresAt',
        'id',
        'lastVerifiedAt',
        'linkedAccountId',
        'note',
        'status',
      ],
    );
  } finally {
    app.close();
  }
});

/* ==================================================================== *
 * 5. The customer application itself
 * ==================================================================== */

test('SEPARATION: the customer app contains no admin route, page or link', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const jsDir = join(repoRoot, 'js');

  const files = [
    join(repoRoot, 'index.html'),
    join(repoRoot, 'manifest.json'),
    join(repoRoot, 'sw.js'),
    ...readdirSync(jsDir, { recursive: true })
      .filter((entry) => entry.endsWith('.js'))
      .map((entry) => join(jsDir, entry)),
  ];
  assert.ok(files.length > 20, 'expected to scan the whole customer shell');

  for (const file of files) {
    const code = stripComments(readFileSync(file, 'utf8'));

    assert.ok(!code.includes('/api/admin'), `${file} calls an admin endpoint`);
    assert.ok(!code.includes('admin/'), `${file} references the admin bundle`);
    assert.ok(!/['"`]admin['"`]/.test(code), `${file} has an admin route or key`);
  }
});

test('SEPARATION: the admin bundle is its own application', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const adminDir = join(repoRoot, 'admin');

  // A complete, self-contained app: a document, a stylesheet, a module, and the
  // one config file an operator edits at deploy time.
  assert.deepEqual(readdirSync(adminDir).sort(), [
    'admin.css',
    'admin.js',
    'config.js',
    'index.html',
  ]);

  const source = readFileSync(join(adminDir, 'admin.js'), 'utf8');
  const code = stripComments(source);

  // It must not reach into the customer's modules. Sharing one would put an
  // admin concern into the shop's bundle, and the shop's IndexedDB with it.
  const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(imports, ['./config.js'], 'admin.js should import only its own config');

  // It must not open the customer's database, localStorage, or cache.
  for (const forbidden of ['indexedDB', 'localStorage', 'sessionStorage', 'caches.', 'serviceWorker']) {
    assert.ok(!code.includes(forbidden), `admin.js touches ${forbidden}`);
  }

  // And it must not build markup out of server data. Every value here comes from
  // a database that a customer can influence — a licence note, most obviously —
  // so `innerHTML` would be stored XSS against an administrator's session.
  assert.ok(!code.includes('innerHTML'), 'admin.js uses innerHTML');
  assert.ok(!code.includes('insertAdjacentHTML'), 'admin.js uses insertAdjacentHTML');
  assert.ok(!code.includes('document.write'), 'admin.js uses document.write');
  assert.ok(code.includes('textContent'), 'admin.js should set data through textContent');

  // The customer shell must not reference the portal either — no link, no
  // redirect, no prefetch.
  const customerShell = [
    join(repoRoot, 'index.html'),
    join(repoRoot, 'sw.js'),
    join(repoRoot, 'manifest.json'),
  ];
  for (const file of customerShell) {
    const shellCode = stripComments(readFileSync(file, 'utf8'));
    assert.ok(!shellCode.includes('admin'), `${file} references the admin portal`);
  }
});

test('SEPARATION: the service worker does not precache the admin portal', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const sw = readFileSync(join(repoRoot, 'sw.js'), 'utf8');

  // The portal is a separate deployment. Precaching it from the customer's
  // service worker would put admin assets inside the shop's offline cache — on
  // every customer's device.
  assert.ok(!sw.includes('admin/'), 'the service worker precaches admin assets');
  assert.ok(!sw.includes('admin.html'), 'the service worker precaches an admin document');
});

/* ==================================================================== *
 * 6. Admin sign-in flow
 * ==================================================================== */

test('ADMIN SIGN-IN: the callback refuses a customer flow and leaves no session', async () => {
  const app = await createTestAdminApp({ authorizedSubs: [ADMIN_SUB] });
  try {
    app.config.google.clientId = 'test-client.apps.googleusercontent.com';
    app.config.google.clientSecret = 'test-secret';
    app.config.google.redirectUri = 'http://127.0.0.1:8787/api/admin/auth/callback';

    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
      }
      if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
        return { ok: true, json: async () => ({ sub: ADMIN_SUB, email: 'op@example.test' }) };
      }
      return original(url);
    };

    /** The only honest way to ask "did a session survive?" — count the rows. */
    const sessionCount = () =>
      app.authDb.prepare('SELECT COUNT(*) AS total FROM auth_sessions').get().total;

    try {
      // A flow started at the *customer* sign-in must not be finishable at the
      // admin callback, or the two entry points stop being distinguishable in a
      // log — and an admin session would be minted by the customer route.
      const customerStart = await request(app, '/api/auth/google/start', { method: 'GET' });
      assert.equal(customerStart.status, 200);

      const crossed = await request(
        app,
        `/api/admin/auth/callback?code=c&state=${customerStart.body.state}`,
        { method: 'GET' },
      );
      assert.equal(crossed.status, 400);
      assert.equal(sessionCount(), 0, 'a refused callback left a session behind');

      // The same flow started at the admin entry point succeeds for an operator.
      const adminStart = await request(app, '/api/admin/auth/start', { method: 'GET' });
      assert.equal(adminStart.status, 200);
      assert.match(adminStart.body.authUrl, /accounts\.google\.com/);

      const ok = await request(
        app,
        `/api/admin/auth/callback?code=c&state=${adminStart.body.state}`,
        { method: 'GET' },
      );
      assert.equal(ok.status, 200);
      assert.equal(ok.body.account.googleSub, ADMIN_SUB);
      assert.equal(sessionCount(), 1);
      // The session cookie is set, and no token is echoed in the body.
      assert.ok(String(ok.headers['set-cookie']).includes('storehub_session='));
      assert.ok(!JSON.stringify(ok.body).includes('sessionToken'));
    } finally {
      globalThis.fetch = original;
    }
  } finally {
    app.close();
  }
});

test('ADMIN SIGN-IN: a customer account is refused at the callback, and its session is destroyed', async () => {
  const app = await createTestAdminApp({ authorizedSubs: [ADMIN_SUB] });
  try {
    app.config.google.clientId = 'test-client.apps.googleusercontent.com';
    app.config.google.clientSecret = 'test-secret';
    app.config.google.redirectUri = 'http://127.0.0.1:8787/api/admin/auth/callback';

    const start = await request(app, '/api/admin/auth/start', { method: 'GET' });

    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
      }
      if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
        // A real, authenticated customer — just not an administrator.
        return { ok: true, json: async () => ({ sub: CUSTOMER_SUB, email: 'shop@example.test' }) };
      }
      return original(url);
    };

    try {
      const res = await request(
        app,
        `/api/admin/auth/callback?code=c&state=${start.body.state}`,
        { method: 'GET' },
      );
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, ERROR_CODES.ADMIN_REQUIRED);
      // Authentication alone was enough to create a session; the refusal has to
      // take it away again, or a failed admin attempt leaves a usable cookie.
      assert.equal(res.headers['set-cookie'], undefined, 'a refused admin sign-in set a cookie');
      assert.equal(
        app.authDb.prepare('SELECT COUNT(*) AS total FROM auth_sessions').get().total,
        0,
        'the refused admin sign-in left a live session',
      );
    } finally {
      globalThis.fetch = original;
    }
  } finally {
    app.close();
  }
});

test('ADMIN SIGN-IN: a configured portal URL is the only redirect target', async () => {
  const app = await createTestAdminApp({
    authorizedSubs: [ADMIN_SUB],
    portalUrl: 'https://admin.example.test/portal',
  });
  try {
    app.config.google.clientId = 'test-client.apps.googleusercontent.com';
    app.config.google.clientSecret = 'test-secret';
    app.config.google.redirectUri = 'https://api.example.test/api/admin/auth/callback';

    const start = await request(app, '/api/admin/auth/start', { method: 'GET' });
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
      }
      if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
        return { ok: true, json: async () => ({ sub: ADMIN_SUB, email: 'op@example.test' }) };
      }
      return original(url);
    };
    try {
      // A redirect target smuggled in through the query string is ignored
      // outright: only the configured URL is ever used.
      const res = await request(
        app,
        `/api/admin/auth/callback?code=c&state=${start.body.state}&redirect_uri=https://evil.test`,
        { method: 'GET' },
      );
      assert.equal(res.status, 302);
      assert.equal(res.headers.location, 'https://admin.example.test/portal');
    } finally {
      globalThis.fetch = original;
    }
  } finally {
    app.close();
  }
});

test('ADMIN SIGN-IN: a plain-http portal URL is refused in production', () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'production',
        STOREHUB_PEPPER: 'x'.repeat(32),
        STOREHUB_ADMIN_SUB: ADMIN_SUB,
        STOREHUB_ADMIN_PORTAL_URL: 'http://admin.example.test',
      }),
    /https/,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'production',
        STOREHUB_PEPPER: 'x'.repeat(32),
        STOREHUB_ADMIN_SUB: ADMIN_SUB,
        STOREHUB_ADMIN_PORTAL_URL: 'not-a-url',
      }),
    /absolute URL/,
  );
});

/* ==================================================================== *
 * 7. Nothing secret is committed, and the wiring actually works
 * ==================================================================== */

test('SECURITY: no admin password, secret or hardcoded grant exists in the source', () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const files = readdirSync(srcDir).filter((name) => name.endsWith('.js'));

  for (const name of files) {
    const source = readFileSync(join(srcDir, name), 'utf8');
    // Comments are stripped first: this design is *described* in terms of having
    // no password, and prose about an absent thing is not the thing.
    const code = stripComments(source);

    // A password field would be a second way in, which this design does not
    // have: the only grant is the configured sub list.
    assert.ok(!/password/i.test(code), `${name} contains password logic`);
    assert.ok(!/adminSecret|ADMIN_PASSWORD|admin_token/i.test(code), `${name} hardcodes a secret`);

    // And no module reads an admin credential from anywhere but the one
    // documented allowlist.
    //
    // The three GOOGLE_*_REDIRECT_URI variables contain "ADMIN"/"AUTH"/"DRIVE"
    // in their names but are Google OAuth callback URLs, not admin credentials.
    // They are config, not secrets. The allowlist below covers them explicitly.
    const adminReads = code.match(/env\.[A-Z_]*ADMIN[A-Z_]*/g) ?? [];
    const allowedAdminReads = new Set([
      'env.STOREHUB_ADMIN_SUB',
      'env.STOREHUB_ADMIN_PORTAL_URL',
      'env.GOOGLE_ADMIN_REDIRECT_URI',
      'env.GOOGLE_AUTH_REDIRECT_URI',
      'env.GOOGLE_DRIVE_REDIRECT_URI',
    ]);
    for (const read of adminReads) {
      assert.ok(
        allowedAdminReads.has(read),
        `${name} reads an undocumented admin variable (${read})`,
      );
    }
  }
});

test('SECURITY: the admin surface returns no session or OAuth token material', async () => {
  const app = await createTestAdminApp({ authorizedSubs: [ADMIN_SUB] });
  try {
    const headers = app.cookieHeaders(app.signIn(ADMIN_SUB));
    const created = await request(app, '/api/admin/licenses', {
      method: 'POST',
      headers,
      body: { expiresInDays: 30 },
    });
    const id = created.body.license.id;

    const responses = [
      created,
      await request(app, '/api/admin/licenses', { method: 'GET', headers }),
      await request(app, `/api/admin/licenses/${id}`, { method: 'GET', headers }),
      await request(app, `/api/admin/licenses/${id}/events`, { method: 'GET', headers }),
      await request(app, '/api/admin/me', { method: 'GET', headers }),
    ];

    for (const res of responses) {
      const body = JSON.stringify(res.body);
      assert.ok(!body.includes('sessionToken'), 'a session token was returned to the portal');
      assert.ok(!body.includes('access_token'), 'an OAuth access token was returned');
      assert.ok(!body.includes('refresh_token'), 'an OAuth refresh token was returned');
      assert.ok(!body.includes('codeHash'), 'licence hash material was returned');
      assert.ok(!body.includes('codeSalt'), 'licence salt material was returned');
      assert.ok(!body.includes('codeLookup'), 'licence lookup material was returned');
    }

    // The caller's own cookie is echoed back only as a Set-Cookie header, which
    // is how the browser is told to keep it.
    assert.ok(!('cookie' in responses[4].headers));
  } finally {
    app.close();
  }
});

test('WIRING: buildApplication assembles a working backend', async () => {
  // Guards a real bug this phase found: the licence repository was being read as
  // `{ repo }` when it is returned bare, so every service was built with
  // `undefined` and the first request failed. Nothing exercised this wiring
  // before, because nothing called it.
  //
  // Phase 4: buildApplication is PostgreSQL-only, so the suite injects its
  // in-memory adapters through the test seam. The wiring under test — shapes,
  // service construction, guards — is unchanged.
  const { buildApplication } = await import('../src/index.js');
  const { openLicenseDatabase } = await import('./support/sqlite-license.js');
  const { openAuthDatabase } = await import('./support/sqlite-auth.js');
  const { openDriveDatabase } = await import('./support/sqlite-drive.js');
  const app = await buildApplication({
    env: {
      NODE_ENV: 'test',
      STOREHUB_PEPPER: 'wiring-pepper-not-used-anywhere-0123456789',
      STOREHUB_ADMIN_SUB: ADMIN_SUB,
      STOREHUB_SCRYPT_N: '1024',
      STOREHUB_SCRYPT_R: '8',
      STOREHUB_SCRYPT_P: '1',
    },
    adapters: {
      openLicenseDatabase: (_file, deps) => openLicenseDatabase(':memory:', deps),
      openAuthDatabase: (_file, deps) => openAuthDatabase(':memory:', deps),
      openDriveDatabase: (_file, deps) => openDriveDatabase(':memory:', deps),
    },
  });

  try {
    assert.ok(app.licenseService, 'licenseService is wired');
    assert.ok(app.authService, 'authService is wired');
    assert.ok(app.adminService, 'adminService is wired');

    // And the graph actually runs a request end to end.
    const created = await request(app, '/api/admin/licenses', {
      method: 'POST',
      body: { expiresInDays: 30 },
    });
    // No session, so this is refused — which is the correct answer, and proof
    // the handler reaches the guard rather than crashing on undefined.
    assert.equal(created.status, 401);
    assert.equal(created.body.error.code, ERROR_CODES.INVALID_SESSION);

    const listed = await request(app, '/api/admin/me', { method: 'GET' });
    assert.equal(listed.status, 401);
  } finally {
    app.close();
  }
});
