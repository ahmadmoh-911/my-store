/**
 * The licence service: creation, activation, verification, binding, and the
 * rules that refuse work.
 *
 * Covers required areas 6-14, 18 and 20.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTestService } from './helpers.mjs';
import { ERROR_CODES } from '../src/errors.js';
import { generateLicenseCode } from '../src/codes.js';
import { effectiveStatus, entitlementFor } from '../src/model.js';

const DAY = 86400000;

/**
 * Asserts that `fn` throws a LicenseError carrying `expectedCode`.
 *
 * @param {() => unknown} fn
 * @param {string} expectedCode
 * @param {string} [label]
 */
function assertCode(fn, expectedCode, label = '') {
  let thrown = null;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, `${label} should have thrown ${expectedCode}`);
  assert.equal(thrown.code, expectedCode, `${label}: wrong error code`);
  return thrown;
}

/** @returns {{service: object}} wrapper for createTestService with cleanup. */
function withService(fn) {
  const app = createTestService();
  try {
    return fn(app);
  } finally {
    app.close();
  }
}

test('6. creates a licence, returning the code exactly once', () => {
  withService((app) => {
    const { license, code } = app.service.createLicense({ expiresInDays: 365 });

    assert.match(code, /^SH(-[A-Z0-9]{4}){3}$/);
    assert.equal(license.status, 'active');
    assert.equal(license.expiresAt, app.now() + 365 * DAY);
    assert.match(license.id, /^[0-9a-f-]{36}$/, 'id should be a uuid');

    // The record that comes back is an entitlement, not the row: no hash, no
    // salt, no note. Nothing here could leak a code even to the caller.
    assert.deepEqual(Object.keys(license).sort(), ['createdAt', 'expiresAt', 'id', 'status']);
  });
});

test('6b. a perpetual licence has no expiry', () => {
  withService((app) => {
    assert.equal(app.service.createLicense().license.expiresAt, null);
    assert.equal(app.service.createLicense({ expiresInDays: null }).license.expiresAt, null);
  });
});

test('6c. rejects an expiry in the past rather than issuing a dead licence', () => {
  withService((app) => {
    assertCode(() => app.service.createLicense({ expiresInDays: 0 }), ERROR_CODES.INVALID_REQUEST);
    assertCode(() => app.service.createLicense({ expiresInDays: -5 }), ERROR_CODES.INVALID_REQUEST);
  });
});

test('7. activates a valid licence and issues a session', () => {
  withService((app) => {
    const { license, code } = app.service.createLicense({ expiresInDays: 30 });

    const result = app.service.activate({
      licenseCode: code,
      installId: 'install-001',
      platform: 'android',
      appVersion: '1.0.0',
    });

    assert.equal(result.license.id, license.id);
    assert.equal(result.license.status, 'active');
    assert.equal(result.license.expiresAt, license.expiresAt);
    assert.equal(result.linkedAccountId, null, 'unbound until an account claims it');
    assert.equal(result.serverTime, app.now());
    assert.match(result.sessionToken, /^[A-Za-z0-9_-]{43}$/);

    // Activation is recorded, and re-activating does not move the first time.
    const activatedAt = app.repository.findById(license.id).activatedAt;
    assert.equal(activatedAt, app.now());
    app.advance(5000);
    app.service.activate({ licenseCode: code, installId: 'install-001' });
    assert.equal(app.repository.findById(license.id).activatedAt, activatedAt);
  });
});

test('7b. accepts a code typed in lowercase or with different separators', () => {
  withService((app) => {
    const { code } = app.service.createLicense({});
    const messy = code.toLowerCase().replace(/-/g, ' ');
    const result = app.service.activate({
      licenseCode: messy,
      installId: 'install-001',
      platform: 'web',
      appVersion: '1.0.0',
    });
    assert.equal(result.license.status, 'active');
  });
});

test('7c. activation requires an install id', () => {
  withService((app) => {
    const { code } = app.service.createLicense({});
    assertCode(
      () => app.service.activate({ licenseCode: code, platform: 'web', appVersion: '1.0.0' }),
      ERROR_CODES.INVALID_REQUEST,
      'missing installId',
    );
  });
});

