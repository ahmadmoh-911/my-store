/**
 * Store Hub — Foundation layer tests.
 *
 *   node tests/foundation.test.mjs
 *
 * Zero dependencies on purpose: the project has no package.json and no
 * node_modules, and the Foundation layer is not allowed to change that. The
 * only test asset is the IndexedDB double next door.
 *
 * Covers the seven required areas:
 *   1. version module returns the logical app version
 *   2. platform detection does not break the web runtime
 *   3. the identity database opens
 *   4. an install id is created on first use
 *   5. that install id stays the same afterwards
 *   6. identity metadata does not mix with the store database
 *   7. the clock never claims a server time it was not given
 */
import { createFakeIndexedDB } from './fake-indexeddb.mjs';

/**
 * Resolves a file inside the repo's js/ directory. import.meta.url is already a
 * correctly percent-encoded file:// URL, so relative resolution is enough — no
 * path juggling (the source folder name is Arabic, which is exactly why).
 */
const js = (rel) => new URL(`../js/${rel}`, import.meta.url).href;
const readSrc = (rel) => import('node:fs').then((fs) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'));

/* ------------------------------------------------------------------ *
 * Tiny runner
 * ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
const failures = [];

function ok(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ''}`);
  }
}

function eq(label, actual, expected) {
  ok(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(title) {
  console.log(`\n${title}`);
}

/** Removes block and line comments so assertions can look at code, not prose. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/* ------------------------------------------------------------------ *
 * 1 · Logical app version
 * ------------------------------------------------------------------ */

const version = await import(js('version.js'));

section('1 · logical app version');
{
  const v = version.getAppVersion();
  ok('returns a string', typeof v === 'string');
  ok(
    'is a semantic version (MAJOR.MINOR.PATCH)',
    /^\d+\.\d+\.\d+$/.test(v),
    `got "${v}"`
  );
  eq('APP_VERSION matches getAppVersion()', version.APP_VERSION, v);
  ok('has no SW-style "v" prefix', !/^v/i.test(v), `got "${v}"`);

  // The whole point of the module: it must not be the service worker BUILD.
  const sw = await readSrc('sw.js');
  const build = (sw.match(/const BUILD = '([^']+)'/) || [])[1];
  ok('service worker still has a BUILD id', Boolean(build), `BUILD=${build}`);
  ok('logical version is NOT the SW BUILD', build !== v, `version="${v}" BUILD="${build}"`);

  eq('parseVersion reads the parts', JSON.stringify(version.parseVersion('2.10.3')), JSON.stringify({ major: 2, minor: 10, patch: 3 }));
  eq('parseVersion tolerates "v1.2.3"', JSON.stringify(version.parseVersion('v1.2.3')), JSON.stringify({ major: 1, minor: 2, patch: 3 }));
  eq('parseVersion tolerates junk without throwing', JSON.stringify(version.parseVersion('nope')), JSON.stringify({ major: 0, minor: 0, patch: 0 }));
  eq('compareVersions: older', version.compareVersions('1.0.0', '1.0.1'), -1);
  eq('compareVersions: newer', version.compareVersions('1.1.0', '1.0.9'), 1);
  eq('compareVersions: equal', version.compareVersions('1.0.0', '1.0.0'), 0);
  ok('isAtLeast includes the same version', version.isAtLeast('1.0.0', '1.0.0'));
  ok('isAtLeast rejects an older version', !version.isAtLeast('1.0.0', '1.0.1'));
  ok('isNewer detects an available update', version.isNewer('1.0.0', '1.1.0'));
  ok('isNewer ignores an older candidate', !version.isNewer('1.1.0', '1.0.0'));
}

/* ------------------------------------------------------------------ *
 * 2 · Platform detection
 * ------------------------------------------------------------------ */

const platform = await import(js('platform.js'));

section('2 · platform detection');
{
  // No Capacitor bridge at all: this is the normal web/PWA case and it must not
  // throw, because the web build ships no bridge and never will.
  ok('no bridge is present in this runtime', typeof globalThis.window === 'undefined' || !globalThis.window.Capacitor);
  eq('falls back to "web"', platform.getPlatform(), platform.PLATFORM_WEB);
  ok('isWeb() is true', platform.isWeb());
  eq('PLATFORMS lists web', platform.PLATFORMS.includes(platform.PLATFORM_WEB), true);

  const info = platform.platformInfo();
  eq('platformInfo.platform is web', info.platform, platform.PLATFORM_WEB);
  eq('platformInfo.isWeb is true', info.isWeb, true);
  eq('platformInfo.isNative is false', info.isNative, false);
  eq('platformInfo.appVersion is the logical version', info.appVersion, version.getAppVersion());

  // Nothing identifying may appear in the payload the backend will receive.
  const keys = Object.keys(info).sort().join(',');
  eq('platformInfo carries only platform + version facts', keys, 'appVersion,isNative,isWeb,platform');

  // A native shell must be recognised through the existing abstraction.
  globalThis.window = {
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
    },
  };
  eq('android shell detected', platform.getPlatform(), platform.PLATFORM_ANDROID);
  ok('isWeb() is false natively', !platform.isWeb());
  eq('platformInfo.isNative is true', platform.platformInfo().isNative, true);

  globalThis.window.Capacitor.getPlatform = () => 'ios';
  eq('ios shell detected', platform.getPlatform(), platform.PLATFORM_IOS);

  // A bridge that cannot answer must yield 'unknown', never a confident guess.
  globalThis.window.Capacitor.getPlatform = () => { throw new Error('bridge busy'); };
  eq('unreportable shell is "unknown"', platform.getPlatform(), platform.PLATFORM_UNKNOWN);

  delete globalThis.window.Capacitor;
  delete globalThis.window;
  eq('back to web after the bridge goes away', platform.getPlatform(), platform.PLATFORM_WEB);
}

