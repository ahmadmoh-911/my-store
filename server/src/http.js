/**
 * The HTTP edge: routing, request parsing, and the single response envelope.
 *
 * Deliberately thin. This file converts bytes into a call on the licence service
 * and a result back into bytes. It holds no rules — every decision about what is
 * allowed belongs to ./service.js — because rules that live in the transport
 * layer are the ones that get bypassed the moment another entry point appears
 * (a CLI, a queue consumer, a test).
 *
 * Built on `node:http` with no framework: the whole surface is three POST
 * endpoints, and a framework would be the largest thing in the repository.
 */

import { createServer as createHttpServer } from 'node:http';

import { ERROR_CODES, LicenseError, isLicenseError, errorBody } from './errors.js';
import { pickClientFields, rejectedClientFields, effectiveStatus } from './model.js';
import { createAdminAuthorizer } from './admin-authorization.js';

/**
 * Reads the session cookie.
 *
 * Module-private on purpose. The admin guard needs it too, but importing it back
 * from here would make this file and ./admin-authorization.js depend on each
 * other; instead the guard receives it as a parameter. Cookie parsing is the
 * transport layer's job and stays here.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {string|null}
 */
function extractSessionToken(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)storehub_session=([^;]+)/);
  return match ? match[1] : null;
}

/** Sets the session cookie. */
function setSessionCookie(res, token, config) {
  const secure = config.env === 'production' ? '; Secure' : '';
  const sameSite = config.env === 'production' ? '; SameSite=None' : '; SameSite=Lax';
  const maxAge = Math.floor(config.session.ttlMs / 1000);
  res.setHeader('set-cookie', [
    `storehub_session=${token}; HttpOnly; Path=/; Max-Age=${maxAge}${secure}${sameSite}`,
  ]);
}

/** Clears the session cookie. */
function clearSessionCookie(res, config) {
  const secure = config.env === 'production' ? '; Secure' : '';
  const sameSite = config.env === 'production' ? '; SameSite=None' : '; SameSite=Lax';
  res.setHeader('set-cookie', [
    `storehub_session=; HttpOnly; Path=/; Max-Age=0${secure}${sameSite}`,
  ]);
}

/** Largest request body accepted. A licence request is a few hundred bytes. */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * Routes, and nothing else.
 *
 * A list rather than a path→route map, because two admin paths legitimately
 * answer two methods (`/api/admin/licenses` is both a listing and a creation).
 * As an object literal the second entry would silently overwrite the first and
 * the listing would 405 — a failure with no error message anywhere. A list
 * cannot express that mistake.
 *
 * `admin: true` marks a route as behind the authorisation guard. That flag is
 * the reason a new admin endpoint cannot be added unprotected by accident: the
 * guard runs before the body is even read, and a test asserts every `/api/admin`
 * route carries it.
 *
 * Patterns use `:name` for one path segment; anything else must match literally.
 */
/**
 * The page Google's redirect lands on at the end of Drive consent.
 *
 * A popup opened by Settings navigates here; the page hands the outcome back to
 * the app window and closes. Two properties this is chosen for:
 *
 *   - it needs no configured app URL, because nothing is read from the request.
 *     An earlier draft redirected to a URL taken from a query parameter, which
 *     is an open redirect with an OAuth code attached to it;
 *   - it is a fixed string. The only interpolated value is a boolean this server
 *     computed, so there is no path by which anything from Google, from the
 *     request, or from the account reaches this HTML.
 *
 * @param {boolean} connected
 * @returns {string}
 */
