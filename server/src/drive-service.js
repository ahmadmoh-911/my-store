/**
 * Google Drive authorisation: the backend's half of the backup grant.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Why the backend brokers the grant at all
 * ─────────────────────────────────────────────────────────────────────────
 * A refresh token is the only thing that makes a weekly backup possible without
 * asking the owner to press "connect Google Drive" every seven days. Something
 * has to hold it, and the alternatives are all worse:
 *
 *   - the device cannot hold it: a refresh token in IndexedDB is a permanent,
 *     readable copy of the customer's Drive access on a lost phone;
 *   - the browser cannot mint it alone: the authorization-code exchange needs the
 *     OAuth client *secret*, and §7 forbids putting that in frontend code;
 *   - so the backend holds it — which is authorisation infrastructure, and
 *     exactly what the phase brief permits the backend to do.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * What this service is NOT on the data path
 * ─────────────────────────────────────────────────────────────────────────
 * It hands the browser a short-lived, `drive.file`-scoped access token and then
 * gets out of the way. The backup JSON is uploaded from the device straight to
 * `googleapis.com`. No product, sale, inventory line, report, invoice or backup
 * byte passes through this process, and this file contains no code that could
 * accept one.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * The trust trade-off, stated plainly
 * ─────────────────────────────────────────────────────────────────────────
 * Because the backend can decrypt the refresh token, an operator who controls
 * this process could use it to reach the customer's Drive. It does not do so, and
 * cannot be made to by any API here — but the capability exists, and pretending
 * otherwise would be dishonest. What is true and enforced:
 *
 *   - the token is sealed with AES-256-GCM under a key derived from
 *     STOREHUB_PEPPER, which lives in the environment and never in this file;
 *   - a dump of `storehub_drive.db` yields no usable credential;
 *   - `drive.file` limits what the token can reach to files the app created;
 *   - revoking at Google immediately kills it here.
 *
 * `tests/drive.test.mjs` asserts each of those, and `DRIVE_BACKUP.md` documents
 * the trade-off rather than hiding it.
 */

import { ERROR_CODES, LicenseError } from './errors.js';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * The scope this phase asks for. Narrow on purpose: `drive.file` grants access
 * only to files the app created, which is precisely what a backup destination
 * needs and nothing more. A broad `drive` grant would let Store Hub read every
 * document the shop owner has ever stored in their account.
 *
 * Declared here, in the module that owns the Drive concern, so the OAuth flow
 * and the grant store cannot drift onto different scopes.
 */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/**
 * Refresh a Google refresh token for a short-lived access token.
 *
 * @param {{refreshToken: string, clientId: string, clientSecret: string}} params
 * @param {{fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<{access_token: string, expires_in: number, scope?: string, error?: string}>}
 */
async function refreshAccessToken({ refreshToken, clientId, clientSecret }, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new LicenseError(ERROR_CODES.INTERNAL_ERROR, {
      status: 502,
      detail: 'Google token refresh returned a non-JSON response',
    });
  }

  if (!res.ok) {
    throw new LicenseError(ERROR_CODES.DRIVE_NOT_CONNECTED, {
      status: 502,
      detail: `Google refused the refresh token: ${res.status} ${body.error_description || body.error || ''}`,
    });
  }
  return body;
}

/**
 * Builds the Drive authorisation service.
 *
 * @param {{
 *   driveRepository: import('./drive-repository.js').DriveRepository,
 *   config: {google: {clientId: string|null, clientSecret: string|null}},
 *   clock: () => number,
 *   log?: (message: string, detail?: unknown) => void,
 *   fetchImpl?: typeof fetch,
 * }} deps
 */