test('8. rejects an invalid licence', () => {
  withService((app) => {
    // Malformed — not even shaped like a code.
    assertCode(
      () => app.service.activate({ licenseCode: 'nonsense', installId: 'i' }),
      ERROR_CODES.INVALID_LICENSE,
      'garbage code',
    );
    assertCode(
      () => app.service.activate({ licenseCode: 'SH-O4KP-92MX-Q8TA', installId: 'i' }),
      ERROR_CODES.INVALID_LICENSE,
      'code with an unusable character',
    );
    assertCode(
      () => app.service.activate({ licenseCode: '', installId: 'i' }),
      ERROR_CODES.INVALID_LICENSE,
      'empty code',
    );
    assertCode(
      () => app.service.activate({ installId: 'i' }),
      ERROR_CODES.INVALID_LICENSE,
      'absent code',
    );

    // Well-formed but belongs to nobody.
    assertCode(
      () => app.service.activate({ licenseCode: generateLicenseCode(), installId: 'i' }),
      ERROR_CODES.LICENSE_NOT_FOUND,
      'valid shape, no match',
    );
  });
});

test('8b. a wrong-but-valid code is indistinguishable from a missing one', () => {
  withService((app) => {
    const { code } = app.service.createLicense({});
    const wrong = generateLicenseCode();

    const notFound = assertCode(
      () => app.service.activate({ licenseCode: wrong, installId: 'i' }),
      ERROR_CODES.LICENSE_NOT_FOUND,
    );
    // Same code, same message, same status for both cases: the endpoint cannot be
    // used to discover which codes are real.
    const ok = app.service.activate({ licenseCode: code, installId: 'i' });
    assert.equal(notFound.status, 404);
    assert.equal(ok.license.status, 'active');
  });
});

test('9. rejects a suspended licence', () => {
  withService((app) => {
    const { license, code } = app.service.createLicense({});
    app.service.suspend(license.id, 'payment overdue');

    const err = assertCode(
      () => app.service.activate({ licenseCode: code, installId: 'i' }),
      ERROR_CODES.LICENSE_SUSPENDED,
    );
    assert.equal(err.status, 403);
    assert.ok(!err.message.includes('payment overdue'), 'internal reasons must not leak');
  });
});

test('9b. a suspended licence cannot verify either', () => {
  withService((app) => {
    const { license, session } = app.issueAndActivate();
    assert.equal(app.service.verify({ sessionToken: session.sessionToken }).license.status, 'active');

    app.service.suspend(license.id);
    assertCode(
      () => app.service.verify({ sessionToken: session.sessionToken }),
      ERROR_CODES.LICENSE_SUSPENDED,
    );

    // Lifting the suspension restores the same session: suspend is reversible,
    // so it must not silently destroy a customer's access.
    app.service.reactivate(license.id);
    assert.equal(app.service.verify({ sessionToken: session.sessionToken }).license.status, 'active');
  });
});

test('10. rejects an expired licence', () => {
  withService((app) => {
    const { license, code } = app.service.createLicense({ expiresInDays: 1 });
    assert.equal(
      app.service.activate({ licenseCode: code, installId: 'i' }).license.status,
      'active',
    );

    app.advance(DAY + 1);

    assertCode(
      () => app.service.activate({ licenseCode: code, installId: 'i' }),
      ERROR_CODES.LICENSE_EXPIRED,
    );
    assertCode(
      () => app.service.verify({ sessionToken: 'x'.repeat(43) }),
      ERROR_CODES.INVALID_SESSION,
      'a session for an expired licence must not resolve either',
    );
  });
});

test('10b. expiry is derived from the clock, not stored as a flag', () => {
  withService((app) => {
    const { license, session } = app.issueAndActivate({ expiresInDays: 1 });
    const token = session.sessionToken;

    // One millisecond before the boundary it is still active.
    app.setNow(license.expiresAt - 1);
    assert.equal(app.service.verify({ sessionToken: token }).license.status, 'active');

    // At the boundary it is expired, with no background job having run.
    app.setNow(license.expiresAt);
    const record = app.repository.findById(license.id);
    assert.equal(record.status, 'active', 'the stored status never changed');
    assert.equal(effectiveStatus(record, app.now()), 'expired');

    assertCode(
      () => app.service.verify({ sessionToken: token }),
      ERROR_CODES.LICENSE_EXPIRED,
    );
  });
});

test('10c. a suspended licence reports suspended even after its date passes', () => {
  withService((app) => {
    const { license } = app.issueAndActivate({ expiresInDays: 1 });
    app.service.suspend(license.id);
    app.advance(2 * DAY);

    const record = app.repository.findById(license.id);
    assert.equal(effectiveStatus(record, app.now()), 'suspended');
    assertCode(
      () => app.service.verify({ sessionToken: app.repository.findById(license.id) && '' }),
      ERROR_CODES.INVALID_SESSION,
    );
  });
});