function driveConsentPage(connected) {
  const payload = JSON.stringify({ source: 'storehub-drive', connected: connected === true });
  return `<!doctype html>
<html lang="ar" dir="rtl">
<meta charset="utf-8">
<title>Google Drive</title>
<style>
  body { font: 16px system-ui, sans-serif; margin: 0; display: grid; place-items: center;
         min-height: 100vh; background: #f6f4f2; color: #26211c; }
  main { text-align: center; padding: 24px; max-width: 22rem; }
  h1 { font-size: 1.1rem; margin: 0 0 8px; }
  p { margin: 0; color: #6b625a; font-size: .9rem; }
</style>
<main>
  <h1>تم ربط Google Drive</h1>
  <p>يمكنك إغلاق هذه النافذة والعودة إلى الإعدادات.</p>
</main>
<script>
  try {
    if (window.opener) window.opener.postMessage(${payload}, window.location.origin);
    setTimeout(function () { window.close(); }, 400);
  } catch (e) { /* the message is best-effort; the app re-reads status anyway */ }
</script>
</html>`;
}

const ROUTES = Object.freeze([
  // ---- customer licence plane ------------------------------------------
  { method: 'POST', path: '/api/license/activate', handler: 'activate' },
  { method: 'POST', path: '/api/license/verify', handler: 'verify' },
  { method: 'POST', path: '/api/license/bind', handler: 'bind' },

  // ---- customer authentication plane ------------------------------------
  { method: 'GET', path: '/api/auth/google/start', handler: 'authStart' },
  { method: 'GET', path: '/api/auth/google/callback', handler: 'authCallback' },
  { method: 'GET', path: '/api/auth/me', handler: 'authMe' },
  { method: 'POST', path: '/api/auth/logout', handler: 'authLogout' },

  // ---- admin sign-in ----------------------------------------------------
  // Separate from the customer flow so the two entry points stay separately
  // auditable, and so the callback can refuse a non-admin *and* destroy the
  // session it just created.
  { method: 'GET', path: '/api/admin/auth/start', handler: 'adminAuthStart' },
  { method: 'GET', path: '/api/admin/auth/callback', handler: 'adminAuthCallback' },

  // ---- admin licence plane (every route guarded) -----------------------
  { method: 'GET', path: '/api/admin/me', handler: 'adminMe', admin: true },
  { method: 'GET', path: '/api/admin/licenses', handler: 'adminListLicenses', admin: true },
  { method: 'POST', path: '/api/admin/licenses', handler: 'adminCreateLicense', admin: true },
  { method: 'GET', path: '/api/admin/licenses/:id', handler: 'adminGetLicense', admin: true },
  { method: 'POST', path: '/api/admin/licenses/:id/suspend', handler: 'adminSuspendLicense', admin: true },
  { method: 'POST', path: '/api/admin/licenses/:id/reactivate', handler: 'adminReactivateLicense', admin: true },
  { method: 'POST', path: '/api/admin/licenses/:id/revoke', handler: 'adminRevokeLicense', admin: true },
  { method: 'POST', path: '/api/admin/licenses/:id/note', handler: 'adminSetLicenseNote', admin: true },
  { method: 'GET', path: '/api/admin/licenses/:id/events', handler: 'adminListLicenseEvents', admin: true },

  // ---- customer Drive backup plane --------------------------------------
  // Every route requires a live customer session (`session: true`). None of them
  // accepts a request body: the backup payload never travels through this
  // server, and a route that refuses bodies cannot be made to store one.
  { method: 'GET', path: '/api/drive/status', handler: 'driveStatus', session: true },
  { method: 'GET', path: '/api/drive/token', handler: 'driveToken', session: true },
  { method: 'GET', path: '/api/drive/connect/start', handler: 'driveConnectStart', session: true },
  { method: 'GET', path: '/api/drive/connect/callback', handler: 'driveConnectCallback', session: true },
  { method: 'POST', path: '/api/drive/disconnect', handler: 'driveDisconnect', session: true },
]);

/**
 * Compiles a `/a/:id/b` pattern into a matcher.
 *
 * Segments are matched individually rather than by pasting the pattern into a
 * RegExp, so no pattern character can be read as regex syntax and a segment
 * parameter can never swallow a slash.
 *
 * @param {string} pattern
 * @returns {{pattern: string, regex: RegExp, params: string[]}}
 */
