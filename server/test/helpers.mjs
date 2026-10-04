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
import { openLicenseDatabase } from '../src/sqlite.js';
import { createLicenseService } from '../src/service.js';
import { createRequestHandler } from '../src/http.js';
import { generateLicenseCode } from '../src/codes.js';
import { openAuthDatabase } from '../src/auth-repository.js';
import { createAuthService } from '../src/auth-service.js';

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
 * @param {{licenseService?: object, authService?: object, service?: object, config: object}} app
 * @param {string} path
 * @param {{method?: string, body?: unknown, headers?: Record<string,string>}} [options]
 * @returns {Promise<{status: number, body: any, headers: Record<string, any>}>}
 */
export async function request(app, path, options = {}) {
  // Backward compatibility: accept `service` as alias for `licenseService`
  const licenseService = app.licenseService ?? app.service;
  // Minimal authService stub for tests that don't provide one
  const authService = app.authService ?? {
    startAuth() { throw new Error('auth not configured'); },
    completeAuth() { throw new Error('auth not configured'); },
    getMe() { return null; },
    logout() { return false; },
    revokeAllSessions() { return 0; },
    serverNow: () => Date.now(),
    getPublicConfig() { return {}; },
  };
  const handle = createRequestHandler({ licenseService, authService, config: app.config });
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