/**
 * Live PostgreSQL smoke test (Phase 6).
 *
 * Runs three layers against the live Supabase database through the synchronous
 * connection layer, then cleans up its own rows back to exactly zero:
 *
 *   1. repositories  — license, auth, drive, straight against the tables;
 *   2. services      — createLicenseService / createAuthService /
 *                      createDriveService / createAdminLicenseService built on
 *                      those same PostgreSQL repositories;
 *   3. HTTP          — buildApplication() boots in PostgreSQL mode, the real
 *                      node:http server listens on a loopback port, and the
 *                      routes are called over a socket.
 *
 * PostgreSQL-only by construction: this script never opens an SQLite handle and
 * never imports ./helpers.mjs (which does). `node:sqlite` is only ever imported
 * lazily inside the SQLite-only open functions, and the PostgreSQL branch of
 * buildApplication never takes that path because usePostgres is on here.
 *
 * It reads server/.env via the same config loader as the runtime and connects
 * with `SUPABASE_DB_URL` verbatim. Optional `PG_LIVE_PORT` (default: unset)
 * overrides only the *port* of that URL — the target database is identical; it
 * exists for networks where one pooler port is unreachable while another works.
 * This knob is test-scoped and off by default; the runtime never uses it.
 *
 * Exit code 0 only if every check passed AND every table is back to 0 rows.
 */

import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';

import { loadEnvFile, loadConfig } from '../src/config.js';
import { createSupabaseClient } from '../src/pg.js';
import { openLicenseDatabase } from '../src/pg-license-repository.js';
import { openAuthDatabase } from '../src/pg-auth-repository.js';
import { openDriveDatabase } from '../src/pg-drive-repository.js';
// Service + HTTP layers (never ../test/helpers.mjs: that module imports sqlite.js).
import { createLicenseService } from '../src/service.js';
import { createAuthService } from '../src/auth-service.js';
import { createDriveService } from '../src/drive-service.js';
import { createAdminLicenseService } from '../src/admin-service.js';
import { buildApplication } from '../src/index.js';
import { createLicenseServer } from '../src/http.js';

// ---------------------------------------------------------------------------
// Tiny assertion harness (deliberately dependency-free).
// ---------------------------------------------------------------------------
const results = { passed: 0, failed: 0, blocked: false };

function ok(label) {
  results.passed += 1;
  console.log(`  ok: ${label}`);
}

function bad(label, extra) {
  results.failed += 1;
  console.error(`  FAIL: ${label}${extra ? ` :: ${extra}` : ''}`);
}

function check(label, cond, extra) {
  if (cond) ok(label);
  else bad(label, extra);
}