/* ------------------------------------------------------------------ *
 * 3 · Identity database opens
 * ------------------------------------------------------------------ */

const storehub = await import(js('identity-store.js'));
const fakeIdb = createFakeIndexedDB();

section('3 · identity database');
{
  eq('database name is its own, not saher_db', storehub.IDENTITY_DB_NAME, 'storehub_identity');
  ok('database name differs from the store database', storehub.IDENTITY_DB_NAME !== 'saher_db');

  storehub.configureIdentity({ indexedDB: fakeIdb, name: 'test_identity' });
  const db = await storehub.getIdentityDb();
  ok('opens successfully', Boolean(db));

  for (const name of Object.values(storehub.IDENTITY_STORES)) {
    ok(`object store "${name}" exists`, db.objectStoreNames.contains(name));
  }

  const summary = await storehub.readIdentitySummary();
  ok('summary reads on a fresh database', Boolean(summary) && (summary.device === undefined || summary.device === null));
  eq('fresh account is null', summary.account, null);
  eq('fresh licence is null', summary.license, null);

  const meta = await storehub.ensureMeta();
  ok('meta row written', Boolean(meta && meta.schema));
}

/* ------------------------------------------------------------------ *
 * 4 + 5 · Install id: created once, then stable
 * ------------------------------------------------------------------ */

section('4 · install id is created on first use');
let firstInstallId = null;
{
  firstInstallId = await storehub.getInstallId();
  ok('an install id is returned', typeof firstInstallId === 'string' && firstInstallId.length > 0);
  ok(
    'looks like a v4 uuid',
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(firstInstallId),
    `got "${firstInstallId}"`
  );
  ok('is not a fingerprint of anything', !/android|iphone|windows|mac|user|device/i.test(firstInstallId));

  const record = await storehub.getDeviceRecord();
  eq('it is persisted in the identity database', record.installId, firstInstallId);
  ok('a creation timestamp was recorded', Boolean(record.createdAt));
}

section('5 · install id is stable afterwards');
{
  const again = await storehub.getInstallId();
  eq('a second call returns the same value', again, firstInstallId);

  const many = await Promise.all([storehub.getInstallId(), storehub.getInstallId(), storehub.getInstallId()]);
  ok('concurrent callers all get the same value', many.every((v) => v === firstInstallId));

  // The real test of "stable between runs": a brand new module instance with no
  // memory of the first call, reading the same database. This is what an app
  // restart actually looks like.
  const restarted = await import(`${js('identity-store.js')}?restart=1`);
  restarted.configureIdentity({ indexedDB: fakeIdb, name: 'test_identity' });
  const afterRestart = await restarted.getInstallId();
  eq('survives a module reload (simulated app restart)', afterRestart, firstInstallId);

  // And two distinct random ids must not collide.
  const a = restarted.randomInstallId();
  const b = restarted.randomInstallId();
  ok('two generated ids differ', a !== b, `both were "${a}"`);
}

/* ------------------------------------------------------------------ *
 * 6 · Identity metadata never mixes with store data
 * ------------------------------------------------------------------ */

