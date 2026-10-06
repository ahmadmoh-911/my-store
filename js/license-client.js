/**
 * Client-side licence integration.
 *
 * This module is the seam between the web app and the licence backend. It does
 * not enforce anything, show any UI, or run automatically. It provides a set
 * of functions that a future UI phase will call, and that the existing test
 * suite can exercise against a real backend.
 *
 * Responsibilities:
 *   - Build requests from install identity (installId, platform, appVersion).
 *   - Call the licence API (activate / verify / bind).
 *   - Apply responses to identity-store (licence metadata + server time).
 *   - Feed server timestamps into clock.js so the client has a trusted clock.
 *
 * Non-responsibilities (enforced by having no auto-run):
 *   - No activation screen, no licence modal, no settings UI.
 *   - No offline grace enforcement — that is a later phase.
 *   - No periodic verification — the caller decides when to call.
 *
 * The module is deliberately dependency-injected: the fetch implementation and
 * the base URL are passed at call time, so tests can stub the network and the
 * app can configure the backend origin without a rebuild.
 */

import { getInstallId } from './identity-store.js';
import { platformInfo } from './platform.js';
import { setTrustedServerTime } from './clock.js';
import { resolveClientBase, getDefaultBase } from './api-config.js';

/** @typedef {{baseUrl?: string, fetchImpl?: typeof fetch}} LicenseClientOptions */

/**
 * Builds the metadata every licence request carries.
 *
 * @param {LicenseClientOptions} [options]
 * @returns {Promise<{installId: string, platform: string, appVersion: string}>}
 */
export async function buildLicenseMetadata(options = {}) {
  const [installId, info] = await Promise.all([getInstallId(), platformInfo()]);
  return {
    installId,
    platform: info.platform,
    appVersion: info.appVersion,
  };
}

/**
 * Performs a POST to the licence backend.
 *
 * @param {string} endpoint   e.g. 'activate', 'verify', 'bind'
 * @param {object} body
 * @param {LicenseClientOptions} [options]
 * @returns {Promise<{ok: boolean, license?: object, serverTime: number, error?: {code: string, message: string}, [key: string]: any}>}
 */
async function postLicense(endpoint, body, options = {}) {
  // Resolve base: absolute origin if configured, else relative path
  const base = options.baseUrl || resolveClientBase('license');
  const url = `${base.replace(/\/+$/, '')}/${endpoint}`;
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);
  if (!fetchImpl) throw new Error('No fetch implementation available');

  const metadata = await buildLicenseMetadata(options);
  const payload = { ...metadata, ...body };

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    credentials: 'omit', // licence metadata is not a session; no cookies
  });

  if (!res.ok) {
    let errorBody = null;
    try {
      errorBody = await res.json();
    } catch {
      errorBody = { ok: false, error: { code: 'HTTP_ERROR', message: res.statusText }, serverTime: Date.now() };
    }
    // Even on error, if the server sent serverTime, feed it to the clock.
    if (errorBody && typeof errorBody.serverTime === 'number') {
      setTrustedServerTime(errorBody.serverTime);
    }
    return errorBody;
  }

  const data = await res.json();

  // Successful response: serverTime is mandatory and server-generated.
  if (typeof data.serverTime === 'number') {
    setTrustedServerTime(data.serverTime);
  }

  return data;
}

/**
 * Activates a licence code for this install.
 *
 * Returns the entitlement and a session token. The session token is stored
 * in identity-store so future verify calls don't need the code again.
 *
 * @param {string} licenseCode
 * @param {LicenseClientOptions} [options]
 * @returns {Promise<{ok: boolean, license?: object, sessionToken?: string, linkedAccountId?: string|null, serverTime?: number, error?: {code: string, message: string}}>}
 */
export async function activateLicense(licenseCode, options = {}) {
  const result = await postLicense('activate', { licenseCode }, options);

  if (result.ok && result.license && result.sessionToken) {
    // Cache entitlement + session + account linkage + server time + trusted verification timestamp.
    const nowIso = new Date().toISOString();
    await import('./identity-store.js').then((mod) => {
      return mod.saveLicenseRecord({
        licenseId: result.license.id,
        status: result.license.status,
        expiresAt: result.license.expiresAt,
        lastVerifiedAt: nowIso,
        lastServerTime: result.serverTime,
        lastTrustedVerificationAt: nowIso,
        linkedAccountId: result.linkedAccountId ?? null,
      });
    });
  }

  return result;
}