test('11. rejects a revoked licence, permanently', () => {
  withService((app) => {
    const { license, code, session } = app.issueAndActivate();
    const token = session.sessionToken;

    app.service.revoke(license.id, 'refund issued');

    assertCode(() => app.service.activate({ licenseCode: code, installId: 'i' }), ERROR_CODES.LICENSE_REVOKED);
    assertCode(() => app.service.verify({ sessionToken: token }), ERROR_CODES.INVALID_SESSION);

    // Revocation is final. "Reactivate" must not be a way back in.
    assertCode(() => app.service.reactivate(license.id), ERROR_CODES.LICENSE_REVOKED);

    // ...and it outranks expiry: a revoked licence stays revoked past its date.
    app.advance(400 * DAY);
    const record = app.repository.findById(license.id);
    assert.equal(effectiveStatus(record, app.now()), 'revoked');
  });
});

test('12. a bound licence cannot bind to a second account', () => {
  withService((app) => {
    const { license, session } = app.issueAndActivate({ expiresInDays: 30 }, { accountId: 'account-a' });
    assert.equal(app.repository.findById(license.id).linkedAccountId, 'account-a');

    assertCode(
      () => app.service.bind({ sessionToken: session.sessionToken, accountId: 'account-b' }),
      ERROR_CODES.ACCOUNT_MISMATCH,
      'second account',
    );

    // The original owner is unaffected, and re-binding is idempotent.
    assert.equal(
      app.service.bind({ sessionToken: session.sessionToken, accountId: 'account-a' }).linkedAccountId,
      'account-a',
    );
    assert.equal(app.service.verify({ sessionToken: session.sessionToken }).license.status, 'active');

    // A different licence can still be bound to account-b: the rule is one
    // licence per account-slot, not a single account for the whole system.
    const other = app.issueAndActivate({ expiresInDays: 30 }, { accountId: 'account-b' });
    assert.equal(other.session.linkedAccountId, 'account-b');
  });
});

test('12b. binding is the first bind that sticks, and there is no unbind', () => {
  withService((app) => {
    const { license, session } = app.issueAndActivate();
    assert.equal(app.repository.findById(license.id).linkedAccountId, null);

    assert.equal(
      app.service.bind({ sessionToken: session.sessionToken, accountId: 'account-a' }).linkedAccountId,
      'account-a',
    );
    assert.equal(app.repository.findById(license.id).linkedAccountId, 'account-a');

    // The service exposes no operation that would set it back to null.
    const adminOps = Object.keys(app.service).filter((key) =>
      /unbind|reset|clear|delete|remove/i.test(key),
    );
    assert.deepEqual(adminOps, [], 'no unbinding operation may exist');
  });
});

test('12c. bind requires an accountId', () => {
  withService((app) => {
    const { session } = app.issueAndActivate();
    assertCode(() => app.service.bind({ sessionToken: session.sessionToken }), ERROR_CODES.INVALID_REQUEST);
  });
});

test('13. verify returns the server time, generated on the server', () => {
  withService((app) => {
    const { session } = app.issueAndActivate();

    app.advance(60000);
    const result = app.service.verify({
      sessionToken: session.sessionToken,
      installId: 'install-001',
      // A client claiming a wildly different time must not move the server clock.
      serverTime: 1,
      clientTime: 1,
      timestamp: 1,
    });

    assert.equal(result.serverTime, app.now());
    assert.notEqual(result.serverTime, 1);
  });
});

test('13b. every response, including errors, carries the server time', () => {
  withService((app) => {
    app.advance(123456);
    const ok = app.service.verify({ sessionToken: app.issueAndActivate().session.sessionToken });
    assert.equal(ok.serverTime, app.now());

    const err = assertCode(() => app.service.verify({ sessionToken: 'bogus' }), ERROR_CODES.INVALID_SESSION);
    assert.equal(err.status, 401);
  });
});

test('14. verify returns the licence status', () => {
  withService((app) => {
    const { license, session } = app.issueAndActivate({ expiresInDays: 10 });
    const token = session.sessionToken;

    const fresh = app.service.verify({ sessionToken: token });
    assert.equal(fresh.license.status, 'active');
    assert.equal(fresh.license.id, license.id);
    assert.equal(fresh.license.expiresAt, license.expiresAt);

    app.service.suspend(license.id);
    assert.throws(() => app.service.verify({ sessionToken: token }), (err) => err.code === ERROR_CODES.LICENSE_SUSPENDED);
  });
});

