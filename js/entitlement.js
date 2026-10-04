/**
 * Store Hub — Client-side Entitlement Engine.
 *
 * This module is the single source of truth for "may this device sell right now?".
 * It does NOT do UI. It does NOT enforce anything by itself. It exposes a pure
 * decision function that the checkout flow and the startup sequence both call.
 *
 * The decision is based on:
 *   - Local cached licence record (from identity-store)
 *   - Local cached auth session (googleSub, email, etc.)
 *   - The clock abstraction (trusted server time + monotonic anchor)
 *   - The 14-day offline grace period rule
 *
 * The server is the source of truth when online. The client only estimates
 * when offline, and fails safe (blocks sales) when the grace expires.
 *
 * Do not scatter licence checks across the application. Call `getEntitlement()`
 * and act on its `state` field.
 */

import { getLicenseRecord, getAuthSession, hasValidAuthSession } from './identity-store.js';
import {
  estimatedServerTime,
  hasTrustedTime,
  isClockSuspect,
  NO_TRUSTED_TIME,
} from './clock.js';

/**
 * The 14-day offline grace period in milliseconds.
 * This is a product rule, not a technical constant.
 */
export const OFFLINE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Entitlement states — the vocabulary the rest of the app uses.
 * Do not add more states without a product reason.
 */
export const ENTITLEMENT_STATE = Object.freeze({
  /** No licence has been activated on this device. */
  UNACTIVATED: 'unactivated',
  /** No Google account is signed in (or session expired). */
  UNAUTHENTICATED: 'unauthenticated',
  /** Licence is active and verified — selling is allowed. */
  ACTIVE: 'active',
  /** Licence is active but needs online verification soon. */
  ACTIVE_NEEDS_VERIFICATION: 'active_needs_verification',
  /** Offline grace period active — selling allowed but verification required. */
  OFFLINE_GRACE: 'offline_grace',
  /** Offline grace expired — selling blocked, verification required. */
  OFFLINE_GRACE_EXPIRED: 'offline_grace_expired',
  /** Licence suspended by admin — selling blocked. */
  SUSPENDED: 'suspended',
  /** Licence expired — selling blocked. */
  EXPIRED: 'expired',
  /** Licence revoked — selling blocked. */
  REVOKED: 'revoked',
  /** Clock manipulation detected — selling blocked, verification required. */
  CLOCK_SUSPECT: 'clock_suspect',
  /** Licence bound to a different Google account. */
  ACCOUNT_MISMATCH: 'account_mismatch',
});

/** States where NEW SALES are allowed. Everything else blocks checkout. */
const SELL_ALLOWED_STATES = new Set([
  ENTITLEMENT_STATE.ACTIVE,
  ENTITLEMENT_STATE.ACTIVE_NEEDS_VERIFICATION,
  ENTITLEMENT_STATE.OFFLINE_GRACE,
]);

/**
 * Computes the current entitlement from local state.
 *
 * This is a PURE function — no network I/O, no side effects.
 * The caller decides when to call it (startup, before sale, periodic, etc.).
 *
 * @returns {Promise<{
 *   state: string,                    // One of ENTITLEMENT_STATE
 *   canSell: boolean,                 // True iff new sales are allowed
 *   license: object|null,             // Cached licence record (id, status, expiresAt, ...)
 *   auth: object|null,                // Cached auth session (googleSub, email, ...)
 *   lastVerifiedAt: string|null,      // Device wall-clock of last successful verify
 *   lastServerTime: number|null,      // Server timestamp from last verify
 *   estimatedServerTime: number|null, // Current best estimate of server time
 *   offlineSinceMs: number|null,      // How long we've been offline (ms), null if online
 *   graceRemainingMs: number|null,    // Grace period remaining (ms), null if not in grace
 *   clockSuspect: boolean,            // True if device clock differs significantly
 *   licenseBoundTo: string|null,      // googleSub the licence is bound to
 *   authGoogleSub: string|null,       // Currently signed-in googleSub
 * }>}
 */
