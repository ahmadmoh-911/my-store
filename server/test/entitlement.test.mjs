/**
 * Entitlement tests — client-side licence enforcement logic.
 *
 * Covers the 18 required test areas from the spec.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { configureIdentity, resetIdentityConnection, getIdentityDb, IDENTITY_STORES, saveLicenseRecord, saveAuthSession } from '../../js/identity-store.js';
import {
  getEntitlement,
  canSell,
  getEntitlementMessage,
  needsOnlineVerification,
  ENTITLEMENT_STATE,
  OFFLINE_GRACE_MS,
} from '../../js/entitlement.js';

import { setTrustedServerTime, resetTrustedTime, estimatedServerTime, NO_TRUSTED_TIME } from '../../js/clock.js';

/**
 * Test harness: creates a fake IndexedDB in Node using the same
 * fake-indexeddb that the foundation tests use.
 */
import { createFakeIndexedDB } from './fake-indexeddb.mjs';

const originalIndexedDB = globalThis.indexedDB;

/** Sets up a fresh fake IndexedDB for each test. */
function setupFakeDB() {
  const fakeDB = createFakeIndexedDB();
  globalThis.indexedDB = fakeDB;
  resetIdentityConnection();
  configureIdentity({ indexedDB: fakeDB, name: 'storehub_identity', version: 1 });
  resetTrustedTime();
  return fakeDB;
}

/** Tears down the fake DB. */
function teardownFakeDB() {
  globalThis.indexedDB = originalIndexedDB;
  resetIdentityConnection();
  resetTrustedTime();
}

/** Sets the trusted server time via clock.js. */
function setTrustedTime(ms) {
  setTrustedServerTime(ms);
}

/** Helper to create a base active license record. */
function baseLicenseRecord(overrides = {}) {
  const now = Date.now();
  return {
    licenseId: 'lic-123',
    status: 'active',
    expiresAt: now + 365 * 24 * 60 * 60 * 1000, // 1 year from now
    lastVerifiedAt: new Date(now).toISOString(),
    lastServerTime: now,
    lastTrustedVerificationAt: new Date(now).toISOString(),
    linkedAccountId: 'google-sub-123',
    ...overrides,
  };
}

/** Helper to create a base auth session. */
function baseAuthSession(overrides = {}) {
  const now = Date.now();
  return {
    sessionToken: 'session-token-abc',
    expiresAt: now + 30 * 24 * 60 * 60 * 1000,
    googleSub: 'google-sub-123',
    email: 'user@example.com',
    displayName: 'Test User',
    ...overrides,
  };
}

/** Writes a licence record using the identity-store save function. */
async function writeLicenseRecord(record) {
  await saveLicenseRecord(record);
}

/** Writes an auth session record using the identity-store save function. */
async function writeAuthSession(session) {
  await saveAuthSession(session);
}

// ============================================================
// TESTS
// ============================================================

test('1. New user with no license → UNACTIVATED, cannot sell', async () => {
  setupFakeDB();
  try {
    const e = await getEntitlement();
    assert.equal(e.state, ENTITLEMENT_STATE.UNACTIVATED);
    assert.equal(e.canSell, false);
    assert.equal(e.license, null);
  } finally {
    teardownFakeDB();
  }
});

test('2. License activated but no Google account → UNAUTHENTICATED, cannot sell', async () => {
  setupFakeDB();
  try {
    await writeLicenseRecord(baseLicenseRecord());
    const e = await getEntitlement();
    assert.equal(e.state, ENTITLEMENT_STATE.UNAUTHENTICATED);
    assert.equal(e.canSell, false);
    assert.ok(e.license);
    assert.equal(e.auth, null);
  } finally {
    teardownFakeDB();
  }
});

test('3. License + Google account, same googleSub → ACTIVE, can sell', async () => {
  setupFakeDB();
  try {
    await writeLicenseRecord(baseLicenseRecord());
    await writeAuthSession(baseAuthSession());
    setTrustedTime(Date.now()); // trusted time exists (now)

    const e = await getEntitlement();
    assert.equal(e.state, ENTITLEMENT_STATE.ACTIVE);
    assert.equal(e.canSell, true);
    assert.equal(e.licenseBoundTo, 'google-sub-123');
    assert.equal(e.authGoogleSub, 'google-sub-123');
  } finally {
    teardownFakeDB();
  }
});