function compileRoute(pattern) {
  const params = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        params.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { pattern, regex: new RegExp(`^${source}$`), params };
}

const COMPILED_ROUTES = Object.freeze(
  ROUTES.map((route) => ({ ...route, ...compileRoute(route.path) })),
);

/**
 * Finds the route for a request.
 *
 * Method-aware on purpose. Matching the path alone and reporting 405 afterwards
 * looks equivalent, but it is wrong the moment one path serves two methods:
 * `GET /api/admin/licenses` and `POST /api/admin/licenses` would both resolve to
 * whichever was declared first, and the other would 405 forever.
 *
 * @param {string} path
 * @param {string} method
 * @returns {{route: object, params: Record<string, string>}|null}
 */
function matchRoute(path, method) {
  for (const route of COMPILED_ROUTES) {
    if (route.method !== method) continue;
    const match = route.regex.exec(path);
    if (!match) continue;
    const params = {};
    route.params.forEach((name, index) => {
      // decodeURIComponent so an id containing an encoded character arrives as
      // the value the operator typed rather than as its percent-encoding.
      try {
        params[name] = decodeURIComponent(match[index + 1]);
      } catch {
        params[name] = match[index + 1];
      }
    });
    return { route, params };
  }
  return null;
}

/**
 * The methods a known path accepts, for a truthful 405.
 *
 * @param {string} path
 * @returns {string[]} empty when the path is not a route at all
 */
function allowedMethodsFor(path) {
  return COMPILED_ROUTES.filter((route) => route.regex.test(path)).map((route) => route.method);
}

/**
 * A fixed-window counter, in memory, keyed by IP.
 *
 * Honest about its own limits: it resets when the process restarts and it does
 * not coordinate across instances, so behind a load balancer the real limit is
 * `max × instances`. That is the right trade for this stage — the backend runs
 * as one process, and a shared counter is a Phase-6 problem with a real store
 * behind it. What matters now is that a single script cannot spin.
 */
function createRateLimiter({ windowMs, maxActivate, maxVerify }) {
  /** @type {Map<string, {count: number, resetAt: number, kind: string}>} */
  const buckets = new Map();

  return {
    /**
     * @param {string} key client identity
     * @param {'activate'|'verify'} kind
     * @param {number} now
     * @returns {{allowed: boolean, retryAfterSeconds: number}}
     */
    check(key, kind, now) {
      const max = kind === 'activate' ? maxActivate : maxVerify;
      const existing = buckets.get(key);
      if (!existing || existing.kind !== kind || existing.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + windowMs, kind });
        return { allowed: true, retryAfterSeconds: 0 };
      }
      if (existing.count >= max) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
        };
      }
      existing.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    },
    /** @returns {void} drops windows that have closed, so the map cannot grow forever. */
    sweep(now) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
    },
    get size() {
      return buckets.size;
    },
  };
}

/**
 * Reads the whole body, refusing anything oversized.
 *
 * The size check runs while the chunks arrive rather than after, so an oversized
 * request is dropped rather than buffered — otherwise the limit would be a
 * comment instead of a limit.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [maxBytes]
 * @returns {Promise<string>}
 */
function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new LicenseError(ERROR_CODES.INVALID_REQUEST, {
        status: 413,
        detail: `body exceeds ${maxBytes} bytes`,
      }));
      req.resume();
      return;
    }

    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new LicenseError(ERROR_CODES.INVALID_REQUEST, {
          status: 413,
          detail: `body exceeds ${maxBytes} bytes`,
        }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @param {string} text
 * @returns {unknown}
 */
function parseJson(text) {
  if (!text || text.trim() === '') return {};
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('body must be a JSON object');
    }
    return value;
  } catch (err) {
    throw new LicenseError(ERROR_CODES.INVALID_REQUEST, {
      detail: `malformed JSON: ${err.message}`,
    });
  }
}

