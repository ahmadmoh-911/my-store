/**
 * Authentication service: Google OAuth flow, session management, and account identity.
 *
 * This module contains all the rules for authentication. The HTTP layer only
 * translates requests into calls and responses back.
 */

import { ERROR_CODES, LicenseError, errorBody } from './errors.js';
import { randomBytes, createHash } from 'node:crypto';
import { DRIVE_SCOPE } from './drive-service.js';

/** Google OAuth endpoints */
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

/**
 * Scopes we request for plain sign-in — identity only.
 *
 * Deliberately no Drive scope. A shop owner who signs in to use the till should
 * not be shown a Drive consent screen they did not ask for; Drive is opted into
 * later, on purpose, from Settings.
 */
const IDENTITY_SCOPES = ['openid', 'email', 'profile'];

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
 *   drive?: boolean,
 * }} params
 * @returns {string}
 */
function buildGoogleAuthUrl({ clientId, redirectUri, state, codeChallenge, drive }) {
  // `drive.file` is appended only when the caller asked for Drive, so an ordinary
  // sign-in asks for identity and nothing else. Google merges scopes per client,
  // so a user who connects Drive later is not re-prompted for it at every
  // subsequent sign-in.
  const scopes = drive ? [...IDENTITY_SCOPES, DRIVE_SCOPE] : IDENTITY_SCOPES;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
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
 *   driveGrantSink?: {recordGrant: (g: {googleSub: string, refreshToken: string, scopes?: string}) => any} | null,
 * }} deps
 */
export function createAuthService({ authRepository, config, clock, log = () => {}, driveGrantSink = null }) {
  const now = clock;

  // In-memory PKCE verifier store (keyed by state). In production with multiple
  // instances this would need a shared store, but for now it's fine.
  /** @type {Map<string, {verifier: string, expiresAt: number, intent: string, drive: boolean}>} */
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
   * separately auditable. The Drive-connect flow is a third intent for the same
   * reason — a consent granted for backups must be finishable only where it was
   * started.
   *
   * `drive: true` adds the `drive.file` scope to this consent. It is opt-in per
   * flow: signing in to run the till asks for identity only, and Drive is
   * requested separately when the owner actually turns backups on.
   *
   * @param {{intent?: 'customer'|'admin'|'drive', drive?: boolean}} [options]
   * @returns {{authUrl: string, state: string, intent: string}}
   */
  function startAuth(options = {}) {
    validateGoogleConfig(config);

    const intent = options.intent === 'admin' ? 'admin' : options.intent === 'drive' ? 'drive' : 'customer';
    // A Drive grant can only be requested from the Drive entry point. Letting
    // `drive: true` ride along on a plain sign-in would quietly widen consent
    // for everyone who logs in, which is the opposite of opt-in.
    const drive = intent === 'drive' && options.drive !== false;

    const { verifier, challenge } = generatePkce();
    const state = randomBytes(16).toString('base64url');
    const authUrl = buildGoogleAuthUrl({
      clientId: config.google.clientId,
      redirectUri: config.google.redirectUri,
      state,
      codeChallenge: challenge,
      drive,
    });

    // Store PKCE verifier with a short TTL (10 minutes)
    pkceStore.set(state, { verifier, expiresAt: now() + 10 * 60 * 1000, intent, drive });

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

    // Hand the Drive grant straight to its sealed store.
    //
    // `driveGrantSink` is a plain injected function rather than a Drive
    // dependency, so this module never imports the Drive service and the
    // refresh token travels from the token exchange directly into encrypted
    // storage — never through an HTTP layer, a response body, or this function's
    // return value. A user who re-consents without Drive sends no refresh token
    // for the Drive scope, which is the only case where `tokens.refresh_token` is
    // absent.
    let driveGranted = null;
    if (pkceEntry.drive && tokens.refresh_token && typeof driveGrantSink?.recordGrant === 'function') {
      driveGranted = driveGrantSink.recordGrant({
        googleSub: account.googleSub,
        refreshToken: tokens.refresh_token,
        scopes: DRIVE_SCOPE,
      });
    }

    // Create session
    const { sessionToken, sessionRecord } = authRepository.createSession(
      account.googleSub,
      config.session.ttlMs,
      userAgent,
    );

    log('oauth complete', {
      intent: pkceEntry.intent,
      googleSub: account.googleSub,
      driveGranted: Boolean(driveGranted),
    });

    return {
      sessionToken,
      intent: pkceEntry.intent,
      // Whether Drive is now connected. A boolean, never the grant itself: this
      // object is spread into HTTP responses.
      driveConnected: Boolean(driveGranted),
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