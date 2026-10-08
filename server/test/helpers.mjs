/**
 * Test helpers.
 *
 * Two things every licence test needs and neither should build for itself: a
 * server whose clock the test controls, and a scratch database.
 *
 * The controllable clock matters more than it looks. Expiry is the one rule in
 * this system that is defined by the passage of time, so testing it any other
 * way — waiting, or asserting on a stored flag — either takes a year or proves
 * the wrong thing. With the clock injected, "this licence expires in one
 * millisecond" is a line of setup.
 */

import { loadConfig } from '../src/config.js';
import { openLicenseDatabase } from './support/sqlite-license.js';
import { createLicenseService } from '../src/service.js';
import { createRequestHandler } from '../src/http.js';
import { generateLicenseCode } from '../src/codes.js';
import { openAuthDatabase } from './support/sqlite-auth.js';
import { createAuthService } from '../src/auth-service.js';
import { createAdminLicenseService } from '../src/admin-service.js';
import { openDriveDatabase } from './support/sqlite-drive.js';
import { createDriveService } from '../src/drive-service.js';

/**
 * A pepper long enough to satisfy the production length check, fixed so that a
 * test run is reproducible.
 */
export const TEST_PEPPER = 'test-pepper-not-used-anywhere-else-0123456789';

/**
 * Fast scrypt. The real cost factor (N=16384, ~110ms per verify) is right for
 * production and wrong for a suite that verifies hundreds of codes. The
 * algorithm, salting, and constant-time comparison are identical, so what these
 * tests prove still holds.
 */
const TEST_SCRYPT = { N: 1024, r: 8, p: 1, keylen: 32 };

/**
 * Builds a service on an in-memory database with a clock the test drives.
 *
 * @param {{startAt?: number, env?: Record<string, string>}} [options]
 */
export function createTestService(options = {}) {
  const state = {
    now: options.startAt ?? Date.parse('2026-01-15T00:00:00.000Z'),
  };

  const config = loadConfig({
    NODE_ENV: 'test',
    STOREHUB_PEPPER: TEST_PEPPER,
    STOREHUB_DB: ':memory:',
    STOREHUB_SCRYPT_N: String(TEST_SCRYPT.N),
    STOREHUB_SCRYPT_R: String(TEST_SCRYPT.r),
    STOREHUB_SCRYPT_P: String(TEST_SCRYPT.p),
    STOREHUB_RATE_MAX_ACTIVATE: '1000',
    STOREHUB_RATE_MAX_VERIFY: '1000',
    ...(options.env ?? {}),
  });

  const logs = [];
  const repository = openLicenseDatabase(':memory:', { clock: () => state.now });
  const service = createLicenseService({
    repository,
    config,
    clock: () => state.now,
    log: (message, detail) => logs.push(detail === undefined ? message : `${message} ${JSON.stringify(detail)}`),
  });

  return {
    service,
    repository,
    config,
    logs,
    /** Reads the current fake time. */
    now: () => state.now,
    /** Moves the fake clock. */
    setNow: (value) => {
      state.now = value;
    },
    /** Moves the fake clock forward by `ms`. */
    advance: (ms) => {
      state.now += ms;
    },
    /** Creates a licence and returns its record plus plaintext code. */
    issue(issueOptions = {}) {
      return service.createLicense(issueOptions);
    },
    /** Issues a licence and activates it, returning the session. */
    issueAndActivate(issueOptions = {}, activateFields = {}) {
      const { license, code } = service.createLicense(issueOptions);
      const session = service.activate({
        licenseCode: code,
        installId: 'install-alpha',
        platform: 'android',
        appVersion: '1.0.0',
        ...activateFields,
      });
      return { license, code, session };
    },
    close() {
      repository.close();
    },
  };
}

/**
 * Drives the HTTP handler without binding a socket.
 *
 * Testing the real request path matters: method checks, body limits, status
 * codes, and the envelope are all part of the contract, and a test that calls
 * the service directly would pass even if the route layer were broken.
 *
 * @param {{
 *   licenseService?: object,
 *   authService?: object,
 *   adminService?: object,
 *   driveService?: object,
 *   service?: object,
 *   config: object,
 * }} app
 * @param {string} path
 * @param {{method?: string, body?: unknown, headers?: Record<string,string>}} [options]
 * @returns {Promise<{status: number, body: any, headers: Record<string, any>}>}
 */
