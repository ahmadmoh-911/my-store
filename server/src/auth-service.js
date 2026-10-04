/**
 * Authentication service: Google OAuth flow, session management, and account identity.
 *
 * This module contains all the rules for authentication. The HTTP layer only
 * translates requests into calls and responses back.
 */

import { ERROR_CODES, LicenseError, errorBody } from './errors.js';
import { randomBytes, createHash } from 'node:crypto';

/** Google OAuth endpoints */
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

/** Scopes we request — only what we need for identity. */
const GOOGLE_SCOPES = ['openid', 'email', 'profile'];

/** PKCE code verifier length (43-128 chars per RFC 7636) */
const PKCE_VERIFIER_LENGTH = 64;

/**
 * Generates a PKCE code verifier and challenge.
 *
 * @returns {{verifier: string, challenge: string}}
 */
function generatePkce() {
  // code_verifier: 43-128 chars, unreserved characters (A-Z, a-z, 0-9, -, ., _, ~)
  const verifier = randomBytes(PKCE_VERIFIER_LENGTH).toString('base64url');
  // code_challenge: SHA256(verifier) base64url encoded
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Builds the Google authorization URL.
 *
 * @param {{
 *   clientId: string,
 *   redirectUri: string,
 *   state: string,
 *   codeChallenge: string,
 * }} params
 * @returns {string}
 */
function buildGoogleAuthUrl({ clientId, redirectUri, state, codeChallenge }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchanges an authorization code for Google tokens.
 *
 * @param {{
 *   code: string,
 *   clientId: string,
 *   clientSecret: string,
 *   redirectUri: string,
 *   codeVerifier: string,
 * }} params
 * @returns {Promise<{access_token: string, id_token: string, refresh_token?: string, expires_in: number}>}
 */
async function exchangeCodeForTokens({ code, clientId, clientSecret, redirectUri, codeVerifier }) {
  const params = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new LicenseError(ERROR_CODES.INVALID_REQUEST, {
      status: 502,
      detail: `Google token exchange failed: ${res.status} ${text}`,
    });
  }

  return res.json();
}

/**
 * Fetches user info from Google using the access token.
 *
 * @param {string} accessToken
 * @returns {Promise<{sub: string, email: string, name?: string, picture?: string}>}
 */
async function fetchGoogleUserInfo(accessToken) {
  const res = await fetch(GOOGLE_USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new LicenseError(ERROR_CODES.INVALID_REQUEST, {
      status: 502,
      detail: `Google userinfo failed: ${res.status} ${text}`,
    });
  }

  return res.json();
}

/**
 * Validates that the Google config is complete.
 *
 * @param {ReturnType<import('./config.js').loadConfig>} config
 * @throws {LicenseError} if config is missing in production
 */
function validateGoogleConfig(config) {
  const { clientId, clientSecret, redirectUri } = config.google;
  const missing = [];
  if (!clientId) missing.push('GOOGLE_CLIENT_ID');
  if (!clientSecret) missing.push('GOOGLE_CLIENT_SECRET');
  if (!redirectUri) missing.push('GOOGLE_REDIRECT_URI');

  if (missing.length > 0) {
    const msg = `Google OAuth not configured: missing ${missing.join(', ')}`;
    if (config.env === 'production') {
      throw new LicenseError(ERROR_CODES.INTERNAL_ERROR, { detail: msg });
    }
    // In development, throw a configuration error that the endpoints can catch
    throw new LicenseError(ERROR_CODES.INVALID_REQUEST, {
      status: 503,
      detail: `${msg}. Set these environment variables to enable Google sign-in.`,
    });
  }
}

/**
 * Builds the auth service.
 *
 * @param {{
 *   authRepository: import('./auth-repository.js').AuthRepository,
 *   config: ReturnType<typeof import('./config.js').loadConfig>,
 *   clock: () => number,
 *   log?: (message: string, detail?: unknown) => void,
 * }} deps
 */
export function createAuthService({ authRepository, config, clock, log = () => {} }) {
  const now = clock;

  // In-memory PKCE verifier store (keyed by state). In production with multiple
  // instances this would need a shared store, but for now it's fine.
  /** @type {Map<string, {verifier: string, expiresAt: number, intent: string}>} */
  const pkceStore = new Map();

  /**
   * Starts the Google OAuth flow.
   *
   * Returns the authorization URL and a state parameter. The caller (frontend)
   * redirects the user to this URL. The state and PKCE verifier are stored
   * server-side temporarily to complete the flow on callback.
   *
   * `intent` is recorded alongside the verifier and comes back from
   * `completeAuth`, so a sign-in that *started* at one entry point cannot be
   * *finished* at another. The admin portal uses it to keep its flow apart from
   * the customer flow: without it, an admin callback would accept a state
   * minted by the customer route, and the two entry points would stop being
   * separately auditable.
   *
   * @param {{intent?: 'customer'|'admin'}} [options]
   * @returns {{authUrl: string, state: string, intent: string}}
   */
  function startAuth(options = {}) {
    validateGoogleConfig(config);

    const intent = options.intent === 'admin' ? 'admin' : 'customer';
    const { verifier, challenge } = generatePkce();
    const state = randomBytes(16).toString('base64url');
    const authUrl = buildGoogleAuthUrl({
      clientId: config.google.clientId,
      redirectUri: config.google.redirectUri,
      state,
      codeChallenge: challenge,
    });

    // Store PKCE verifier with a short TTL (10 minutes)
    pkceStore.set(state, { verifier, expiresAt: now() + 10 * 60 * 1000, intent });

    // Cleanup old entries periodically
    if (pkceStore.size > 1000) {
      const cutoff = now();
      for (const [k, v] of pkceStore) {
        if (v.expiresAt <= cutoff) pkceStore.delete(k);
      }
    }

    log('oauth start', { intent });
    return { authUrl, state, intent };
  }

  /**
   * Completes the OAuth flow: exchanges code for tokens, fetches user info,
   * upserts the account, creates a session, and returns the session token.
   *
   * `intent` is echoed back from the pending state so the caller that started
   * the flow can assert it is finishing the flow it owns. The session is created
   * before that assertion is made, so a caller that rejects the intent must also
   * discard the session — see the admin callback in ./http.js.
   *
   * @param {{code: string, state: string, userAgent?: string}} params
   * @returns {{sessionToken: string, account: object, intent: string, serverTime: number}}
   */
  async function completeAuth({ code, state, userAgent }) {
    validateGoogleConfig(config);

    // Retrieve and consume PKCE verifier
    const pkceEntry = pkceStore.get(state);
    if (!pkceEntry) {
      throw new LicenseError(ERROR_CODES.INVALID_REQUEST, {
        detail: 'Invalid or expired OAuth state. Please restart sign-in.',
      });
    }
    pkceStore.delete(state);

    if (pkceEntry.expiresAt <= now()) {
      throw new LicenseError(ERROR_CODES.INVALID_REQUEST, {
        detail: 'OAuth state expired. Please restart sign-in.',
      });
    }

    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens({
      code,
      clientId: config.google.clientId,
      clientSecret: config.google.clientSecret,
      redirectUri: config.google.redirectUri,
      codeVerifier: pkceEntry.verifier,
    });

    // Fetch user info from Google
    const googleUser = await fetchGoogleUserInfo(tokens.access_token);

    // Upsert account (googleSub is the stable identifier)
    const account = authRepository.upsertAccount({
      googleSub: googleUser.sub,
      email: googleUser.email,
      displayName: googleUser.name ?? null,
      avatarUrl: googleUser.picture ?? null,
    });

    // Create session
    const { sessionToken, sessionRecord } = authRepository.createSession(
      account.googleSub,
      config.session.ttlMs,
      userAgent,
    );

    log('oauth complete', { intent: pkceEntry.intent, googleSub: account.googleSub });

    return {
      sessionToken,
      intent: pkceEntry.intent,
      account: {
        googleSub: account.googleSub,
        email: account.email,
        displayName: account.displayName,
        avatarUrl: account.avatarUrl,
        createdAt: account.createdAt,
        lastLoginAt: account.lastLoginAt,
      },
      serverTime: now(),
    };
  }

  /**
   * Resolves a session token to the authenticated account.
   *
   * @param {string} sessionToken
   * @returns {{account: object, serverTime: number}|null}
   */
  function getMe(sessionToken) {
    const resolved = authRepository.resolveSession(sessionToken);
    if (!resolved) return null;

    return {
      account: {
        googleSub: resolved.account.googleSub,
        email: resolved.account.email,
        displayName: resolved.account.displayName,
        avatarUrl: resolved.account.avatarUrl,
        createdAt: resolved.account.createdAt,
        lastLoginAt: resolved.account.lastLoginAt,
      },
      serverTime: now(),
    };
  }

  /**
   * Logs out the current session.
   *
   * @param {string} sessionToken
   * @returns {boolean}
   */
  function logout(sessionToken) {
    return authRepository.deleteSession(sessionToken);
  }

  /**
   * Revokes all sessions for an account (admin/security action).
   *
   * @param {string} googleSub
   * @returns {number}
   */
  function revokeAllSessions(googleSub) {
    return authRepository.deleteAllSessionsForAccount(googleSub);
  }

  return {
    startAuth,
    completeAuth,
    getMe,
    logout,
    revokeAllSessions,
    serverNow: now,
    /**
     * Exposes the config's google settings for the frontend to know the
     * client ID (if needed for alternative flows). The secret is NEVER exposed.
     */
    getPublicConfig() {
      return {
        googleClientId: config.google.clientId,
        // Only expose redirect URI if it's a public one (not localhost for prod)
        // The frontend doesn't strictly need this but it's useful for debugging.
      };
    },
  };
}