export async function getEntitlement() {
  // Load local cached state
  const [license, auth] = await Promise.all([
    getLicenseRecord(),
    getAuthSession(),
  ]);

  const licenseBoundTo = license?.linkedAccountId ?? null;
  const authGoogleSub = auth?.googleSub ?? null;

  // 1. No licence activated at all
  if (!license || !license.licenseId) {
    return {
      state: ENTITLEMENT_STATE.UNACTIVATED,
      canSell: false,
      license: null,
      auth,
      lastVerifiedAt: null,
      lastServerTime: null,
      estimatedServerTime: null,
      offlineSinceMs: null,
      graceRemainingMs: null,
      clockSuspect: false,
      licenseBoundTo: null,
      authGoogleSub: null,
    };
  }

  // 2. No authenticated Google account (or session expired)
  if (!auth || !auth.googleSub) {
    return {
      state: ENTITLEMENT_STATE.UNAUTHENTICATED,
      canSell: false,
      license,
      auth,
      lastVerifiedAt: license.lastVerifiedAt ?? null,
      lastServerTime: license.lastServerTime ?? null,
      estimatedServerTime: estimatedServerTime(),
      offlineSinceMs: null,
      graceRemainingMs: null,
      clockSuspect: false,
      licenseBoundTo,
      authGoogleSub: null,
    };
  }

  // 3. Licence bound to a different Google account
  if (licenseBoundTo && authGoogleSub && licenseBoundTo !== authGoogleSub) {
    return {
      state: ENTITLEMENT_STATE.ACCOUNT_MISMATCH,
      canSell: false,
      license,
      auth,
      lastVerifiedAt: license.lastVerifiedAt ?? null,
      lastServerTime: license.lastServerTime ?? null,
      estimatedServerTime: estimatedServerTime(),
      offlineSinceMs: null,
      graceRemainingMs: null,
      clockSuspect: false,
      licenseBoundTo,
      authGoogleSub,
    };
  }

  // 4. Check clock integrity
  const clockSuspect = isClockSuspect(60000); // 60 second tolerance

  // 5. Compute effective licence status from cached data
  const estServerTime = estimatedServerTime();
  const licenseStatus = computeLicenseStatus(license, estServerTime);

  // If clock is suspect, fail safe
  if (clockSuspect) {
    return {
      state: ENTITLEMENT_STATE.CLOCK_SUSPECT,
      canSell: false,
      license,
      auth,
      lastVerifiedAt: license.lastVerifiedAt ?? null,
      lastServerTime: license.lastServerTime ?? null,
      estimatedServerTime: estServerTime,
      offlineSinceMs: null,
      graceRemainingMs: null,
      clockSuspect: true,
      licenseBoundTo,
      authGoogleSub,
    };
  }

  // 6. Handle non-active licence statuses (suspended, expired, revoked)
  if (licenseStatus === 'suspended') {
    return buildResult(ENTITLEMENT_STATE.SUSPENDED, license, auth, estServerTime, licenseBoundTo, authGoogleSub);
  }
  if (licenseStatus === 'expired') {
    return buildResult(ENTITLEMENT_STATE.EXPIRED, license, auth, estServerTime, licenseBoundTo, authGoogleSub);
  }
  if (licenseStatus === 'revoked') {
    return buildResult(ENTITLEMENT_STATE.REVOKED, license, auth, estServerTime, licenseBoundTo, authGoogleSub);
  }

  // 7. Licence is ACTIVE — now check online/offline/grace
  const lastServerTime = license.lastServerTime;
  const lastVerifiedAt = license.lastVerifiedAt ? new Date(license.lastVerifiedAt).getTime() : null;
  const hasTrustedServerTime = hasTrustedTime() && estServerTime !== NO_TRUSTED_TIME;

  if (!hasTrustedServerTime || lastServerTime === null || lastVerifiedAt === null) {
    // We have an active licence but no trusted server time — treat as needing verification
    return buildResult(ENTITLEMENT_STATE.ACTIVE_NEEDS_VERIFICATION, license, auth, estServerTime, licenseBoundTo, authGoogleSub);
  }

  // We have a trusted server timestamp from the last successful verification
  const nowEst = estServerTime;
  const offlineSinceMs = nowEst - lastServerTime; // How long since server said "ok"

  // Allow a small tolerance (1 second) for clock drift between writing the record
  // and setting the trusted time. If the offline time is <= 1 second, treat as
  // online/active.
  const ONLINE_TOLERANCE_MS = 1000;

  if (offlineSinceMs <= ONLINE_TOLERANCE_MS) {
    // Clock says we're at or before the last server time (within tolerance) —
    // treat as online/active
    return buildResult(ENTITLEMENT_STATE.ACTIVE, license, auth, estServerTime, licenseBoundTo, authGoogleSub, {
      offlineSinceMs: Math.max(0, offlineSinceMs),
      graceRemainingMs: null,
    });
  }

  if (offlineSinceMs < OFFLINE_GRACE_MS) {
    // Within 14-day grace period
    return buildResult(ENTITLEMENT_STATE.OFFLINE_GRACE, license, auth, estServerTime, licenseBoundTo, authGoogleSub, {
      offlineSinceMs,
      graceRemainingMs: OFFLINE_GRACE_MS - offlineSinceMs,
    });
  }

  // Grace period expired
  return buildResult(ENTITLEMENT_STATE.OFFLINE_GRACE_EXPIRED, license, auth, estServerTime, licenseBoundTo, authGoogleSub, {
    offlineSinceMs,
    graceRemainingMs: 0,
  });
}