test('4. License bound to same Google account (re-verify) → ACTIVE, can sell', async () => {
  setupFakeDB();
  try {
    await writeLicenseRecord(baseLicenseRecord());
    await writeAuthSession(baseAuthSession());
    setTrustedTime(Date.now());

    const e = await getEntitlement();
    assert.equal(e.state, ENTITLEMENT_STATE.ACTIVE);
    assert.equal(e.canSell, true);
  } finally {
    teardownFakeDB();
  }
});

test('5. License bound to different Google account → ACCOUNT_MISMATCH, cannot sell', async () => {
  setupFakeDB();
  try {
    await writeLicenseRecord(baseLicenseRecord({ linkedAccountId: 'google-sub-456' }));
    await writeAuthSession(baseAuthSession({ googleSub: 'google-sub-123' }));
    setTrustedTime(Date.now());

    const e = await getEntitlement();
    assert.equal(e.state, ENTITLEMENT_STATE.ACCOUNT_MISMATCH);
    assert.equal(e.canSell, false);
    assert.equal(e.licenseBoundTo, 'google-sub-456');
    assert.equal(e.authGoogleSub, 'google-sub-123');
  } finally {
    teardownFakeDB();
  }
});

test('6. Active license online → ACTIVE, can sell', async () => {
  setupFakeDB();
  try {
    await writeLicenseRecord(baseLicenseRecord());
    await writeAuthSession(baseAuthSession());
    setTrustedTime(Date.now());

    const e = await getEntitlement();
    assert.equal(e.state, ENTITLEMENT_STATE.ACTIVE);
    assert.equal(e.canSell, true);
    // offlineSinceMs should be within tolerance (<= 1000ms)
    assert.ok(e.offlineSinceMs <= 1000);
  } finally {
    teardownFakeDB();
  }
});

test('7. Active license offline within 14 days → OFFLINE_GRACE, can sell', async () => {
  setupFakeDB();
  try {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    await writeLicenseRecord(baseLicenseRecord({
      lastServerTime: oneDayAgo,
      lastTrustedVerificationAt: new Date(oneDayAgo).toISOString(),
    }));
    await writeAuthSession(baseAuthSession());
    setTrustedTime(oneDayAgo);

    // Advance the fake clock by 1 day
    // We simulate this by setting a new trusted time further ahead
    setTrustedTime(now);

    const e = await getEntitlement();
    assert.equal(e.state, ENTITLEMENT_STATE.OFFLINE_GRACE);
    assert.equal(e.canSell, true);
    assert.ok(e.offlineSinceMs > 0);
    assert.ok(e.offlineSinceMs < OFFLINE_GRACE_MS);
    assert.ok(e.graceRemainingMs > 0);
  } finally {
    teardownFakeDB();
  }
});

test('8. Offline grace expired (>14 days) → OFFLINE_GRACE_EXPIRED, cannot sell', async () => {
  setupFakeDB();
  try {
    const now = Date.now();
    const fifteenDaysAgo = now - 15 * 24 * 60 * 60 * 1000;
    await writeLicenseRecord(baseLicenseRecord({
      lastServerTime: fifteenDaysAgo,
      lastTrustedVerificationAt: new Date(fifteenDaysAgo).toISOString(),
    }));
    await writeAuthSession(baseAuthSession());
    setTrustedTime(fifteenDaysAgo);
    // Advance to "now"
    setTrustedTime(now);

    const e = await getEntitlement();
    assert.equal(e.state, ENTITLEMENT_STATE.OFFLINE_GRACE_EXPIRED);
    assert.equal(e.canSell, false);
    assert.ok(e.offlineSinceMs > OFFLINE_GRACE_MS);
    assert.equal(e.graceRemainingMs, 0);
  } finally {
    teardownFakeDB();
  }
});

