/**
 * Live PostgreSQL smoke test (Phase 6).
 *
 * Runs the real repositories (license, auth, drive) end-to-end against the
 * live Supabase database through the synchronous connection layer, then cleans
 * up its own `__test_*` rows back to exactly zero.
 *
 * PostgreSQL-only by construction: this script never opens an SQLite handle.
 * (The shared repository modules import `node:sqlite` lazily inside their
 * SQLite-only open functions, which are never called here.)
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

import { loadEnvFile, loadConfig } from '../src/config.js';
import { createSupabaseClient } from '../src/pg.js';
import { openLicenseDatabase } from '../src/pg-license-repository.js';
import { openAuthDatabase } from '../src/pg-auth-repository.js';
import { openDriveDatabase } from '../src/pg-drive-repository.js';

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
if (!config.usePostgres) {
  console.error('test:live blocked: SUPABASE_DB_URL is not set (usePostgres off).');
  process.exit(1);
}

const clock = () => Date.now();
const now = Date.now();
const prefix = `__test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const accountSub = `${prefix}_sub`;

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
  // drive grants -> accounts.
  client.exec("DELETE FROM license_events WHERE license_id LIKE '__test_%'");
  client.exec("DELETE FROM license_tokens WHERE license_id LIKE '__test_%'");
  client.exec("DELETE FROM license_installs WHERE license_id LIKE '__test_%'");
  client.exec("DELETE FROM licenses WHERE id LIKE '__test_%' OR code_lookup LIKE '__test_%'");
  client.exec("DELETE FROM auth_sessions WHERE google_sub LIKE '__test_%'");
  client.exec("DELETE FROM drive_grants WHERE google_sub LIKE '__test_%'");
  client.exec("DELETE FROM auth_accounts WHERE google_sub LIKE '__test_%'");
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

  licenseRepo = openLicenseDatabase(config.databaseFile, { clock, config, pgClient: client });
  const authDb = await openAuthDatabase(config.databaseFile, {
    clock,
    pepper: config.pepper,
    config,
    pgClient: client,
  });
  authRepo = authDb.repo;
  const driveDb = await openDriveDatabase(config.databaseFile, {
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