section('6 · identity metadata stays out of the store database');
{
  // Build a stand-in for the real store database in the same fake, then write to
  // identity and confirm the store database is untouched and the reverse.
  const storeDb = await new Promise((resolve, reject) => {
    const req = fakeIdb.open('saher_db', 4);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('products', { keyPath: 'id' });
      req.result.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  await new Promise((resolve, reject) => {
    const tx = storeDb.transaction(['products'], 'readwrite');
    tx.objectStore('products').put({ id: 'p1', name: 'قميص', price: 50 });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });

  await storehub.saveAccountRecord({ googleSub: '1234567890', email: 'shop@example.com', displayName: 'متجري' });
  await storehub.saveLicenseRecord({ licenseId: 'SH-TEST', status: 'active', lastVerifiedAt: '2026-10-03T00:00:00.000Z', lastServerTime: 1_757_000_000_000 });
  await storehub.savePlatformInfo({ platform: 'web' });

  const storeNames = new Set([...fakeIdb.databases().keys()]);
  ok('store database exists in the fake', storeNames.has('saher_db'));
  ok('identity database exists in the fake', storeNames.has('test_identity'));
  ok('they are two separate databases', storeNames.size === 2, `saw: ${[...storeNames].join(', ')}`);

  const readProduct = await new Promise((resolve, reject) => {
    const tx = storeDb.transaction(['products'], 'readonly');
    const req = tx.objectStore('products').get('p1');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  eq('the store record is byte-identical after identity writes', readProduct.name, 'قميص');
  ok('identity wrote nothing into the store database', !('installId' in readProduct));
  ok('store database has no identity stores', !storeDb.objectStoreNames.contains('account'));
  ok('store database has no license store', !storeDb.objectStoreNames.contains('license'));

  // The reverse direction: clearing identity must not touch store data.
  await storehub.clearIdentityData();
  const stillThere = await new Promise((resolve, reject) => {
    const tx = storeDb.transaction(['products'], 'readonly');
    const req = tx.objectStore('products').get('p1');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  eq('clearing identity leaves store data alone', stillThere.name, 'قميص');

  const reopened = await storehub.readIdentitySummary();
  eq('identity really was cleared (device)', reopened.device, null);
  eq('identity really was cleared (account)', reopened.account, null);

  // And the real module's own guard: exportAll() in db.js enumerates saher_db.
  const dbjs = await readSrc('js/db.js');
  ok('db.js still defines its own database', /const DB_NAME = 'saher_db'/.test(dbjs));
  ok(
    'db.js never references the identity database',
    !dbjs.includes('storehub_identity'),
    'found a reference to storehub_identity inside db.js'
  );
  const idsrc = await readSrc('js/identity-store.js');
  // The prose in the header deliberately names saher_db to explain WHY the two
  // databases are separate, so the check has to look at code, not comments.
  const idCode = stripComments(idsrc);
  ok('identity-store.js code never names the store database', !idCode.includes('saher_db'));
  ok(
    'identity-store.js does not import the store data layer',
    !/from\s+['"]\.\/db\.js['"]/.test(idsrc),
    'identity-store.js imports db.js'
  );
  ok(
    'the store data layer is not imported by the identity layer',
    !/from\s+['"]\.\/identity-store\.js['"]/.test(dbjs)
  );
}

/* ------------------------------------------------------------------ *
 * 7 · Clock honesty
 * ------------------------------------------------------------------ */

const clock = await import(js('clock.js'));

section('7 · clock does not invent a server time');
{
  clock.resetTrustedTime();
  ok('no trusted time at first', !clock.hasTrustedTime());
  eq('estimatedServerTime() is null, not Date.now()', clock.estimatedServerTime(), null);
  eq('clockSkewMs() is null', clock.clockSkewMs(), null);
  ok('isClockSuspect() is false with nothing to compare', !clock.isClockSuspect());

  const before = Date.now();
  const local = clock.localTime();
  ok('localTime() works and is near the wall clock', local >= before - 5 && local <= Date.now() + 5);
  ok('estimatedServerTime() is STILL null after reading local time', clock.estimatedServerTime() === null);

  eq('rejects a non-numeric server time', clock.setTrustedServerTime('1757000000000'), false);
  eq('rejects NaN', clock.setTrustedServerTime(Number.NaN), false);
  eq('rejects a non-positive instant', clock.setTrustedServerTime(0), false);
  ok('a rejected value does not become trusted', !clock.hasTrustedTime());

  const serverTime = Date.now() - 5 * 60 * 1000; // server is 5 minutes behind
  ok('accepts a valid server time', clock.setTrustedServerTime(serverTime));
  ok('now it is trusted', clock.hasTrustedTime());
  const est = clock.estimatedServerTime();
  ok('estimate tracks the server value, not the device clock', Math.abs(est - serverTime) < 2000, `est=${est} server=${serverTime}`);
  ok('estimate is ~5 minutes behind the device clock', Math.abs(clock.clockSkewMs()) > 4 * 60 * 1000);
  ok('a large skew is reported as suspect', clock.isClockSuspect());

  clock.resetTrustedTime();
  ok('reset returns the module to knowing nothing', !clock.hasTrustedTime());
  eq('and the estimate is null again', clock.estimatedServerTime(), null);
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

console.log(`\n${'='.repeat(56)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log('='.repeat(56));
process.exit(failed === 0 ? 0 : 1);