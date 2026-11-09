/**
 * Regression: a successful licence activation must end in a sellable app.
 *
 * The complaint this file pins down: entering a code in Settings toasted
 * "تم تفعيل الترخيص" while the status stayed "غير مسجَّل" and checkout stayed
 * blocked. `getEntitlement` (js/entitlement.js:121) reports UNAUTHENTICATED with
 * `canSell:false` whenever there is no signed-in Google account, however valid
 * the licence is. So "the backend accepted the code" and "this device may sell"
 * are two different facts, and the client flow has to bridge them by binding the
 * licence to the signed-in account.
 *
 * A second defect lived one layer down: `saveLicenseRecord` dropped the session
 * token the activation returned, so "تحقق الآن" failed with NO_SESSION and the
 * bind call fell back to a bare account id, which the server rejects. Both are
 * covered here, through the real client modules and a scripted fetch, so the
 * suite fails on the broken flow rather than only on the fixed one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  configureIdentity,
  clearIdentityData,
  saveAuthSession,
  getLicenseRecord,
} from '../../js/identity-store.js';
import { getEntitlement, ENTITLEMENT_STATE } from '../../js/entitlement.js';
import { resetTrustedTime } from '../../js/clock.js';
import { activateLicense, bindLicense, verifyLicense } from '../../js/license-client.js';
import { createFakeIndexedDB } from './fake-indexeddb.mjs';

/** A fresh, empty identity database for one test, with the clock untrusted. */
async function setupIdentity() {
  const db = createFakeIndexedDB();
  globalThis.indexedDB = db;
  configureIdentity({ indexedDB: db });
  resetTrustedTime();
  // Also resets the memoised install id, so each test mints its own.
  await clearIdentityData();
  return db;
}

/** Restores the globals the suite shares. */
async function teardownIdentity() {
  resetTrustedTime();
  await clearIdentityData().catch(() => {});
  delete globalThis.indexedDB;
}

/** The subset of the fetch Response contract `license-client` reads. */
function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, statusText: ok ? 'OK' : 'ERROR', json: async () => body };
}

/**
 * A fetch keyed by the last path segment (`activate` / `verify` / `bind`),
 * recording what each call actually sent so the tests can assert on the wire
 * shape, not just the outcome.
 */
function scriptedFetch(routes) {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    const path = String(url);
    const name = path.slice(path.lastIndexOf('/') + 1);
    const body = init.body ? JSON.parse(init.body) : null;
    seen.push({ path, body });
    const route = routes[name];
    if (!route) {
      return jsonResponse(
        { ok: false, error: { code: 'UNSCRIPTED', message: `no route for ${name}` }, serverTime: Date.now() },
        { ok: false, status: 500 },
      );
    }
    return jsonResponse(route({ path, body }));
  };
  return { fetchImpl, seen };
}

const ACTIVE_LICENSE = { id: 'lic-1', status: 'active', expiresAt: null };

test('REGRESSION: a successful activation with no Google account is not sellable', async () => {
  await setupIdentity();
  try {
    const { fetchImpl } = scriptedFetch({
      activate: () => ({
        ok: true,
        license: ACTIVE_LICENSE,
        sessionToken: 'tok-1',
        linkedAccountId: null,
        serverTime: Date.now(),
      }),
    });

    const res = await activateLicense('SAHER-TEST-0001', { fetchImpl });
    assert.equal(res.ok, true, 'the backend accepted the code');

    // The old Settings screen stopped here and toasted "تم تفعيل الترخيص". The
    // entitlement engine disagrees, and it is the one checkout trusts.
    const e = await getEntitlement();
    assert.equal(e.state, ENTITLEMENT_STATE.UNAUTHENTICATED);
    assert.equal(e.canSell, false);
    assert.ok(e.license, 'the licence is stored; only the account link is missing');
  } finally {
    await teardownIdentity();
  }
});

test('REGRESSION: activation bound to the signed-in account is ACTIVE and sellable', async () => {
  await setupIdentity();
  try {
    await saveAuthSession({
      googleSub: 'google-sub-1',
      email: 'owner@example.test',
      displayName: 'Owner',
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });

    const { fetchImpl, seen } = scriptedFetch({
      activate: () => ({
        ok: true,
        license: ACTIVE_LICENSE,
        sessionToken: 'tok-1',
        linkedAccountId: null,
        serverTime: Date.now(),
      }),
      bind: () => ({
        ok: true,
        license: ACTIVE_LICENSE,
        linkedAccountId: 'google-sub-1',
        serverTime: Date.now(),
      }),
    });

    const act = await activateLicense('SAHER-TEST-0001', { fetchImpl });
    assert.equal(act.ok, true);

    const bind = await bindLicense('google-sub-1', { fetchImpl });
    assert.equal(bind.ok, true);
    assert.equal(bind.linkedAccountId, 'google-sub-1');

    // The client must bind through the stored session, not a bare account id:
    // the server's bind route rejects a request with neither session nor code.
    const bindCall = seen.find((call) => call.path.endsWith('/bind'));
    assert.equal(bindCall.body.sessionToken, 'tok-1');
    assert.equal(bindCall.body.accountId, 'google-sub-1');

    const e = await getEntitlement();
    assert.equal(e.state, ENTITLEMENT_STATE.ACTIVE);
    assert.equal(e.canSell, true);
    assert.equal(e.licenseBoundTo, 'google-sub-1');
    assert.equal(e.authGoogleSub, 'google-sub-1');
  } finally {
    await teardownIdentity();
  }
});

test('REGRESSION: the activation session token survives storage so verify works', async () => {
  await setupIdentity();
  try {
    const { fetchImpl, seen } = scriptedFetch({
      activate: () => ({
        ok: true,
        license: ACTIVE_LICENSE,
        sessionToken: 'tok-1',
        linkedAccountId: null,
        serverTime: Date.now(),
      }),
      verify: () => ({ ok: true, license: ACTIVE_LICENSE, serverTime: Date.now() }),
    });

    await activateLicense('SAHER-TEST-0001', { fetchImpl });

    // Before the fix this was null, which made verifyLicense answer NO_SESSION
    // and bindLicense send only `{ accountId }` — rejected by the server.
    const stored = await getLicenseRecord();
    assert.equal(stored.sessionToken, 'tok-1', 'saveLicenseRecord must persist the session token');

    const verified = await verifyLicense({ fetchImpl });
    assert.equal(verified.ok, true);

    const verifyCall = seen.find((call) => call.path.endsWith('/verify'));
    assert.ok(verifyCall, 'verify must have been requested');
    assert.equal(verifyCall.body.sessionToken, 'tok-1');
  } finally {
    await teardownIdentity();
  }
});