/**
 * Verifies the current entitlement using the stored session token.
 *
 * Reads the session token from identity-store, calls /verify, and updates
 * the cached entitlement + server time + lastTrustedVerificationAt.
 *
 * @param {LicenseClientOptions} [options]
 * @returns {Promise<{ok: boolean, license?: object, serverTime?: number, error?: {code: string, message: string}}>}
 */
export async function verifyLicense(options = {}) {
  const { getLicenseRecord } = await import('./identity-store.js');
  const cached = await getLicenseRecord();
  const sessionToken = cached?.sessionToken ?? null;

  if (!sessionToken) {
    return { ok: false, error: { code: 'NO_SESSION', message: 'No session token stored; call activateLicense first.' }, serverTime: null };
  }

  const result = await postLicense('verify', { sessionToken }, options);

  if (result.ok && result.license) {
    // Store the device wall-clock time of this successful verification.
    // This is used by the entitlement engine to compute offline grace.
    const nowIso = new Date().toISOString();
    await import('./identity-store.js').then((mod) => {
      return mod.saveLicenseRecord({
        licenseId: result.license.id,
        status: result.license.status,
        expiresAt: result.license.expiresAt,
        lastVerifiedAt: nowIso,
        lastServerTime: result.serverTime,
        lastTrustedVerificationAt: nowIso,
        linkedAccountId: cached.linkedAccountId ?? null,
      });
    });
  }

  return result;
}

/**
 * Binds the licence to an account id.
 *
 * This is a placeholder for the identity phase — the account id is whatever
 * the caller asserts. Real authentication (Google sign-in) will supply the
 * subject id in a later phase.
 *
 * @param {string} accountId
 * @param {LicenseClientOptions} [options]
 * @returns {Promise<{ok: boolean, license?: object, linkedAccountId?: string|null, serverTime?: number, error?: {code: string, message: string}}>}
 */
export async function bindLicense(accountId, options = {}) {
  const { getLicenseRecord } = await import('./identity-store.js');
  const cached = await getLicenseRecord();
  const sessionToken = cached?.sessionToken ?? null;

  // The backend accepts either a session token or a bare code. Prefer session.
  const payload = sessionToken ? { sessionToken, accountId } : { accountId };
  const result = await postLicense('bind', payload, options);

  if (result.ok && result.license && result.linkedAccountId) {
    // Store the trusted verification timestamp when binding succeeds.
    const nowIso = new Date().toISOString();
    await import('./identity-store.js').then((mod) => {
      return mod.saveLicenseRecord({
        licenseId: result.license.id,
        status: result.license.status,
        expiresAt: result.license.expiresAt,
        lastVerifiedAt: nowIso,
        lastServerTime: result.serverTime,
        lastTrustedVerificationAt: nowIso,
        linkedAccountId: result.linkedAccountId,
      });
    });
  }

  return result;
}

/**
 * Returns the locally cached licence metadata, if any.
 *
 * This is synchronous-ish (IndexedDB is async) and does no network I/O.
 * The UI can use this to show "last known status" instantly on launch.
 *
 * @returns {Promise<{licenseId?: string, status?: string, expiresAt?: number|null, lastVerifiedAt?: string, lastServerTime?: number|null, linkedAccountId?: string|null}>}
 */
export async function getCachedLicense() {
  const { getLicenseRecord } = await import('./identity-store.js');
  return getLicenseRecord();
}

/**
 * Clears the local licence cache (session token, entitlement, account link).
 * Does NOT touch the install id or platform info.
 *
 * @returns {Promise<void>}
 */
export async function clearCachedLicense() {
  const { clearLicenseRecord } = await import('./identity-store.js');
  return clearLicenseRecord();
}

/**
 * Returns true if a session token exists locally.
 *
 * This is a local check only — it does not prove the licence is valid.
 *
 * @returns {Promise<boolean>}
 */
export async function hasLocalSession() {
  const { getLicenseRecord } = await import('./identity-store.js');
  const cached = await getLicenseRecord();
  return typeof cached?.sessionToken === 'string' && cached.sessionToken.length > 0;
}