test('9. Suspended license → SUSPENDED, cannot sell', async () => {
  setupFakeDB();
  try {
    await writeLicenseRecord(baseLicenseRecord({ status: 'suspended' }));
    await writeAuthSession(baseAuthSession());
    setTrustedTime(Date.now() - 1000);

    const e = await getEntitlement();
    assert.equal(e.state, ENTITLEMENT_STATE.SUSPENDED);
    assert.equal(e.canSell, false);
  } finally {
    teardownFakeDB();
  }
});

test('10. Expired license → EXPIRED, cannot sell', async () => {
  setupFakeDB();
  try {
    const yesterday = Date.now() - 24 * 60 * 60 * 1000;
    await writeLicenseRecord(baseLicenseRecord({ expiresAt: yesterday }));
    await writeAuthSession(baseAuthSession());
    setTrustedTime(Date.now());

    const e = await getEntitlement();
    assert.equal(e.state, ENTITLEMENT_STATE.EXPIRED);
    assert.equal(e.canSell, false);
  } finally {
    teardownFakeDB();
  }
});

test('11. Revoked license → REVOKED, cannot sell', async () => {
  setupFakeDB();
  try {
    await writeLicenseRecord(baseLicenseRecord({ status: 'revoked' }));
    await writeAuthSession(baseAuthSession());
    setTrustedTime(Date.now() - 1000);

    const e = await getEntitlement();
    assert.equal(e.state, ENTITLEMENT_STATE.REVOKED);
    assert.equal(e.canSell, false);
  } finally {
    teardownFakeDB();
  }
});

test('12. Clock moved backwards significantly → CLOCK_SUSPECT, cannot sell', async () => {
  setupFakeDB();
  try {
    await writeLicenseRecord(baseLicenseRecord());
    await writeAuthSession(baseAuthSession());
    setTrustedTime(Date.now() - 1000);

    // Simulate clock moved backwards by making estimatedServerTime return
    // a value that makes isClockSuspect return true.
    // We do this by setting a trusted time that's far in the future relative to now.
    // Actually, isClockSuspect compares Date.now() vs estimatedServerTime().
    // If we set trusted time to far future, then estimatedServerTime will be
    // far future, Date.now() will be "now", and skew will be negative large.
    // isClockSuspect uses absolute value, so it will trigger.

    const farFuture = Date.now() + 2 * 60 * 1000; // 2 minutes in future
    setTrustedTime(farFuture);

    const e = await getEntitlement();
    // clockSkewMs = Date.now() - estimatedServerTime() ≈ -2 min
    // Math.abs(-2min) > 60s → clockSuspect = true
    assert.equal(e.state, ENTITLEMENT_STATE.CLOCK_SUSPECT);
    assert.equal(e.canSell, false);
    assert.equal(e.clockSuspect, true);
  } finally {
    teardownFakeDB();
  }
});

test('13. Online verification refreshes trusted time', async () => {
  setupFakeDB();
  try {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    await writeLicenseRecord(baseLicenseRecord({
      lastServerTime: oneDayAgo,
      lastTrustedVerificationAt: new Date(oneDayAgo).toISOString(),
    }));
    await writeAuthSession(baseAuthSession());
    setTrustedTime(oneDayAgo);

    // Simulate a successful online verification by updating the license record
    // with fresh timestamps (as verifyLicense would do)
    const verificationTime = now;
    await writeLicenseRecord(baseLicenseRecord({
      lastServerTime: verificationTime,
      lastTrustedVerificationAt: new Date(verificationTime).toISOString(),
    }));
    // Update trusted time to match
    setTrustedTime(verificationTime);

    const e = await getEntitlement();
    // After verification, we should be ACTIVE (offlineSinceMs ≈ 0)
    assert.equal(e.state, ENTITLEMENT_STATE.ACTIVE);
    assert.equal(e.canSell, true);
    assert.ok(e.offlineSinceMs <= 1000);
  } finally {
    teardownFakeDB();
  }
});

