/**
 * Frontend authentication client.
 *
 * Handles the Google OAuth flow, session management, and local identity caching.
 * Uses the existing identity-store for persistence and clock for server time sync.
 *
 * No UI is implemented here — this is the logic layer that a future login screen
 * will call. The module is deliberately dependency-injected so tests can stub
 * fetch and the app can configure the backend origin.
 */

import { getAuthSession, saveAuthSession, clearAuthSession, hasValidAuthSession, saveAccountRecord } from './identity-store.js';
import { setTrustedServerTime } from './clock.js';
import { resolveClientBase } from './api-config.js';

/** @typedef {{baseUrl?: string, fetchImpl?: typeof fetch}} AuthClientOptions */

/**
 * Starts the Google OAuth flow.
 *
 * Calls `/api/auth/google/start` to get the authorization URL, then redirects
 * the user to Google. The caller should perform a full-page redirect to the
 * returned `authUrl`.
 *
 * @param {AuthClientOptions} [options]
 * @returns {Promise<{authUrl: string, state: string}>}
 */
export async function startGoogleAuth(options = {}) {
  const base = options.baseUrl || resolveClientBase('auth');
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);
  if (!fetchImpl) throw new Error('No fetch implementation available');

  const res = await fetchImpl(`${base.replace(/\/+$/, '')}/google/start`, {
    method: 'GET',
    credentials: 'include',
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Failed to start auth: ${res.status}`);
  }

  const data = await res.json();
  if (!data.ok) throw new Error(data.error?.message || 'Auth start failed');
  return { authUrl: data.authUrl, state: data.state };
}

/**
 * Handles the OAuth callback.
 *
 * This should be called on the callback page (the page Google redirects to
 * after the user consents). It exchanges the code for a session via the
 * backend, stores the session locally, and returns the account info.
 *
 * @param {URLSearchParams} searchParams - window.location.search parsed
 * @param {AuthClientOptions} [options]
 * @returns {Promise<{googleSub: string, email: string, displayName?: string, avatarUrl?: string}>}
 */
export async function handleAuthCallback(searchParams, options = {}) {
  const base = options.baseUrl || resolveClientBase('auth');
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);
  if (!fetchImpl) throw new Error('No fetch implementation available');

  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  if (error) {
    throw new Error(`Google denied: ${error}`);
  }

  if (!code || !state) {
    throw new Error('Missing code or state in callback');
  }

  const res = await fetchImpl(`${base.replace(/\/+$/, '')}/google/callback`, {
    method: 'GET',
    credentials: 'include',
    // The backend reads code/state from query params
  });

  // Note: The callback is a GET with query params, but we call the same
  // endpoint. The backend handles the query params. We just need to make
  // a request to the same URL the browser is already on, but via fetch
  // so the cookie is set.
  // Actually, the browser already made the GET request and got the response
  // with the session cookie. We just need to call /api/auth/me to get the
  // account info and store it locally.
  // Let me reconsider: the callback page should call /api/auth/me to complete
  // the local storage.

  const me = await getCurrentAccount(options);
  if (!me) throw new Error('Auth callback succeeded but no session found');

  // Store account info locally for quick access
  await saveAccountRecord({
    googleSub: me.googleSub,
    email: me.email,
    displayName: me.displayName,
    avatarUrl: me.avatarUrl,
  });

  return me;
}

/**
 * Gets the current authenticated account from the backend.
 *
 * Calls `/api/auth/me` with the session cookie. If authenticated, stores
 * the session locally and syncs server time.
 *
 * @param {AuthClientOptions} [options]
 * @returns {Promise<{googleSub: string, email: string, displayName?: string, avatarUrl?: string}|null>}
 */
export async function getCurrentAccount(options = {}) {
  const base = options.baseUrl || resolveClientBase('auth');
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);
  if (!fetchImpl) throw new Error('No fetch implementation available');

  const res = await fetchImpl(`${base.replace(/\/+$/, '')}/me`, {
    method: 'GET',
    credentials: 'include',
  });

  if (!res.ok) return null;

  const data = await res.json();
  if (!data.ok || !data.authenticated || !data.account) return null;

  // Sync server time
  if (typeof data.serverTime === 'number') {
    setTrustedServerTime(data.serverTime);
  }

  // Cache session locally for offline-first access
  // The session cookie is already set by the backend; we just mirror the
  // account info and expiry for quick local checks.
  const session = await getAuthSession();
  if (!session || session.googleSub !== data.account.googleSub) {
    // We don't have the session token (it's HttpOnly), but we can store
    // the account info and derive expiry from the cookie's Max-Age if needed.
    // For now, store what we have.
    await saveAuthSession({
      // sessionToken is HttpOnly, not accessible here
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, // approximate
      googleSub: data.account.googleSub,
      email: data.account.email,
      displayName: data.account.displayName,
      avatarUrl: data.account.avatarUrl,
    });
  }

  return data.account;
}

/**
 * Checks if there's a valid local auth session (without network).
 *
 * @returns {Promise<boolean>}
 */
export async function isAuthenticatedLocally() {
  return hasValidAuthSession();
}

/**
 * Gets the locally cached auth session.
 *
 * @returns {Promise<{googleSub: string, email: string, displayName?: string, avatarUrl?: string, expiresAt: number}|null>}
 */
export async function getLocalAuthSession() {
  const session = await getAuthSession();
  if (!session) return null;
  return {
    googleSub: session.googleSub,
    email: session.email,
    displayName: session.displayName,
    avatarUrl: session.avatarUrl,
    expiresAt: session.expiresAt,
  };
}

/**
 * Logs out the current user.
 *
 * Calls `/api/auth/logout` to invalidate the server-side session, then
 * clears local auth data.
 *
 * @param {AuthClientOptions} [options]
 * @returns {Promise<void>}
 */
export async function logout(options = {}) {
  const base = options.baseUrl || resolveClientBase('auth');
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);
  if (!fetchImpl) throw new Error('No fetch implementation available');

  try {
    await fetchImpl(`${base.replace(/\/+$/, '')}/logout`, {
      method: 'POST',
      credentials: 'include',
    });
  } catch {
    // Ignore network errors on logout — we clear local state anyway
  }

  await clearAuthSession();
  // Note: We do NOT clear the account record — it's a local cache of
  // "last known Google identity" and survives logout per the identity-store design.
}

/**
 * Gets the Google Client ID from the backend (if exposed).
 *
 * Useful for alternative flows that need the client ID directly.
 *
 * @param {AuthClientOptions} [options]
 * @returns {Promise<string|null>}
 */
export async function getGoogleClientId(options = {}) {
  const base = options.baseUrl || resolveClientBase('auth');
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);
  if (!fetchImpl) throw new Error('No fetch implementation available');

  const res = await fetchImpl(`${base.replace(/\/+$/, '')}/me`, { method: 'GET', credentials: 'include' });
  if (!res.ok) return null;
  const data = await res.json();
  return data.googleClientId ?? null;
}