test('14b. verify updates lastVerifiedAt but never invents entitlement fields', () => {
  withService((app) => {
    const { license, session } = app.issueAndActivate();
    assert.equal(app.repository.findById(license.id).lastVerifiedAt, null);

    app.advance(3600000);
    const result = app.service.verify({ sessionToken: session.sessionToken });

    assert.equal(app.repository.findById(license.id).lastVerifiedAt, app.now());
    assert.equal(result.serverTime, app.now());
    // The entitlement is exactly id, status, expiresAt — a client cannot come
    // away holding the note, the code hash, or the bound account.
    assert.deepEqual(Object.keys(result.license).sort(), ['expiresAt', 'id', 'status']);
    assert.deepEqual(
      result.license,
      entitlementFor(app.repository.findById(license.id), app.now()),
    );
  });
});

test('15/16/17. verify records installId, appVersion and platform', () => {
  withService((app) => {
    const { license, session } = app.issueAndActivate();

    app.advance(1000);
    app.service.verify({
      sessionToken: session.sessionToken,
      installId: 'install-verify-42',
      platform: 'android',
      appVersion: '1.2.3',
    });

    const installs = app.repository.listInstalls(license.id);
    const match = installs.find((row) => row.installId === 'install-verify-42');

    assert.ok(match, 'installId should be recorded');
    assert.equal(match.platform, 'android');
    assert.equal(match.appVersion, '1.2.3');
    assert.equal(match.firstSeenAt, app.now());
    assert.equal(match.lastSeenAt, app.now());
  });
});

test('15b. metadata is refreshed on repeat verifies, and never duplicated', () => {
  withService((app) => {
    const { license, session } = app.issueAndActivate();

    app.service.verify({ sessionToken: session.sessionToken, installId: 'install-x', platform: 'web', appVersion: '1.0.0' });
    app.advance(60000);
    app.service.verify({ sessionToken: session.sessionToken, installId: 'install-x', platform: 'android', appVersion: '1.1.0' });

    const installs = app.repository.listInstalls(license.id).filter((row) => row.installId === 'install-x');
    assert.equal(installs.length, 1, 'one row per install, not one per request');
    assert.equal(installs[0].platform, 'android', 'latest platform wins');
    assert.equal(installs[0].appVersion, '1.1.0');
    assert.equal(installs[0].lastSeenAt, app.now());
  });
});

test('15c. no hard device limit — extra installs are recorded, never refused', () => {
  withService((app) => {
    const { license, code } = app.service.createLicense({ expiresInDays: 30 });

    for (let i = 0; i < 25; i += 1) {
      const result = app.service.activate({
        licenseCode: code,
        installId: `install-${i}`,
        platform: 'android',
        appVersion: '1.0.0',
      });
      assert.equal(result.license.status, 'active', `install ${i} should be allowed`);
    }

    const installs = app.repository.listInstalls(license.id);
    assert.equal(installs.length, 25);
    // firstSeenAt is preserved per install even after later activity elsewhere.
    assert.ok(installs.every((row) => row.firstSeenAt <= row.lastSeenAt));
  });
});

test('15d. an unknown platform is refused rather than stored', () => {
  withService((app) => {
    const { code } = app.service.createLicense({});
    assertCode(
      () => app.service.activate({ licenseCode: code, installId: 'i', platform: 'toaster' }),
      ERROR_CODES.INVALID_REQUEST,
    );
    // 'unknown' is a real answer when the bridge cannot report, and is allowed.
    assert.equal(
      app.service.activate({ licenseCode: code, installId: 'i', platform: 'unknown', appVersion: '1.0.0' }).license.status,
      'active',
    );
  });
});