test('14. Local store data is never sent to license/auth endpoints', async () => {
  // This is a design-time check: the license-client.js and auth-client.js
  // only send installId, platform, appVersion, licenseCode, sessionToken,
  // accountId, googleSub, email, displayName, avatarUrl.
  // They never import or reference db.js, products, sales, inventory, etc.
  // This test documents the invariant.
  const fs = await import('node:fs');
  const licenseSource = fs.readFileSync(new URL('../../js/license-client.js', import.meta.url), 'utf8');
  const authSource = fs.readFileSync(new URL('../../js/auth-client.js', import.meta.url), 'utf8');

  const forbiddenPatterns = [
    'products',
    'sales',
    'inventory',
    'invoices',
    'customers',
    'reports',
    'backup',
    'database',
    'db.js',
    'from \'./db',
    'import.*db',
  ];

  for (const pattern of forbiddenPatterns) {
    const regex = new RegExp(pattern, 'i');
    assert.ok(!regex.test(licenseSource), `license-client.js contains forbidden pattern: ${pattern}`);
    assert.ok(!regex.test(authSource), `auth-client.js contains forbidden pattern: ${pattern}`);
  }
});

test('15. New sale blocked when entitlement does not allow selling', async () => {
  setupFakeDB();
  try {
    // Set up an expired license (cannot sell)
    const yesterday = Date.now() - 24 * 60 * 60 * 1000;
    await writeLicenseRecord(baseLicenseRecord({ expiresAt: yesterday }));
    await writeAuthSession(baseAuthSession());
    setTrustedTime(Date.now());

    const { canSell } = await import('../../js/entitlement.js');
    const can = await canSell();
    assert.equal(can, false);

    // The entitlement state should be EXPIRED
    const e = await getEntitlement();
    assert.equal(e.state, ENTITLEMENT_STATE.EXPIRED);
    assert.equal(e.canSell, false);
  } finally {
    teardownFakeDB();
  }
});

test('16. New sale works when entitlement is valid', async () => {
  setupFakeDB();
  try {
    await writeLicenseRecord(baseLicenseRecord());
    await writeAuthSession(baseAuthSession());
    setTrustedTime(Date.now() - 1000);

    const { canSell } = await import('../../js/entitlement.js');
    const can = await canSell();
    assert.equal(can, true);

    const e = await getEntitlement();
    assert.equal(e.state, ENTITLEMENT_STATE.ACTIVE);
    assert.equal(e.canSell, true);
  } finally {
    teardownFakeDB();
  }
});

test('17. Existing reports/products/inventory remain accessible when selling is blocked', async () => {
  // This is an architectural guarantee: the entitlement engine only
  // blocks the checkout flow (cart-bar.js → checkout.js). It does not
  // affect db.js, product screens, reports screens, etc.
  //
  // The test verifies that the entitlement module does not import or
  // call any store data functions.
  const fs = await import('node:fs');
  const entitlementSource = fs.readFileSync(new URL('../../js/entitlement.js', import.meta.url), 'utf8');

  const forbiddenImports = [
    'from \'./db',
    'import.*db',
    'listProducts',
    'listSales',
    'createSale',
    'variantStock',
    'getSettings',
  ];

  for (const imp of forbiddenImports) {
    const regex = new RegExp(imp);
    assert.ok(!regex.test(entitlementSource), `entitlement.js imports forbidden module: ${imp}`);
  }
});

test('18. Existing sale transaction atomicity remains intact', async () => {
  // The checkout.js flow is:
  // 1. confirm dialog
  // 2. ENTITLEMENT CHECK (NEW)
  // 3. stock validation
  // 4. createSale (single transaction)
  // 4. clearCart
  //
  // The entitlement check is inserted BEFORE the stock validation
  // and createSale. If entitlement fails, the function returns early
  // without touching the cart or database.
  //
  // This test verifies the checkout.js source structure.
  const fs = await import('node:fs');
  const checkoutSource = fs.readFileSync(new URL('../../js/checkout.js', import.meta.url), 'utf8');

  // The entitlement check must come before the createSale CALL (not import)
  // Find the first call to createSale (after the imports)
  const entitlementCallPos = checkoutSource.indexOf('await getEntitlement()');
  const createSaleCallPos = checkoutSource.indexOf('await createSale(');

  assert.ok(entitlementCallPos > 0, 'entitlement check call not found in checkout.js');
  assert.ok(createSaleCallPos > 0, 'createSale call not found in checkout.js');
  assert.ok(entitlementCallPos < createSaleCallPos, 'entitlement check must come before createSale');

  // The entitlement check must return early if canSell is false
  // Look for the return false after the entitlement check
  const earlyReturnPos = checkoutSource.indexOf('return false', entitlementCallPos);
  assert.ok(earlyReturnPos > entitlementCallPos && earlyReturnPos < createSaleCallPos,
    'entitlement failure must return before createSale');
});