export function createDriveService({ driveRepository, config, clock, log = () => {}, fetchImpl }) {
  const now = clock;

  /**
   * In-memory access token cache.
   *
   * Deliberately in memory. An access token on disk is a second credential to
   * protect, and this process already holds the long-lived one in its own
   * database; writing the short-lived one somewhere too would only widen the
   * window in which a leak is useful.
   *
   * @type {Map<string, {accessToken: string, expiresAt: number, scope: string}>}
   */
  const tokenCache = new Map();

  /** Refresh a few minutes early so a token cannot expire mid-upload. */
  const EXPIRY_MARGIN_MS = 120_000;

  /**
   * Whether Drive authorisation is even possible with this configuration.
   * @returns {boolean}
   */
  function isConfigured() {
    return Boolean(config.google?.clientId && config.google?.clientSecret);
  }

  /**
   * Records a grant handed over by the OAuth callback.
   *
   * Called by ./auth-service.js the moment Google returns a refresh token. It is
   * a plain function so the OAuth flow never has to know that a Drive store
   * exists, and so the refresh token is handed straight from the token exchange
   * to sealed storage without ever passing through an HTTP layer.
   *
   * @param {{googleSub: string, refreshToken: string, scopes?: string}} grant
   * @returns {{googleSub: string, scopes: string}|null}
   */
  function recordGrant({ googleSub, refreshToken, scopes }) {
    if (!googleSub || !refreshToken) return null;
    const granted = scopes || DRIVE_SCOPE;
    driveRepository.saveGrant(googleSub, refreshToken, granted);
    // Any access token minted under the previous grant is no longer trustworthy.
    tokenCache.delete(googleSub);
    log('drive grant recorded', { googleSub, scope: granted });
    return { googleSub, scopes: granted };
  }

  /**
   * The public connection state — safe to show in Settings, and carrying no
   * credential of any kind.
   *
   * @param {string} googleSub
   * @returns {{connected: boolean, configured: boolean, scope: string|null, grantedAt: number|null}}
   */
  function describe(googleSub) {
    const grant = googleSub ? driveRepository.getGrant(googleSub) : null;
    return {
      connected: Boolean(grant),
      configured: isConfigured(),
      scope: grant ? grant.scopes : null,
      grantedAt: grant ? grant.grantedAt : null,
    };
  }

  /**
   * Mints a short-lived access token for the caller's own Drive.
   *
   * Scoped to the one account whose session presented the request. There is no
   * parameter that could ask for a different account's token — the identity comes
   * from the session, never from the request body, which is what stops one signed
   * -in shop asking for another's Drive.
   *
   * @param {string} googleSub
   * @returns {Promise<{accessToken: string, expiresAt: number, scope: string}>}
   * @throws {LicenseError} DRIVE_NOT_CONNECTED when there is no usable grant
   */
  async function getAccessToken(googleSub) {
    if (!isConfigured()) {
      throw new LicenseError(ERROR_CODES.DRIVE_NOT_CONNECTED, {
        status: 503,
        detail: 'Google OAuth is not configured; set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET',
      });
    }

    const cached = tokenCache.get(googleSub);
    if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > now()) {
      return cached;
    }

    const grant = driveRepository.getGrant(googleSub);
    if (!grant) {
      throw new LicenseError(ERROR_CODES.DRIVE_NOT_CONNECTED, {
        detail: 'this account has not connected Google Drive',
      });
    }

    const tokens = await refreshAccessToken(
      {
        refreshToken: grant.refreshToken,
        clientId: config.google.clientId,
        clientSecret: config.google.clientSecret,
      },
      fetchImpl ? { fetchImpl } : {},
    );

    if (!tokens.access_token) {
      throw new LicenseError(ERROR_CODES.DRIVE_NOT_CONNECTED, {
        status: 502,
        detail: 'Google returned no access token',
      });
    }

    const entry = {
      accessToken: tokens.access_token,
      // A missing expires_in would otherwise mean "never expires", which would
      // leave a dead token cached until the process restarts.
      expiresAt: now() + (Number(tokens.expires_in) > 0 ? Number(tokens.expires_in) * 1000 : 3600 * 1000),
      scope: tokens.scope || grant.scopes,
    };
    tokenCache.set(googleSub, entry);
    return entry;
  }

  /**
   * Drops the grant. The customer keeps their Drive backup; Store Hub simply
   * stops being able to reach it.
   *
   * @param {string} googleSub
   * @returns {boolean}
   */
  function disconnect(googleSub) {
    tokenCache.delete(googleSub);
    return driveRepository.revokeGrant(googleSub);
  }

  return {
    scope: DRIVE_SCOPE,
    isConfigured,
    recordGrant,
    describe,
    getAccessToken,
    disconnect,
    /** Test seam — drops cached access tokens without touching stored grants. */
    forgetCachedTokens() {
      tokenCache.clear();
    },
  };
}

/**
 * @typedef {ReturnType<typeof createDriveService>} DriveService
 */