/**
 * Computes the effective licence status from the cached record and estimated server time.
 * Mirrors the server's `effectiveStatus` logic.
 *
 * @param {object} license
 * @param {number|null} estServerTime
 * @returns {'active'|'suspended'|'expired'|'revoked'}
 */
function computeLicenseStatus(license, estServerTime) {
  const status = license.status;
  const expiresAt = license.expiresAt;

  if (status === 'suspended') return 'suspended';
  if (status === 'revoked') return 'revoked';
  if (typeof expiresAt === 'number' && estServerTime !== null && expiresAt <= estServerTime) {
    return 'expired';
  }
  return 'active';
}

/**
 * Builds the standard result object.
 */
function buildResult(state, license, auth, estServerTime, licenseBoundTo, authGoogleSub, extra = {}) {
  const canSell = SELL_ALLOWED_STATES.has(state);
  return {
    state,
    canSell,
    license,
    auth,
    lastVerifiedAt: license.lastVerifiedAt ?? null,
    lastServerTime: license.lastServerTime ?? null,
    estimatedServerTime: estServerTime,
    offlineSinceMs: extra.offlineSinceMs ?? null,
    graceRemainingMs: extra.graceRemainingMs ?? null,
    clockSuspect: false,
    licenseBoundTo,
    authGoogleSub,
  };
}

/**
 * Returns true if the current entitlement allows new sales.
 * Convenience wrapper for the checkout flow.
 */
export async function canSell() {
  const entitlement = await getEntitlement();
  return entitlement.canSell;
}

/**
 * Returns a human-readable message for the current entitlement state.
 * For UI display — not for logic decisions.
 */
export async function getEntitlementMessage() {
  const e = await getEntitlement();

  switch (e.state) {
    case ENTITLEMENT_STATE.UNACTIVATED:
      return 'لم يتم تفعيل ترخيص بعد. يرجى إدخال رمز الترخيص.';
    case ENTITLEMENT_STATE.UNAUTHENTICATED:
      return 'يجب تسجيل الدخول بحساب Google للوصول للمتجر.';
    case ENTITLEMENT_STATE.ACCOUNT_MISMATCH:
      return 'هذا الترخيص مربوط بحساب Google آخر. يرجى تسجيل الدخول بالحساب الصحيح.';
    case ENTITLEMENT_STATE.SUSPENDED:
      return 'الترخيص معلق. لا يمكن إجراء مبيعات جديدة. البيانات محفوظة.';
    case ENTITLEMENT_STATE.EXPIRED:
      return 'انتهت صلاحية الترخيص. يرجى تجديده. البيانات محفوظة.';
    case ENTITLEMENT_STATE.REVOKED:
      return 'تم إلغاء الترخيص. لا يمكن إجراء مبيعات جديدة. البيانات محفوظة.';
    case ENTITLEMENT_STATE.CLOCK_SUSPECT:
      return 'تم اكتشاف تغيير في ساعة الجهاز. يرجى الاتصال بالإنترنت للتحقق من الترخيص.';
    case ENTITLEMENT_STATE.ACTIVE_NEEDS_VERIFICATION:
      return 'الترخيص نشط لكن يحتاج تحقق من الخادم. يرجى الاتصال بالإنترنت.';
    case ENTITLEMENT_STATE.OFFLINE_GRACE:
      const days = Math.ceil((e.graceRemainingMs || 0) / (24 * 60 * 60 * 1000));
      return `الترخيص نشط (وضع عدم اتصال). باقي ${days} يوم للتحقق من الخادم.`;
    case ENTITLEMENT_STATE.OFFLINE_GRACE_EXPIRED:
      return 'انتهت فترة السماح دون اتصال. يجب الاتصال بالإنترنت للتحقق من الترخيص.';
    case ENTITLEMENT_STATE.ACTIVE:
    default:
      return 'الترخيص نشط ومتحقق.';
  }
}