export async function request(app, path, options = {}) {
  // Backward compatibility: accept `service` as alias for `licenseService`.
  const licenseService = app.licenseService ?? app.service;

  // A stub for the auth plane, so a licence-only test does not have to build an
  // OAuth round trip it does not care about. `getMe` returning null is the
  // correct answer for "this request has no session", which is what keeps every
  // admin route refusing by default.
  const authService = app.authService ?? {
    startAuth() {
      throw new Error('auth not configured');
    },
    completeAuth() {
      throw new Error('auth not configured');
    },
    getMe() {
      return null;
    },
    logout() {
      return false;
    },
    revokeAllSessions() {
      return 0;
    },
    serverNow: () => Date.now(),
    getPublicConfig() {
      return {};
    },
  };

  const handle = createRequestHandler({
    licenseService,
    authService,
    adminService: app.adminService,
    driveService: app.driveService,
    config: app.config,
  });

  const method = options.method ?? 'POST';
  const payload = options.body === undefined ? '' : JSON.stringify(options.body);

  const chunks = [Buffer.from(payload, 'utf8')];
  const req = {
    method,
    url: path,
    headers: {
      'content-length': String(Buffer.byteLength(payload)),
      ...(options.headers ?? {}),
    },
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    on(event, handler) {
      if (event === 'data') {
        for (const chunk of chunks) handler(chunk);
      } else if (event === 'end' || event === 'error') {
        handler(undefined);
      }
      return req;
    },
    resume() {
      return req;
    },
    destroy() {
      return req;
    },
  };

  let status = 200;
  const headers = {};
  let text = '';
  const res = {
    headersSent: false,
    // Real Node merges `setHeader` calls with whatever `writeHead` is given, and
    // the auth routes set the session cookie that way. Without this the cookie
    // paths would throw instead of being asserted on.
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value;
      return res;
    },
    writeHead(code, headerMap = {}) {
      status = code;
      Object.assign(headers, headerMap);
      this.headersSent = true;
      return this;
    },
    write(chunk) {
      text += chunk;
      return true;
    },
    end(chunk) {
      if (chunk) text += chunk;
    },
  };

  await handle(req, res);
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status, body, headers };
}

/** @returns {string} a syntactically valid code that belongs to nobody. */
export function unknownValidCode() {
  return generateLicenseCode();
}

/**
 * Builds an auth service on the same in-memory database as the licence service.
 *
 * @param {{service: object, repository: object, config: object, now: Function}} app
 * @returns {Promise<{authService: object, authRepository: object, authDb: object, config: object, close: Function}>}
 */
export async function createTestAuthService(app) {
  const authDb = await openAuthDatabase(':memory:', {
    clock: () => app.now(),
    pepper: app.config.pepper,
  });
  const authService = createAuthService({
    authRepository: authDb.repo,
    config: app.config,
    clock: () => app.now(),
    log: () => {},
  });

  return {
    authService,
    authRepository: authDb.repo,
    authDb: authDb.db,
    config: app.config,
    close() {
      authDb.repo.close();
    },
  };
}

/**
 * Builds the whole backend — licence, auth and admin — on in-memory databases,
 * with one clock the test drives and a set of Google accounts it can sign in as.
 *
 * Sessions are minted through the repository rather than by driving a real
 * Google round trip, because the thing under test is *who is allowed to do
 * what*, not whether the OAuth dance works. The one test that does need the real
 * flow (the admin callback) mocks `fetch` and goes through `completeAuth` for
 * real.
 *
 * @param {{authorizedSubs?: string[], portalUrl?: string, startAt?: number}} [options]
 */