function checkEq(label, actual, expected) {
  check(
    label,
    Object.is(actual, expected),
    `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`,
  );
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
loadEnvFile();
const portOverride = process.env.PG_LIVE_PORT;
if (portOverride) {
  const url = new URL(process.env.SUPABASE_DB_URL);
  url.port = String(portOverride);
  process.env.SUPABASE_DB_URL = url.href;
}
const config = loadConfig(process.env);
if (!config.supabaseDbUrl) {
  console.error('test:live blocked: SUPABASE_DB_URL is not set (PostgreSQL-only since Phase 4).');
  process.exit(1);
}

const clock = () => Date.now();
const now = Date.now();
const prefix = `__test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const accountSub = `${prefix}_sub`;

/**
 * Ids of licences minted by the service and HTTP layers.
 *
 * Those ids are random UUIDs (the service calls `repository.newId()`), so a
 * `__test_` prefix cannot be used to find them. Cleanup therefore tracks the
 * exact ids here and also gives every one of those rows a `__test_` note as a
 * second key — no cleanup statement is ever table-wide.
 */
const trackedLicenseIds = new Set();
function trackLicense(id) {
  if (id) trackedLicenseIds.add(String(id));
}

const TABLES = [
  'licenses',
  'license_tokens',
  'license_installs',
  'license_events',
  'auth_accounts',
  'auth_sessions',
  'drive_grants',
];

let client = createSupabaseClient(config);
let licenseRepo;
let authRepo;
let driveRepo;

async function baselineCheck() {
  const counts = {};
  for (const t of TABLES) {
    counts[t] = client.query(`SELECT COUNT(*)::int AS n FROM "${t}"`)[0].n;
  }
  const clean = TABLES.every((t) => counts[t] === 0);
  check('baseline: every table at 0 rows', clean, JSON.stringify(counts));
  return clean;
}

function cleanup() {
  // FK order: events (no FK) -> tokens -> installs -> licenses -> sessions ->
  // drive grants -> accounts. Every predicate is an exact key — either an id
  // captured while testing or a `__test_` marker — never a table-wide delete.
  for (const id of trackedLicenseIds) {
    client.exec('DELETE FROM license_events WHERE license_id = $1', [id]);
    client.exec('DELETE FROM license_tokens WHERE license_id = $1', [id]);
    client.exec('DELETE FROM license_installs WHERE license_id = $1', [id]);
    client.exec('DELETE FROM licenses WHERE id = $1', [id]);
  }
  // Service/HTTP licences whose id was not captured: keyed on their `__test_`
  // note, children first.
  client.exec("DELETE FROM license_events WHERE license_id IN (SELECT id FROM licenses WHERE note LIKE '__test_%')");
  client.exec("DELETE FROM license_tokens WHERE license_id IN (SELECT id FROM licenses WHERE note LIKE '__test_%')");
  client.exec("DELETE FROM license_installs WHERE license_id IN (SELECT id FROM licenses WHERE note LIKE '__test_%')");
  client.exec("DELETE FROM licenses WHERE note LIKE '__test_%'");
  // Repository checks: ids and lookups that carry the `__test_` marker.
  client.exec("DELETE FROM license_events WHERE license_id LIKE '__test_%'");
  client.exec("DELETE FROM license_tokens WHERE license_id LIKE '__test_%'");
  client.exec("DELETE FROM license_installs WHERE license_id LIKE '__test_%'");
  client.exec("DELETE FROM licenses WHERE id LIKE '__test_%' OR code_lookup LIKE '__test_%'");
  client.exec("DELETE FROM auth_sessions WHERE google_sub LIKE '__test_%'");
  client.exec("DELETE FROM drive_grants WHERE google_sub LIKE '__test_%'");
  client.exec("DELETE FROM auth_accounts WHERE google_sub LIKE '__test_%'");
}

// ---------------------------------------------------------------------------
// Layer 2 — the services, built on the same PostgreSQL repositories
// ---------------------------------------------------------------------------
function serviceLayerChecks() {
  const licenseService = createLicenseService({ repository: licenseRepo, config, clock, log: () => {} });
  const authService = createAuthService({ authRepository: authRepo, config, clock, log: () => {} });
  const driveService = createDriveService({ driveRepository: driveRepo, config, clock, log: () => {} });
  const adminService = createAdminLicenseService({ licenseService, repository: licenseRepo, clock, log: () => {} });

  // -- licence lifecycle -----------------------------------------------------
  const { license: issued, code } = licenseService.createLicense({
    expiresInDays: 1,
    note: `${prefix}_service`,
  });
  trackLicense(issued.id);
  check('service: createLicense issues a code', typeof code === 'string' && code.startsWith('SH-'));

  const activation = licenseService.activate({
    licenseCode: code,
    installId: `${prefix}-svc`,
    platform: 'android',
    appVersion: '9.9.9',
  });
  check('service: activate issues a session token', typeof activation.sessionToken === 'string' && activation.sessionToken.length >= 40);

  const verified = licenseService.verify({
    sessionToken: activation.sessionToken,
    installId: `${prefix}-svc`,
    platform: 'android',
    appVersion: '9.9.9',
  });
  check('service: verify accepts the activation session', verified?.license?.status === 'active');

  licenseService.bind({ sessionToken: activation.sessionToken, accountId: accountSub });
  checkEq('service: bind links the account', licenseRepo.findById(issued.id)?.linkedAccountId, accountSub);

  const view = adminService.getLicense(issued.id)?.license;
  check(
    'service: admin view carries no code material',
    !!view && !('codeHash' in view) && !('codeSalt' in view) && !('codeLookup' in view),
    view ? '' : 'admin view missing',
  );

  // -- auth session ----------------------------------------------------------
  const { sessionToken } = authRepo.createSession(accountSub, 120_000, 'live-service');
  check('service: getMe resolves a repository session', authService.getMe(sessionToken)?.account?.googleSub === accountSub);
  check('service: getMe refuses a mutated token', authService.getMe(`${sessionToken.slice(0, -1)}X`) === null);

  // -- drive -----------------------------------------------------------------
  const fakeRefresh = `${prefix}-refresh-${randomUUID()}`;
  const recorded = driveService.recordGrant({ googleSub: accountSub, refreshToken: fakeRefresh, scopes: 'drive.file' });
  check('service: recordGrant accepts a fake refresh token', recorded?.googleSub === accountSub);
  const state = driveService.describe(accountSub);
  check('service: describe reports connected', state.connected === true);
  check('service: describe carries no refresh token', !JSON.stringify(state).includes(fakeRefresh));
  checkEq('service: disconnect revokes the grant', driveService.disconnect(accountSub), true);
  check('service: describe reports disconnected', driveService.describe(accountSub).connected === false);
}

// ---------------------------------------------------------------------------
// Layer 3 — the real HTTP server, in PostgreSQL mode, over a loopback socket
// ---------------------------------------------------------------------------
let httpBase = '';

/** One HTTP round trip against the booted server. No proxy, no agent. */
function call(method, path, { body, cookie } = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `${httpBase}${path}`,
      {
        method,
        agent: false,
        headers: {
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
            : {}),
          ...(cookie ? { cookie } : {}),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function httpLayerChecks() {
  const adminSub = `${prefix}_admin_sub`;
  authRepo.upsertAccount({ googleSub: adminSub, email: `${adminSub}@live-test.invalid`, displayName: 'Live Admin' });
  const adminSession = authRepo.createSession(adminSub, 120_000, 'live-http-admin');
  const customerSession = authRepo.createSession(accountSub, 120_000, 'live-http-customer');
  const adminCookie = `storehub_session=${adminSession.sessionToken}`;
  const customerCookie = `storehub_session=${customerSession.sessionToken}`;

  // Test-scoped process environment only; server/.env is never written.
  // STOREHUB_ADMIN_SUB authorises this run's throwaway admin sub. (Phase 4:
  // STOREHUB_DB no longer exists — the runtime creates no local files.)
  process.env.STOREHUB_ADMIN_SUB = adminSub;

  const app = await buildApplication({ env: process.env });
  const server = createLicenseServer({
    licenseService: app.licenseService,
    authService: app.authService,
    adminService: app.adminService,
    driveService: app.driveService,
    config: app.config,
    log: () => {},
  });

  try {
    const address = await server.listen(0, '127.0.0.1');
    httpBase = `http://127.0.0.1:${address.port}`;
    ok(`http: server listening on 127.0.0.1:${address.port} (PostgreSQL mode)`);

    // -- routes that do not exist in the contract ---------------------------
    // These four paths appear only in PHASE_2_AUDIT_REPORT.md's inventory; the
    // route table in http.js has never carried them. Asserted as 404 so the
    // gap is evidence, not an assumption.
    for (const [method, path] of [
      ['POST', '/api/auth/session'],
      ['POST', '/api/auth/session/verify'],
      ['POST', '/api/drive/grant'],
      ['POST', '/api/drive/revoke'],
    ]) {
      const r = await call(method, path, { body: {} });
      check(`http: ${method} ${path} is not implemented (404)`, r.status === 404, `got ${r.status}`);
    }

    // -- auth session over HTTP ---------------------------------------------
    const me = await call('GET', '/api/auth/me', { cookie: customerCookie });
    check(
      'http: GET /api/auth/me resolves the session',
      me.status === 200 && me.body?.authenticated === true && me.body?.account?.googleSub === accountSub,
      `status ${me.status}`,
    );
    const anon = await call('GET', '/api/auth/me');
    check('http: GET /api/auth/me reports anonymous without a cookie', anon.status === 200 && anon.body?.authenticated === false);

    // -- admin plane ---------------------------------------------------------
    const adminMe = await call('GET', '/api/admin/me', { cookie: adminCookie });
    check('http: GET /api/admin/me authorises the admin sub', adminMe.status === 200 && adminMe.body?.admin?.googleSub === adminSub, `status ${adminMe.status}`);
    const adminNoSession = await call('GET', '/api/admin/me');
    check('http: GET /api/admin/me refuses without a session', adminNoSession.status === 401, `got ${adminNoSession.status}`);

    const created = await call('POST', '/api/admin/licenses', {
      cookie: adminCookie,
      body: { expiresInDays: 1, note: `${prefix}_admin` },
    });
    const adminLicenseId = created.body?.license?.id;
    const adminCode = created.body?.code;
    trackLicense(adminLicenseId);
    check('http: POST /api/admin/licenses returns id + code once', created.status === 200 && typeof adminLicenseId === 'string' && typeof adminCode === 'string', `status ${created.status}`);

    const list = await call('GET', '/api/admin/licenses?limit=200', { cookie: adminCookie });
    check(
      'http: GET /api/admin/licenses lists the test licence',
      list.status === 200 && Array.isArray(list.body?.licenses) && list.body.licenses.some((l) => l.id === adminLicenseId),
      `status ${list.status}`,
    );

    // -- customer licence plane over HTTP -----------------------------------
    const activation = await call('POST', '/api/license/activate', {
      body: {
        licenseCode: adminCode,
        installId: `${prefix}-http`,
        platform: 'android',
        appVersion: '9.9.9',
      },
    });
    const token = activation.body?.sessionToken;
    check('http: POST /api/license/activate', activation.status === 200 && typeof token === 'string' && token.length >= 40, `status ${activation.status}`);

    const verification = await call('POST', '/api/license/verify', {
      body: { sessionToken: token, installId: `${prefix}-http`, platform: 'android', appVersion: '9.9.9' },
    });
    check('http: POST /api/license/verify', verification.status === 200 && verification.body?.license?.status === 'active', `status ${verification.status}`);

    const binding = await call('POST', '/api/license/bind', {
      body: { sessionToken: token, accountId: accountSub },
    });
    check('http: POST /api/license/bind links the account', binding.status === 200 && binding.body?.linkedAccountId === accountSub, `status ${binding.status}`);

    // -- admin lifecycle over HTTP ------------------------------------------
    const suspended = await call('POST', `/api/admin/licenses/${adminLicenseId}/suspend`, { cookie: adminCookie, body: { reason: 'live test' } });
    check('http: POST .../suspend', suspended.status === 200 && suspended.body?.license?.status === 'suspended', `status ${suspended.status}`);

    const reactivated = await call('POST', `/api/admin/licenses/${adminLicenseId}/reactivate`, { cookie: adminCookie, body: { reason: 'live test' } });
    check('http: POST .../reactivate', reactivated.status === 200 && reactivated.body?.license?.status === 'active', `status ${reactivated.status}`);

    const revoked = await call('POST', `/api/admin/licenses/${adminLicenseId}/revoke`, { cookie: adminCookie, body: { reason: 'live test' } });
    check('http: POST .../revoke', revoked.status === 200 && revoked.body?.license?.status === 'revoked', `status ${revoked.status}`);

    // -- drive plane over HTTP ----------------------------------------------
    const fakeRefresh = `${prefix}-http-refresh-${randomUUID()}`;
    app.driveService.recordGrant({ googleSub: accountSub, refreshToken: fakeRefresh, scopes: 'drive.file' });

    const driveStatus = await call('GET', '/api/drive/status', { cookie: customerCookie });
    check('http: GET /api/drive/status reports connected', driveStatus.status === 200 && driveStatus.body?.connected === true, `status ${driveStatus.status}`);
    check('http: drive status leaks no refresh token', !JSON.stringify(driveStatus.body ?? {}).includes(fakeRefresh));

    const driveNoSession = await call('GET', '/api/drive/status');
    check('http: drive routes refuse without a session', driveNoSession.status === 401, `got ${driveNoSession.status}`);

    const disconnect = await call('POST', '/api/drive/disconnect', { cookie: customerCookie });
    check('http: POST /api/drive/disconnect revokes', disconnect.status === 200 && disconnect.body?.ok === true, `status ${disconnect.status}`);

    const after = await call('GET', '/api/drive/status', { cookie: customerCookie });
    check('http: drive status reports disconnected after revoke', after.body?.connected === false, `status ${after.status}`);
  } finally {
    try { await new Promise((resolve) => server.server.close(resolve)); } catch { /* already closed */ }
    try { app.close(); } catch { /* best effort */ }
  }
}

