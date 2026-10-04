/**
 * Admin authorisation: the single answer to "may this caller operate licences?".
 *
 * Two things this module exists to keep apart, because collapsing them is the
 * mistake that turns an admin portal into a customer feature:
 *
 *   authentication — this is a real Google account with a live session
 *                   (owned by ./auth-service.js), and
 *   authorisation  — this particular account has been granted admin rights.
 *
 * Being signed in is not being an administrator. A customer who has activated
 * Store Hub is authenticated and must still be refused here, or the licence
 * database is one button away from every shop that ever paid for the app.
 *
 * Two further properties this file is built to guarantee:
 *
 * - The decision is made on the Google `sub`, never on an email address. `sub`
 *   is immutable for the life of the account; an email can be renamed, sold, or
 *   reassigned on Workspace.
 *
 * - The decision lives on the server. The portal hides its buttons as a courtesy
 *   to the operator, but the request that matters is refused here regardless of
 *   what the browser sent. Knowing the URL is not authorisation.
 *
 * No secret is compared and no password is accepted: the grant *is* the
 * configured list of `sub` values, so there is nothing here to leak, forge, or
 * reset into the repository.
 */

import { ERROR_CODES, LicenseError } from './errors.js';

/**
 * The decision itself, as a pure function.
 *
 * Pure and exported separately from the request plumbing so the rule can be
 * tested exhaustively without a socket, a cookie, or a database — the property
 * that actually matters about a security check is that it is small enough to
 * read in one sitting.
 *
 * @param {{googleSub?: string|null}} account resolved auth account, or null
 * @param {{authorizedSubs?: string[]}} config
 * @returns {boolean}
 */
export function isAuthorizedAdmin(account, config) {
  // No configured administrator means no administrator. An empty allowlist must
  // deny, never fall through to "well, they're signed in at least".
  const authorized = config?.authorizedSubs;
  if (!Array.isArray(authorized) || authorized.length === 0) return false;
  const sub = account?.googleSub;
  if (typeof sub !== 'string' || sub.length === 0) return false;
  return authorized.includes(sub);
}

/**
 * Builds the guard used by the HTTP layer on every admin route.
 *
 * `extractSessionToken` is injected rather than imported so this module stays a
 * leaf: the cookie parsing belongs to the transport layer, and importing it back
 * would make http.js and this file depend on each other.
 *
 * @param {{
 *   authService: {getMe: (token: string) => ({account: object}|null)},
 *   config: {admin: {authorizedSubs: string[]}},
 *   extractSessionToken: (req: import('node:http').IncomingMessage) => string|null,
 *   log?: (message: string, detail?: unknown) => void,
 * }} deps
 */
export function createAdminAuthorizer({ authService, config, extractSessionToken, log = () => {} }) {
  /**
   * Resolves an admin account from a raw session token, or null.
   *
   * @param {string|null|undefined} sessionToken
   * @returns {{googleSub: string, email: string|null}|null}
   */
  function resolveAdmin(sessionToken) {
    if (!sessionToken || typeof authService?.getMe !== 'function') return null;
    const me = authService.getMe(sessionToken);
    if (!me) return null;
    if (!isAuthorizedAdmin(me.account, config.admin)) return null;
    return { googleSub: me.account.googleSub, email: me.account.email ?? null };
  }

  /**
   * The request guard. Throws rather than returning a boolean so a caller cannot
   * forget to branch on it and proceed anyway — the failure mode of a boolean
   * check is a route that reads `if (!ok) return;` on the wrong line.
   *
   * 401 means "I do not know who you are"; 403 means "I know, and the answer is
   * no". Splitting them keeps the portal from sending a perfectly valid customer
   * through a pointless sign-in loop it can never satisfy.
   *
   * @param {import('node:http').IncomingMessage} req
   * @returns {{googleSub: string, email: string|null}}
   * @throws {LicenseError} INVALID_SESSION (401) or ADMIN_REQUIRED (403)
   */
  function requireAdmin(req) {
    const sessionToken = extractSessionToken(req);
    if (!sessionToken) {
      throw new LicenseError(ERROR_CODES.INVALID_SESSION, {
        detail: 'admin route requires an authenticated session',
      });
    }

    // No identity provider wired means nobody can be identified, so nobody is
    // authorised. The guard fails closed rather than throwing a TypeError that
    // would surface as a 500 and read like a server fault.
    if (typeof authService?.getMe !== 'function') {
      throw new LicenseError(ERROR_CODES.ADMIN_REQUIRED, {
        detail: 'no identity provider is wired',
      });
    }

    const me = authService.getMe(sessionToken);
    if (!me) {
      throw new LicenseError(ERROR_CODES.INVALID_SESSION, {
        detail: 'admin route received an unknown or expired session',
      });
    }

    if (!isAuthorizedAdmin(me.account, config.admin)) {
      // Logged, never answered: the operator wants to know an authenticated
      // non-admin tried, but the caller is told nothing beyond the refusal.
      log('admin request refused', { googleSub: me.account.googleSub });
      throw new LicenseError(ERROR_CODES.ADMIN_REQUIRED, {
        detail: 'account is not listed in STOREHUB_ADMIN_SUB',
      });
    }

    return { googleSub: me.account.googleSub, email: me.account.email ?? null };
  }

  return { requireAdmin, resolveAdmin };
}

/**
 * One line for the boot log, so "why can I not sign in?" is answerable without
 * reading source. Never includes the subs themselves.
 *
 * @param {{authorizedSubs: string[], portalUrl: string}} admin config.admin
 * @returns {string}
 */
export function describeAdminConfiguration(admin) {
  const count = admin.authorizedSubs.length;
  if (count === 0) {
    return 'admin portal disabled — STOREHUB_ADMIN_SUB is not set, so every admin request is refused';
  }
  const plural = count === 1 ? 'account' : 'accounts';
  return (
    `admin portal enabled for ${count} authorised ${plural}` +
    (admin.portalUrl ? `, callback returns to ${admin.portalUrl}` : '')
  );
}