/**
 * Checks if an online verification is needed (state requires it).
 */
export async function needsOnlineVerification() {
  const e = await getEntitlement();
  return [
    ENTITLEMENT_STATE.ACTIVE_NEEDS_VERIFICATION,
    ENTITLEMENT_STATE.OFFLINE_GRACE,
    ENTITLEMENT_STATE.OFFLINE_GRACE_EXPIRED,
    ENTITLEMENT_STATE.CLOCK_SUSPECT,
  ].includes(e.state);
}

/**
 * Performs an online licence verification and updates local cache.
 * Returns the new entitlement after verification.
 *
 * @param {object} [options] - Passed to verifyLicense (fetchImpl, baseUrl, etc.)
 * @returns {Promise<{entitlement: object, verificationResult: object}>}
 */
export async function verifyAndUpdate(options = {}) {
  // Dynamic import to avoid circular dependency
  const { verifyLicense } = await import('./license-client.js');
  const result = await verifyLicense(options);

  // Recompute entitlement after verification
  const entitlement = await getEntitlement();
  return { entitlement, verificationResult: result };
}

/**
 * Attempts to activate a licence with Google authentication.
 * This is the full activation flow: code → Google auth → bind → verify.
 *
 * @param {string} licenseCode
 * @param {object} [options] - Passed to activateLicense and bindLicense
 * @returns {Promise<{entitlement: object, activationResult: object, bindResult: object}>}
 */
export async function activateWithGoogle(licenseCode, options = {}) {
  const { activateLicense, bindLicense } = await import('./license-client.js');
  const { startGoogleAuth, handleAuthCallback } = await import('./auth-client.js');

  // 1. Activate licence code (creates session, returns entitlement)
  const activationResult = await activateLicense(licenseCode, options);
  if (!activationResult.ok) {
    return { activationResult, bindResult: null, entitlement: null };
  }

  // 2. Start Google auth if not already authenticated
  const { isAuthenticatedLocally } = await import('./auth-client.js');
  if (!(await isAuthenticatedLocally())) {
    const { authUrl, state } = await startGoogleAuth(options);
    // The caller must redirect to authUrl and handle the callback
    // This is a partial result — the caller completes the flow
    return {
      activationResult,
      authRequired: true,
      authUrl,
      state,
      bindResult: null,
      entitlement: null,
    };
  }

  // 3. Get current Google account
  const { getCurrentAccount } = await import('./auth-client.js');
  const account = await getCurrentAccount(options);
  if (!account) {
    return {
      activationResult,
      bindResult: null,
      entitlement: null,
      error: 'No authenticated Google account after activation',
    };
  }

  // 4. Bind licence to googleSub
  const bindResult = await bindLicense(account.googleSub, options);
  if (!bindResult.ok) {
    return { activationResult, bindResult, entitlement: null };
  }

  // 5. Verify and get final entitlement
  const { verifyAndUpdate } = await import('./entitlement.js');
  const { entitlement } = await verifyAndUpdate(options);

  return { activationResult, bindResult, entitlement };
}

export default {
  getEntitlement,
  canSell,
  getEntitlementMessage,
  needsOnlineVerification,
  verifyAndUpdate,
  activateWithGoogle,
  ENTITLEMENT_STATE,
  OFFLINE_GRACE_MS,
};