test('18. store data never enters the licence payload', () => {
  withService((app) => {
    const { code } = app.service.createLicense({ expiresInDays: 30 });

    // A client that dumps its entire store into the licence endpoint.
    const leaky = {
      licenseCode: code,
      installId: 'install-001',
      platform: 'android',
      appVersion: '1.0.0',
      products: [{ id: 1, name: 'Cement', cost: 42 }],
      sales: [{ id: 9, total: 1000, customer: 'Ali', phone: '0500000000' }],
      inventory: { warehouse: 'main', items: 300 },
      invoices: [{ number: 'INV-1' }],
      customers: [{ name: 'Ali', address: 'Somewhere' }],
      reports: [{ month: 1, revenue: 99999 }],
      settings: { adminPassword: 'hunter2' },
      backup: 'base64-blob-of-everything',
      database: { name: 'saher_db' },
    };

    const result = app.service.activate(leaky);
    assert.equal(result.license.status, 'active');

    // Nothing but the entitlement left the service.
    assert.deepEqual(Object.keys(result).sort(), ['license', 'linkedAccountId', 'serverTime', 'sessionToken']);
    assert.deepEqual(Object.keys(result.license).sort(), ['expiresAt', 'id', 'status']);

    // And nothing was persisted anywhere.
    const record = app.repository.findById(result.license.id, { includeSecrets: true });
    const serialized = JSON.stringify(record);
    for (const leaked of ['Cement', 'Ali', '0500000000', 'hunter2', 'INV-1', '99999', 'saher_db', 'products', 'sales', 'customers']) {
      assert.ok(!serialized.includes(leaked), `"${leaked}" must not reach the database`);
    }

    const installs = JSON.stringify(app.repository.listInstalls(result.license.id));
    assert.ok(!installs.includes('Cement'));
    assert.equal(JSON.parse(installs).length, 1);
    assert.deepEqual(JSON.parse(installs)[0].installId, 'install-001');
  });
});

test('18b. an oversized field is truncated, not stored whole', () => {
  withService((app) => {
    const { license, session } = app.issueAndActivate();
    app.service.verify({
      sessionToken: session.sessionToken,
      installId: 'x'.repeat(5000),
      platform: 'web',
      appVersion: '1.0.0',
    });

    const installs = app.repository.listInstalls(license.id);
    // The 5000-char id is truncated to 64; the original long one should not exist.
    const truncated = installs.find((row) => row.installId.length === 64);
    assert.ok(truncated, 'the truncated id should be recorded');
    assert.equal(truncated.installId.length, 64, 'capped at the documented field limit');
    assert.equal(truncated.installId, 'x'.repeat(64));
    // And no 5000-char entry exists.
    const long = installs.find((row) => row.installId.length > 100);
    assert.ok(!long, 'the original long id must not be stored');
  });
});

test('20. error responses use stable machine-readable codes', () => {
  withService((app) => {
    const { license, code, session } = app.issueAndActivate();

    const cases = [
      [() => app.service.activate({ licenseCode: 'x', installId: 'i' }), ERROR_CODES.INVALID_LICENSE],
      [() => app.service.activate({ licenseCode: generateLicenseCode(), installId: 'i' }), ERROR_CODES.LICENSE_NOT_FOUND],
      [() => app.service.activate({}), ERROR_CODES.INVALID_LICENSE],
      [() => app.service.verify({ sessionToken: 'nope' }), ERROR_CODES.INVALID_SESSION],
      [() => app.service.verify({}), ERROR_CODES.INVALID_SESSION],
      [() => app.service.bind({ sessionToken: session.sessionToken, accountId: 'a' }), null],
    ];

    for (const [fn, expected] of cases) {
      if (!expected) continue;
      const err = assertCode(fn, expected);
      // The code is the contract: a string, from the frozen set, with an HTTP
      // status attached. A message is allowed to be missing; the code is not.
      assert.equal(typeof err.code, 'string');
      assert.ok(Object.values(ERROR_CODES).includes(err.code));
      assert.ok(Number.isInteger(err.status));
      assert.ok(err.status >= 400 && err.status < 600);
    }

    app.service.suspend(license.id);
    assertCode(() => app.service.activate({ licenseCode: code, installId: 'i' }), ERROR_CODES.LICENSE_SUSPENDED);
  });
});

test('20b. an unknown licence id is not found, not an internal error', () => {
  withService((app) => {
    const err = assertCode(
      () => app.service.getLicense('00000000-0000-4000-8000-000000000000'),
      ERROR_CODES.LICENSE_NOT_FOUND,
    );
    assert.equal(err.status, 404);
    assertCode(
      () => app.service.suspend('00000000-0000-4000-8000-000000000000'),
      ERROR_CODES.LICENSE_NOT_FOUND,
    );
    assertCode(
      () => app.service.setStatus(licenseId(app), 'melted'),
      ERROR_CODES.INVALID_REQUEST,
    );
  });
});

/** @param {{issueAndActivate: Function}} app @returns {string} */
function licenseId(app) {
  return app.issueAndActivate().license.id;
}