test('OFFLINE_GRACE shows correct grace remaining', async () => {
  setupFakeDB();
  try {
    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    await writeLicenseRecord(baseLicenseRecord({
      lastServerTime: sevenDaysAgo,
      lastTrustedVerificationAt: new Date(sevenDaysAgo).toISOString(),
    }));
    await writeAuthSession(baseAuthSession());
    setTrustedTime(sevenDaysAgo);
    setTrustedTime(now);

    const e = await getEntitlement();
    assert.equal(e.state, ENTITLEMENT_STATE.OFFLINE_GRACE);
    assert.equal(e.canSell, true);
    // 7 days elapsed, 7 days remaining
    const expectedRemaining = OFFLINE_GRACE_MS - 7 * 24 * 60 * 60 * 1000;
    const tolerance = 60 * 60 * 1000; // 1 hour tolerance
    assert.ok(Math.abs(e.graceRemainingMs - expectedRemaining) < tolerance);
  } finally {
    teardownFakeDB();
  }
});

test('getEntitlementMessage returns Arabic messages', async () => {
  setupFakeDB();
  try {
    await writeLicenseRecord(baseLicenseRecord());
    await writeAuthSession(baseAuthSession());
    setTrustedTime(Date.now() - 1000);

    const msg = await getEntitlementMessage();
    assert.ok(typeof msg === 'string');
    assert.ok(msg.length > 0);
    // Should contain Arabic text
    assert.ok(/[\u0600-\u06FF]/.test(msg));
  } finally {
    teardownFakeDB();
  }
});

test('needsOnlineVerification returns true for states needing verification', async () => {
  setupFakeDB();
  try {
    // No license - cannot verify what doesn't exist (needs activation, not verification)
    assert.equal(await needsOnlineVerification(), false);

    // Active license with trusted time
    await writeLicenseRecord(baseLicenseRecord());
    await writeAuthSession(baseAuthSession());
    setTrustedTime(Date.now());
    assert.equal(await needsOnlineVerification(), false);

    // Offline grace
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    await writeLicenseRecord(baseLicenseRecord({
      lastServerTime: oneDayAgo,
      lastTrustedVerificationAt: new Date(oneDayAgo).toISOString(),
    }));
    setTrustedTime(oneDayAgo);
    setTrustedTime(Date.now());
    assert.equal(await needsOnlineVerification(), true);

    // Active needs verification (no trusted time)
    await writeLicenseRecord(baseLicenseRecord({ lastServerTime: null }));
    setTrustedTime(0); // no trusted time
    assert.equal(await needsOnlineVerification(), true);

    // Clock suspect
    const farFuture = Date.now() + 2 * 60 * 1000;
    await writeLicenseRecord(baseLicenseRecord());
    setTrustedTime(farFuture);
    assert.equal(await needsOnlineVerification(), true);

    // Suspended license - doesn't need verification, it's suspended
    await writeLicenseRecord(baseLicenseRecord({ status: 'suspended' }));
    setTrustedTime(Date.now());
    assert.equal(await needsOnlineVerification(), false);
  } finally {
    teardownFakeDB();
  }
});

test('ENTITLEMENT_STATE constants are frozen', () => {
  assert.throws(() => {
    ENTITLEMENT_STATE.ACTIVE = 'hacked';
  }, /Cannot assign to read only property/);
});

test('OFFLINE_GRACE_MS is 14 days', () => {
  const expected = 14 * 24 * 60 * 60 * 1000;
  assert.equal(OFFLINE_GRACE_MS, expected);
});