async function main() {
  // Boot
  const t0 = Date.now();
  try {
    client.query('SELECT 1');
    check('boot: SELECT 1 via the sync connection layer', true, `in ${Date.now() - t0}ms`);
  } catch (err) {
    bad('boot: SELECT 1 through the sync connection layer', String(err.message).slice(0, 160));
    return;
  }

  if (!(await baselineCheck())) {
    results.blocked = true;
    return;
  }

  // The leading `null` is the retired filesystem-path argument: PostgreSQL
  // ignores it, and Phase 4 removed every local database file setting.
  licenseRepo = openLicenseDatabase(null, { clock, config, pgClient: client });
  const authDb = await openAuthDatabase(null, {
    clock,
    pepper: config.pepper,
    config,
    pgClient: client,
  });
  authRepo = authDb.repo;
  const driveDb = await openDriveDatabase(null, {
    clock,
    pepper: config.pepper,
    config,
    pgClient: client,
  });
  driveRepo = driveDb.repo;

  // -------------------------------------------------------------------------
  // Auth: account
  // -------------------------------------------------------------------------
  authRepo.upsertAccount({
    googleSub: accountSub,
    email: `${accountSub}@live-test.invalid`,
    displayName: 'Live Test Account',
  });
  const fetchedAccount = authRepo.getAccount(accountSub);
  check('auth: upsertAccount -> getAccount', fetchedAccount?.googleSub === accountSub);

  // -------------------------------------------------------------------------
  // License: full lifecycle (insert uses BEGIN IMMEDIATE -> session -> COMMIT)
  // -------------------------------------------------------------------------
  const licenseId = `__test_${randomUUID()}`;
  const codeLookup = `${prefix}_code`;
  const inserted = licenseRepo.insert({
    id: licenseId,
    codeLookup,
    codeSalt: randomUUID(),
    codeHash: randomUUID(),
    status: 'active',
    expiresAt: now + 86_400_000, // +1 day
    note: null,
  });
  check('license: insert (session BEGIN IMMEDIATE -> COMMIT)', inserted.inserted === true);
  checkEq('license: insert returns the stored record', inserted.record?.id, licenseId);

  check('license: findById', licenseRepo.findById(licenseId)?.id === licenseId);
  check('license: findByCodeLookup', licenseRepo.findByCodeLookup(codeLookup)?.id === licenseId);
  check(
    'license: findByCodeLookup (secrets)',
    licenseRepo.findByCodeLookup(codeLookup, { includeSecrets: true })?.codeHash === inserted.record.codeHash,
  );
  check('license: createdAt is a number (int8 decoded)', typeof inserted.record.createdAt === 'number');

  licenseRepo.bindAccount(licenseId, accountSub);
  checkEq('license: bindAccount', licenseRepo.findById(licenseId)?.linkedAccountId, accountSub);

  licenseRepo.markActivated(licenseId);
  licenseRepo.markVerified(licenseId);
  check('license: markActivated/markVerified', (licenseRepo.findById(licenseId)?.activatedAt ?? 0) > 0);

  licenseRepo.setStatus(licenseId, 'suspended');
  checkEq('license: setStatus suspended', licenseRepo.findById(licenseId)?.status, 'suspended');
  licenseRepo.setStatus(licenseId, 'active');
  checkEq('license: setStatus active', licenseRepo.findById(licenseId)?.status, 'active');

  licenseRepo.setNote(licenseId, 'phase-6 live note');
  checkEq('license: setNote', licenseRepo.findById(licenseId)?.note, 'phase-6 live note');

  licenseRepo.recordEvent({ licenseId, event: 'TEST_EVENT', detail: 'phase6' });
  const events = licenseRepo.listEvents(licenseId);
  checkEq('license: recordEvent -> listEvents count', events.length, 1);
  check('license: event shape', events[0]?.event === 'TEST_EVENT' && typeof events[0]?.at === 'number');

  licenseRepo.upsertInstall({ licenseId, installId: `${prefix}-install`, platform: 'live-test', appVersion: '9.9' });
  licenseRepo.upsertInstall({ licenseId, installId: `${prefix}-install`, platform: 'live-test', appVersion: '9.9.1' });
  const installs = licenseRepo.listInstalls(licenseId);
  checkEq('license: upsertInstall keeps one row', installs.length, 1);
  checkEq('license: upsertInstall applied update', installs[0]?.appVersion, '9.9.1');

  const tokenLookup = `${prefix}-tkn`;
  licenseRepo.insertToken(tokenLookup, licenseId);
  checkEq('license: insertToken -> findToken', licenseRepo.findToken(tokenLookup)?.licenseId, licenseId);
  check('license: token not yet revoked', licenseRepo.findToken(tokenLookup)?.revokedAt == null);
  licenseRepo.touchToken(tokenLookup);
  licenseRepo.revokeAllTokens(licenseId);
  check('license: revokeAllTokens marks revoked', (licenseRepo.findToken(tokenLookup)?.revokedAt ?? 0) > 0);

  const page = licenseRepo.listLicenses({ limit: 200 });
  check('license: listLicenses exposes the test row', page.records.some((r) => r.id === licenseId));

  // -------------------------------------------------------------------------
  // Auth: session lifecycle
  // -------------------------------------------------------------------------
  const session = authRepo.createSession(accountSub, 120_000, 'phase-6-live');
  const resolved = authRepo.resolveSession(session.sessionToken);
  check('auth: createSession -> resolveSession', resolved?.account?.googleSub === accountSub);
  check('auth: session lastUsedAt updated', resolved?.session?.lastUsedAt != null);
  checkEq('auth: deleteSession', authRepo.deleteSession(session.sessionToken), true);
  authRepo.cleanupExpiredSessions();
  ok('auth: cleanupExpiredSessions ran');

  // -------------------------------------------------------------------------
  // Drive: grant lifecycle (AES-256-GCM roundtrip)
  // -------------------------------------------------------------------------
  driveRepo.saveGrant(accountSub, `${prefix}-refresh-a-${randomUUID()}`, 'drive.file');
  check('drive: saveGrant -> getGrant roundtrip', driveRepo.getGrant(accountSub)?.refreshToken?.startsWith(`${prefix}-refresh-a-`));
  check('drive: listGranted includes the sub', driveRepo.listGranted().includes(accountSub));
  const secondToken = `${prefix}-refresh-b-${randomUUID()}`;
  driveRepo.saveGrant(accountSub, secondToken, 'drive.file read-only');
  checkEq('drive: saveGrant upsert replaces the token', driveRepo.getGrant(accountSub)?.refreshToken, secondToken);
  checkEq('drive: revokeGrant', driveRepo.revokeGrant(accountSub), true);
  check('drive: getGrant returns null after revoke', driveRepo.getGrant(accountSub) === null);
  checkEq('drive: deleteGrant', driveRepo.deleteGrant(accountSub), true);

  // -------------------------------------------------------------------------
  // Layer 2: services over the PostgreSQL repositories
  // -------------------------------------------------------------------------
  serviceLayerChecks();

  // -------------------------------------------------------------------------
  // Layer 3: the real HTTP server in PostgreSQL mode
  // -------------------------------------------------------------------------
  await httpLayerChecks();

  // -------------------------------------------------------------------------
  // Wrap up
  // -------------------------------------------------------------------------
}

main()
  .catch((err) => {
    results.failed += 1;
    console.error('  FAIL: unexpected exception:', String(err && err.message).slice(0, 300));
  })
  .finally(() => {
    try {
      // Cleanup must run while the client is still open: repository close()
      // routes to the shared client's idempotent close.
      cleanup();
      const leftovers = TABLES.map((t) => {
        const n = client.query(`SELECT COUNT(*)::int AS n FROM "${t}"`)[0].n;
        return [t, n];
      }).filter(([, n]) => n !== 0);
      if (leftovers.length === 0) {
        if (!results.blocked) ok('cleanup: every table back to exactly 0 rows');
      } else {
        bad('cleanup: leftover rows remain', JSON.stringify(leftovers));
      }
    } catch (err) {
      bad('cleanup: cleanup itself errored', String(err && err.message).slice(0, 200));
    }
    try { client.close(); } catch { /* best effort */ }

    console.log(
      `\ntest:live summary: ${results.passed} passed, ${results.failed} failed${results.blocked ? ' (blocked: nonzero baseline)' : ''}`,
    );
    process.exitCode = results.failed === 0 && !results.blocked ? 0 : 1;
  });