/**
 * @param {URLSearchParams} query
 * @param {string} name
 * @returns {string|null} the trimmed value, or null when absent or empty
 */
function readQueryParam(query, name) {
  const raw = query.get(name);
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Reads a bounded integer from the query string.
 *
 * Anything unparseable falls back to the default rather than becoming NaN and
 * poisoning a SQL parameter — `?limit=abc` should mean "the default", not "the
 * server is confused".
 *
 * @param {URLSearchParams} query
 * @param {string} name
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function readBoundedInt(query, name, fallback, min, max) {
  const raw = readQueryParam(query, name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/**
 * The client's IP, for rate limiting.
 *
 * `x-forwarded-for` is only honoured when the operator says the server is
 * behind a proxy. Otherwise any client could pick its own rate-limit bucket by
 * sending the header — which turns a limit into a suggestion.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} trustProxy
 * @returns {string}
 */
function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Builds the request handler.
 *
 * Supports both old API ({ service, config }) and new API ({ licenseService, authService, config }).
 *
 * @param {{
 *   licenseService?: ReturnType<typeof import('./service.js').createLicenseService>,
 *   authService?: ReturnType<typeof import('./auth-service.js').createAuthService>,
 *   service?: ReturnType<typeof import('./service.js').createLicenseService>, // deprecated
 *   driveService?: ReturnType<typeof import('./drive-service.js').createDriveService>,
 *   config: ReturnType<typeof import('./config.js').loadConfig>,
 *   log?: (message: string, detail?: unknown) => void,
 * }} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createRequestHandler(deps) {
  // Backward compatibility: accept `service` as alias for `licenseService`
  const licenseService = deps.licenseService ?? deps.service;
  const authService = deps.authService;
  const adminService = deps.adminService;
  const driveService = deps.driveService;
  const config = deps.config;
  const log = deps.log || (() => {});
  const limiter = createRateLimiter({
    windowMs: config.rateLimit.windowMs,
    maxActivate: config.rateLimit.maxActivate,
    maxVerify: config.rateLimit.maxVerify,
  });
  const trustProxy = config.trustProxy === true;

  // One guard, built once, reused by every admin route.
  const adminAuthorizer = createAdminAuthorizer({
    authService,
    config,
    extractSessionToken,
    log,
  });

  /**
   * Writes the one response shape every endpoint uses.
   *
   * `serverTime` is present on failures too, and is always the server's clock.
   * A client that hit an error still learns the time; more importantly, a
   * client that is refused still gets a clock reading it can trust, because
   * nothing in this response came from the request.
   */
  function send(res, status, body, extraHeaders = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
      ...extraHeaders,
    });
    res.end(payload);
  }

  /**
   * CORS, only for origins the operator listed.
   *
   * The Android build runs on its own origin, so this is not optional there.
   * An origin that is not on the list gets no `Access-Control-Allow-Origin`,
   * which is what makes the browser refuse the response — rather than a
   * wildcard, which would let any site on the internet query a customer's
   * licence status.
   */
  function corsHeaders(req) {
    const origin = req.headers.origin;
    if (!origin || !config.corsOrigins.includes(origin)) return {};
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-credentials': 'true',
      'access-control-max-age': '600',
      vary: 'Origin',
    };
  }

  return async function handle(req, res) {
    const cors = corsHeaders(req);
    const path = (req.url || '').split('?')[0];
    const query = new URL(req.url || '', `http://${req.headers.host}`).searchParams;

    const now = licenseService.serverNow();

    if (req.method === 'OPTIONS') {
      // Preflight. Answered from the same allowlist as the real request so the
      // preflight cannot be more permissive than the call.
      res.writeHead(204, { ...cors, 'content-length': 0 });
      res.end();
      return;
    }

    const matched = matchRoute(path, req.method);
    if (!matched) {
      // The path may still be real and simply not served for this method. Saying
      // so — with the methods that are served — is what lets a caller correct
      // itself without reading the source.
      const otherMethods = allowedMethodsFor(path);
      if (otherMethods.length > 0) {
        const allowed = [...new Set([...otherMethods, 'OPTIONS'])];
        send(
          res,
          405,
          { ...errorBody(ERROR_CODES.INVALID_REQUEST, now), allowed },
          { ...cors, allow: allowed.join(', ') },
        );
        return;
      }

      send(res, 404, { ...errorBody(ERROR_CODES.INVALID_REQUEST, now), path }, cors);
      return;
    }

    const { route, params } = matched;

    // Rate limiting for licence endpoints only
    if (path.startsWith('/api/license/')) {
      const rate = limiter.check(
        `${clientIp(req, trustProxy)}:${route.handler}`,
        route.handler === 'verify' ? 'verify' : 'activate',
        now,
      );
      if (!rate.allowed) {
        send(
          res,
          429,
          errorBody(ERROR_CODES.INVALID_REQUEST, now, 'Too many requests. Try again later.'),
          { ...cors, 'retry-after': String(rate.retryAfterSeconds) },
        );
        return;
      }
    }

    // Admin authorisation. Deliberately placed above the body read and above
    // every branch below: an unauthorised caller must not reach a mutation, and
    // must not even get to send a payload that would be validated. Throwing here
    // means the guard cannot be forgotten inside a handler.
    let admin = null;
    if (route.admin) {
      try {
        admin = adminAuthorizer.requireAdmin(req);
      } catch (err) {
        if (isLicenseError(err)) {
          send(res, err.status, errorBody(err.code, now), cors);
          return;
        }
        throw err;
      }
    }

    // Customer-session guard for the Drive plane. Same placement and the same
    // reason as the admin guard above: identity is resolved from the session
    // cookie before any handler runs, never from anything the caller sent.
    let session = null;
    if (route.session) {
      const token = extractSessionToken(req);
      const me = token && typeof authService?.getMe === 'function' ? authService.getMe(token) : null;
      if (!me) {
        // No usable session: clear the cookie so a stale one does not keep
        // producing 401s the app cannot recover from by retrying.
        if (token) clearSessionCookie(res, config);
        send(res, 401, errorBody(ERROR_CODES.INVALID_SESSION, now), cors);
        return;
      }
      session = { token, account: me.account };
    }

    try {
      // Licence endpoints (POST with JSON body)
      if (path.startsWith('/api/license/')) {
        const body = parseJson(await readBody(req));
        const discarded = rejectedClientFields(body);
        if (discarded.length > 0) {
          log(`discarded unexpected fields on ${path}`, discarded);
        }
        const result = licenseService[route.handler](body);
        const reported = pickClientFields(body);
        send(
          res,
          200,
          {
            ok: true,
            license: result.license,
            serverTime: result.serverTime,
            appVersion: reported.appVersion ?? null,
            platform: reported.platform ?? null,
            status: effectiveStatus(result.license, now),
            ...(route.handler === 'activate'
              ? {
                sessionToken: result.sessionToken,
                linkedAccountId: result.linkedAccountId ?? null,
              }
              : {}),
            ...(route.handler === 'bind' ? { linkedAccountId: result.linkedAccountId ?? null } : {}),
          },
          cors,
        );
        return;
      }

      // Auth endpoints
      if (path === '/api/auth/google/start') {
        const { authUrl, state } = authService.startAuth();
        send(res, 200, { ok: true, authUrl, state, serverTime: now }, cors);
        return;
      }

      if (path === '/api/auth/google/callback') {
        const code = query.get('code');
        const state = query.get('state');
        const error = query.get('error');

        if (error) {
          log('oauth callback error', { error, state });
          send(res, 400, { ok: false, error: { code: 'OAUTH_DENIED', message: `Google denied: ${error}` }, serverTime: now }, cors);
          return;
        }

        if (!code || !state) {
          send(res, 400, { ok: false, error: { code: 'INVALID_REQUEST', message: 'Missing code or state' }, serverTime: now }, cors);
          return;
        }

        const userAgent = req.headers['user-agent'] || null;
        const result = await authService.completeAuth({ code, state, userAgent });
        setSessionCookie(res, result.sessionToken, config);
        send(res, 200, { ok: true, ...result }, cors);
        return;
      }

      if (path === '/api/auth/me') {
        const sessionToken = extractSessionToken(req);
        if (!sessionToken) {
          send(res, 200, { ok: true, authenticated: false, account: null, serverTime: now }, cors);
          return;
        }
        const result = authService.getMe(sessionToken);
        if (!result) {
          clearSessionCookie(res, config);
          send(res, 200, { ok: true, authenticated: false, account: null, serverTime: now }, cors);
          return;
        }
        send(res, 200, { ok: true, authenticated: true, account: result.account, serverTime: result.serverTime }, cors);
        return;
      }

      if (path === '/api/auth/logout') {
        const sessionToken = extractSessionToken(req);
        if (sessionToken) {
          authService.logout(sessionToken);
        }
        clearSessionCookie(res, config);
        send(res, 200, { ok: true, serverTime: now }, cors);
        return;
      }

      // Admin endpoints.
      if (route.handler === 'adminAuthStart') {
        const { authUrl, state } = authService.startAuth({ intent: 'admin' });
        send(res, 200, { ok: true, authUrl, state, serverTime: now }, cors);
        return;
      }

      if (route.handler === 'adminAuthCallback') {
        const code = query.get('code');
        const state = query.get('state');
        const denied = query.get('error');

        if (denied) {
          log('admin oauth denied', { error: denied });
          send(res, 400, errorBody(ERROR_CODES.INVALID_REQUEST, now, 'Sign-in was cancelled.'), cors);
          return;
        }
        if (!code || !state) {
          send(res, 400, errorBody(ERROR_CODES.INVALID_REQUEST, now, 'Missing code or state'), cors);
          return;
        }

        const result = await authService.completeAuth({
          code,
          state,
          userAgent: req.headers['user-agent'] || null,
        });

        // A flow that started at the customer sign-in must not be finishable
        // here, or the two entry points would not be distinguishable in a log.
        if (result.intent !== 'admin') {
          authService.logout(result.sessionToken);
          send(res, 400, errorBody(ERROR_CODES.INVALID_REQUEST, now, 'Wrong sign-in entry point.'), cors);
          return;
        }

        // Authentication succeeded; authorisation is a separate question. This
        // is where a customer account that signed in at the admin portal is
        // turned away — and the session created a moment earlier is destroyed
        // first, so a refused admin attempt leaves no usable cookie behind.
        if (!adminAuthorizer.resolveAdmin(result.sessionToken)) {
          authService.logout(result.sessionToken);
          log('admin sign-in refused', { googleSub: result.account.googleSub });
          send(res, 403, errorBody(ERROR_CODES.ADMIN_REQUIRED, now), cors);
          return;
        }

        setSessionCookie(res, result.sessionToken, config);

        // Only ever to the configured portal URL, never to anything from the
        // request — that is what keeps this from being an open redirect.
        const portalUrl = config.admin.portalUrl;
        if (portalUrl) {
          res.writeHead(302, { location: portalUrl, 'cache-control': 'no-store', ...cors });
          res.end();
          return;
        }
        send(res, 200, {
          ok: true,
          account: result.account,
          serverTime: now,
        }, cors);
        return;
      }

      if (route.handler === 'adminMe') {
        // `admin` is the already-authorised caller; nothing about a customer
        // store is reachable from here, only the operator's own identity.
        send(res, 200, {
          ok: true,
          admin: { googleSub: admin.googleSub, email: admin.email },
          configured: config.admin.authorizedSubs.length,
          serverTime: now,
        }, cors);
        return;
      }

      // ---- guarded admin licence operations ------------------------------
      // Past this point the caller is an authorised admin (the guard threw
      // otherwise), so these read and write licence metadata only.
      if (route.handler.startsWith('admin')) {
        if (!adminService) {
          throw new LicenseError(ERROR_CODES.INTERNAL_ERROR, {
            detail: 'adminService is not wired',
          });
        }

        let body = {};
        if (req.method === 'POST') {
          body = parseJson(await readBody(req));
        }

        let result;
        switch (route.handler) {
          case 'adminListLicenses':
            result = adminService.listLicenses({
              status: readQueryParam(query, 'status'),
              limit: readBoundedInt(query, 'limit', 50, 1, 200),
              offset: readBoundedInt(query, 'offset', 0, 0, 1_000_000),
            });
            break;
          case 'adminCreateLicense':
            result = adminService.createLicense({
              expiresInDays: body.expiresInDays,
              note: body.note,
            });
            break;
          case 'adminGetLicense':
            result = adminService.getLicense(params.id);
            break;
          case 'adminSuspendLicense':
            result = adminService.suspend(params.id, body.reason);
            break;
          case 'adminReactivateLicense':
            result = adminService.reactivate(params.id, body.reason);
            break;
          case 'adminRevokeLicense':
            result = adminService.revoke(params.id, body.reason);
            break;
          case 'adminSetLicenseNote':
            if (!Object.prototype.hasOwnProperty.call(body, 'note')) {
              throw new LicenseError(ERROR_CODES.INVALID_REQUEST, {
                detail: 'note is required (send null to clear it)',
              });
            }
            result = adminService.setNote(params.id, body.note);
            break;
          case 'adminListLicenseEvents':
            result = adminService.listEvents(params.id, {
              limit: readBoundedInt(query, 'limit', 100, 1, 500),
              offset: readBoundedInt(query, 'offset', 0, 0, 1_000_000),
            });
            break;
          default:
            throw new LicenseError(ERROR_CODES.INTERNAL_ERROR, {
              detail: `unknown admin handler ${route.handler}`,
            });
        }

        send(res, 200, { ok: true, ...result, serverTime: now }, cors);
        return;
      }

      // ---- Drive backup authorisation plane -------------------------------
      //
      // Past the `session: true` guard, so `session.account` is a real account.
      //
      // Note what is *not* here: no branch reads a request body. The backup
      // payload is uploaded by the browser straight to googleapis.com and this
      // server is never on that path. Refusing to parse a body is stronger than
      // promising not to store one — there is no code path here that could.
      if (route.handler.startsWith('drive')) {
        if (!driveService) {
          throw new LicenseError(ERROR_CODES.INTERNAL_ERROR, {
            detail: 'driveService is not wired',
          });
        }
        const googleSub = session.account.googleSub;

        if (route.handler === 'driveStatus') {
          const state = driveService.describe(googleSub);
          send(res, 200, {
            ok: true,
            ...state,
            // The folder name is echoed so Settings renders exactly what the
            // server will create. It is a constant, never caller-supplied.
            folderName: config.drive.folderName,
            enabled: config.drive.enabled,
            serverTime: now,
          }, cors);
          return;
        }

        if (route.handler === 'driveToken') {
          const token = await driveService.getAccessToken(googleSub);
          // The one and only credential this server hands out. It is scoped to
          // `drive.file`, addressed to this account, and useless after an hour.
          send(res, 200, {
            ok: true,
            accessToken: token.accessToken,
            expiresAt: token.expiresAt,
            scope: token.scope,
            serverTime: now,
          }, cors);
          return;
        }

        if (route.handler === 'driveConnectStart') {
          // Reuses the one Google OAuth flow the app already has. The `drive`
          // intent records that this consent is for backups, so the callback can
          // only be completed where it was started.
          const start = authService.startAuth({ intent: 'drive' });
          send(res, 200, { ok: true, authUrl: start.authUrl, serverTime: now }, cors);
          return;
        }

        if (route.handler === 'driveConnectCallback') {
          const code = readQueryParam(query, 'code');
          const state_ = readQueryParam(query, 'state');
          if (!code || !state_) {
            throw new LicenseError(ERROR_CODES.INVALID_REQUEST, {
              detail: 'code and state are required',
            });
          }

          let completed;
          try {
            // Awaited, and deliberately inside the try: `completeAuth` is async, so
            // without the await this would read `intent` off a Promise (always
            // undefined), refuse every real consent, and leave the failure as an
            // unhandled rejection that never reaches this response.
            completed = await authService.completeAuth({
              code,
              state: state_,
              userAgent: req.headers['user-agent'],
            });
          } catch (err) {
            // A flow that did not start here — a customer sign-in or an admin
            // sign-in replayed at this URL — must not be honoured.
            if (isLicenseError(err)) throw err;
            throw new LicenseError(ERROR_CODES.INVALID_REQUEST, {
              detail: 'the Google consent could not be completed',
            });
          }

          if (completed.intent !== 'drive') {
            throw new LicenseError(ERROR_CODES.INVALID_REQUEST, {
              status: 400,
              detail: `this consent was started for '${completed.intent}', not for Drive`,
            });
          }

          if (!completed.driveConnected) {
            throw new LicenseError(ERROR_CODES.DRIVE_NOT_CONNECTED, {
              status: 409,
              detail: 'Google did not return a Drive refresh token; consent may have been skipped',
            });
          }

          // The popup that navigated here belongs to the app on this same
          // origin, so the session cookie is set here and the result is handed
          // back by postMessage. No return URL is read from the request — that
          // is what would turn this into an open redirect — and none needs to be
          // configured, which is why there is no production URL to invent.
          setSessionCookie(res, completed.sessionToken, config);
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            ...cors,
          });
          res.end(driveConsentPage(completed.driveConnected));
          return;
        }

        if (route.handler === 'driveDisconnect') {
          const wasConnected = driveService.disconnect(googleSub);
          send(res, 200, {
            ok: true,
            connected: false,
            wasConnected,
            serverTime: now,
          }, cors);
          return;
        }

        throw new LicenseError(ERROR_CODES.INTERNAL_ERROR, {
          detail: `unknown drive handler ${route.handler}`,
        });
      }

      // Should not reach here
      send(res, 404, { ...errorBody(ERROR_CODES.INVALID_REQUEST, now), path }, cors);
    } catch (err) {
      if (isLicenseError(err)) {
        if (err.status >= 500) log(`error ${err.code}`, err.detail);
        send(res, err.status, errorBody(err.code, now), cors);
        return;
      }
      log(`unhandled error on ${path}`, err);
      send(res, 500, errorBody(ERROR_CODES.INTERNAL_ERROR, now), cors);
    }
  };
}

/**
 * Starts the HTTP server.
 *
 * @param {{licenseService: object, authService: object, adminService: object, config: object, log?: Function}} deps
 * @returns {{server: import('node:http').Server, listen: (port?: number, host?: string) => Promise<{port: number, host: string}>}}
 */
export function createLicenseServer({ licenseService, authService, adminService, driveService, config, log = () => {} }) {
  const handle = createRequestHandler({ licenseService, authService, adminService, driveService, config, log });
  const server = createHttpServer((req, res) => {
    // A handler that throws asynchronously would otherwise take the process
    // down; handle() already converts errors to responses.
    handle(req, res).catch((err) => {
      log('handler escaped', err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  return {
    server,
    /**
     * @param {number} [port]
     * @param {string} [host]
     * @returns {Promise<{port: number, host: string}>}
     */
    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          const address = server.address();
          resolve({ port: address.port, host: address.address });
        });
      });
    },
  };
}