export async function createTestAdminApp(options = {}) {
  const base = createTestService({
    env: {
      STOREHUB_ADMIN_SUB: (options.authorizedSubs ?? []).join(','),
      ...(options.portalUrl ? { STOREHUB_ADMIN_PORTAL_URL: options.portalUrl } : {}),
    },
  });

  const auth = await createTestAuthService(base);
  const adminService = createAdminLicenseService({
    licenseService: base.service,
    repository: base.repository,
    clock: () => base.now(),
    log: () => {},
  });

  return {
    ...base,
    authService: auth.authService,
    authRepository: auth.authRepository,
    authDb: auth.authDb,
    adminService,

    /**
     * Signs a Google account in and returns the cookie value the admin guard
     * will read. `sub` is the identity everything is decided on.
     *
     * @param {string} googleSub
     * @param {{email?: string}} [meta]
     */
    signIn(googleSub, meta = {}) {
      auth.authRepository.upsertAccount({
        googleSub,
        email: meta.email ?? `${googleSub}@example.test`,
        displayName: meta.displayName ?? null,
        avatarUrl: null,
      });
      const { sessionToken } = auth.authRepository.createSession(
        googleSub,
        base.config.session.ttlMs,
        'node-test',
      );
      return sessionToken;
    },

    /** @param {string} [token] @returns {Record<string,string>} request headers carrying the session */
    cookieHeaders(token) {
      return { cookie: `storehub_session=${token}` };
    },

    close() {
      auth.close();
      base.close();
    },
  };
}

/**
 * Builds a backend with the Drive authorisation plane wired up.
 *
 * Three separate in-memory databases, which is the arrangement production uses
 * too: licences, accounts/sessions, and Drive grants. The tests below assert
 * that separation rather than trusting it, so building them together here is
 * what makes those assertions meaningful — a test that used one shared database
 * would prove nothing.
 *
 * @param {{googleSub?: string, connect?: boolean, scopes?: string, env?: Record<string,string>}} [options]
 */
export async function createTestDriveApp(options = {}) {
  const base = createTestService({
    env: {
      GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
      // Deliberately *not* a `/api/drive/...` path. A test that asserts a plain
      // sign-in asks for no Drive scope would pass or fail for the wrong reason
      // if every auth URL carried "drive" in its redirect_uri.
      GOOGLE_REDIRECT_URI: 'https://storehub.test/api/auth/callback',
      ...(options.env ?? {}),
    },
  });

  const auth = await createTestAuthService(base);
  const driveDb = await openDriveDatabase(':memory:', {
    clock: () => base.now(),
    pepper: base.config.pepper,
  });
  const driveService = createDriveService({
    driveRepository: driveDb.repo,
    config: base.config,
    clock: () => base.now(),
    log: () => {},
    // Scripted so no test can reach the real Google token endpoint.
    fetchImpl: options.fetchImpl ?? (async () => {
      throw new Error('google not reachable in tests');
    }),
  });

  // The sink is what the OAuth callback uses to record a grant, exactly as
  // buildApplication wires it. Driving `connect()` here rather than a full
  // Google round trip keeps the tests about authorisation, not about Google's
  // redirect handling.
  const authWithDrive = createAuthService({
    authRepository: auth.authRepository,
    config: base.config,
    clock: () => base.now(),
    log: () => {},
    driveGrantSink: driveService,
  });

  const googleSub = options.googleSub ?? 'shop-sub-1';

  const app = {
    ...base,
    authService: authWithDrive,
    authRepository: auth.authRepository,
    authDb: auth.authDb,
    driveService,
    driveDb: driveDb.db,
    driveRepository: driveDb.repo,
    googleSub,

    /**
     * Signs a Google account in and returns the session token the Drive guard
     * reads out of the cookie.
     */
    signIn(sub = googleSub, meta = {}) {
      auth.authRepository.upsertAccount({
        googleSub: sub,
        email: meta.email ?? `${sub}@example.test`,
        displayName: meta.displayName ?? null,
        avatarUrl: null,
      });
      const { sessionToken } = auth.authRepository.createSession(
        sub,
        base.config.session.ttlMs,
        'node-test',
      );
      return sessionToken;
    },

    /** @param {string} [token] @returns {Record<string,string>} */
    cookieHeaders(token) {
      return { cookie: `storehub_session=${token}` };
    },

    /** Records a Drive grant without an OAuth round trip. */
    connect(refreshToken = 'refresh-token-alpha', sub = googleSub) {
      return driveService.recordGrant({ googleSub: sub, refreshToken, scopes: options.scopes });
    },

    close() {
      driveDb.repo.close();
      auth.close();
      base.close();
    },
  };

  if (options.connect) app.connect();
  return app;
}
