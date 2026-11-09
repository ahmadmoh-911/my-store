/**
 * The interim date-code gate — behaviour, boundaries and tamper handling.
 *
 * Everything here drives `js/interim-activation.js` with a clock the test
 * controls, because the interesting behaviour is what happens at 29 days, at
 * 30 days, and when the phone's clock is moved. The state lives in a fake
 * `localStorage`; the module's in-memory fallback is deliberately NOT used so
 * the storage path itself (the one a real APK uses) is the path under test.
 *
 * The last section is the rule that matters most: the gate must never be able
 * to touch, delete or hide shop data.
 */

import { createFakeLocalStorage } from './fake-localstorage.mjs';

const js = (rel) => new URL(`../js/${rel}`, import.meta.url).href;
const readSrc = (rel) =>
  import('node:fs').then((fs) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'));

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
  if (Object.is(actual, expected)) {
    ok(label, true);
    return;
  }
  ok(label, false, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(title) {
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------------ *
 * The environment the module will see
 * ------------------------------------------------------------------ */

const fakeStorage = createFakeLocalStorage();
globalThis.localStorage = fakeStorage;
// Required by js/data-transfer.js, which this file imports further down to
// prove the two modules agree about what is excluded from a backup.
globalThis.indexedDB = (await import('./fake-indexeddb.mjs')).createFakeIndexedDB();

const act = await import(js('interim-activation.js'));

/** Fresh storage before each case, so no case can be polluted by the last. */
function reset() {
  fakeStorage.clear();
  act.resetInterimGateCache();
}

const DAY = 86400000;
const at = (iso) => new Date(iso);

/* ================================================================== *
 * 1 · the code is the date, MMDDYYYY, local
 * ================================================================== */

section('1 · the code is today\'s date in MMDDYYYY form');

{
  eq('17 Oct 2026 renders as 10172026', act.codeForDate(at('2026-10-17T09:00:00')), '10172026');
  eq('1 Jan 2026 pads to 01012026', act.codeForDate(at('2026-01-01T00:00:00')), '01012026');
  eq('31 Dec 2025 renders as 12312025', act.codeForDate(at('2025-12-31T23:59:59')), '12312025');
  eq('the code is always eight digits', act.codeForDate(at('2026-03-04T12:00:00')).length, 8);

  const codes = act.acceptedCodes(at('2026-10-17T12:00:00'));
  eq('three codes are accepted', codes.length, 3);
  ok('today is among them', codes.includes('10172026'));
  ok('yesterday is among them', codes.includes('10162026'));
  ok('tomorrow is among them', codes.includes('10182026'));
  ok('the day after tomorrow is not', !codes.includes('10192026'));

  // Across a month boundary the "yesterday" must step back a month, not to day 0.
  const monthEdge = act.acceptedCodes(at('2026-11-01T12:00:00'));
  ok('the month boundary is handled', monthEdge.includes('10312026'), monthEdge.join(','));

  // Across a year boundary too.
  const yearEdge = act.acceptedCodes(at('2027-01-01T12:00:00'));
  ok('the year boundary is handled', yearEdge.includes('12312026'), yearEdge.join(','));
}

/* ================================================================== *
 * 2 · what the user may type
 * ================================================================== */

section('2 · what the user may type');

{
  const now = at('2026-10-17T12:00:00');
  ok('today is accepted', act.isAcceptedCode('10172026', now));
  ok('yesterday is accepted', act.isAcceptedCode('10162026', now));
  ok('tomorrow is accepted', act.isAcceptedCode('10182026', now));
  ok('the day after tomorrow is refused', !act.isAcceptedCode('10192026', now));
  ok('a seven-digit code is refused', !act.isAcceptedCode('1012026', now));
  ok('a nine-digit code is refused', !act.isAcceptedCode('101720266', now));
  ok('an empty code is refused', !act.isAcceptedCode('', now));
  ok('null is refused without throwing', !act.isAcceptedCode(null, now));
  ok('undefined is refused without throwing', !act.isAcceptedCode(undefined, now));
  ok('letters are refused', !act.isAcceptedCode('abcdefgh', now));

  // Separators are stripped rather than rejected: an owner copying "10/17/2026"
  // out of a message should not be told their code is wrong.
  ok('a slashed date is normalised, not rejected', act.isAcceptedCode('10/17/2026', now));
  ok('spaces are stripped too', act.isAcceptedCode('10 17 2026', now));
  eq('normalisation keeps digits only', act.normalizeCode(' 10/17/2026 '), '10172026');
}

/* ================================================================== *
 * 3 · activation, and the 30 days it buys
 * ================================================================== */

section('3 · a correct code buys exactly 30 days');

{
  reset();
  const t0 = at('2026-10-17T10:00:00');

  const rejected = act.activateWithCode('00000000', t0);
  eq('a wrong code is refused', rejected.ok, false);
  eq('with a clear Arabic message', rejected.message, 'الكود غير صحيح');
  eq('and NOTHING is written to storage', act.readRaw(), null);

  const accepted = act.activateWithCode('10172026', t0);
  eq('the right code is accepted', accepted.ok, true);
  eq('and reports 30 days', accepted.daysRemaining, 30);

  const rec = act.readActivation();
  ok('a record now exists', rec !== null);
  eq('with the activation moment', rec.activatedAt, t0.getTime());
  eq('and the same moment as last-seen', rec.lastSeenAt, t0.getTime());

  eq('on day 0 there are 30 days left', act.evaluateActivation(t0).daysRemaining, 30);
  eq('on day 1 there are 29', act.evaluateActivation(new Date(t0.getTime() + DAY)).daysRemaining, 29);
  eq('on day 29 there is 1', act.evaluateActivation(new Date(t0.getTime() + 29 * DAY)).daysRemaining, 1);

  // The boundary is inclusive of the last instant and exclusive at 30 days.
  eq('one millisecond before expiry it is still active',
    act.evaluateActivation(new Date(t0.getTime() + 30 * DAY - 1)).active, true);
  const expired = act.evaluateActivation(new Date(t0.getTime() + 30 * DAY));
  eq('exactly 30 days later it is finished', expired.active, false);
  eq('and the reason is expiry', expired.reason, 'expired');
  eq('with no days remaining', expired.daysRemaining, 0);

  // Renewal: a fresh code starts a fresh 30 days from the moment it is typed.
  const later = new Date(t0.getTime() + 31 * DAY);
  const renewed = act.activateWithCode(act.codeForDate(later), later);
  eq('after expiry a new code is accepted', renewed.ok, true);
  eq('and 30 fresh days are granted', renewed.daysRemaining, 30);
  eq('measured from the new code', act.readActivation().activatedAt, later.getTime());
  eq('so 30 days are still ahead', act.evaluateActivation(later).daysRemaining, 30);

  // An expired activation is not erased: keeping it is what lets the tamper
  // check keep working, and it is proof nothing is cleaned up behind the owner.
  const after = act.readActivation();
  ok('the record is never deleted on expiry', after !== null);
}

/* ================================================================== *
 * 4 · the clock cannot be moved backwards
 * ================================================================== */

section('4 · a rolled-back clock closes the gate');

{
  reset();
  const t0 = at('2026-10-17T10:00:00');
  act.activateWithCode('10172026', t0);

  // The device has been used up to five days after activation.
  act.touchActivation(new Date(t0.getTime() + 5 * DAY));

  // …and now the clock is put three days BEFORE activation: eight days behind
  // the newest moment we ever saw.
  const rolledBack = new Date(t0.getTime() - 3 * DAY);
  const res = act.evaluateActivation(rolledBack);
  eq('the gate is closed', res.active, false);
  eq('the reason is the clock, not expiry', res.reason, 'clock');

  // A rollback of half a day is inside tolerance: time zones and a DST change
  // must not lock a paying customer out of their own shop.
  const mild = act.evaluateActivation(new Date(t0.getTime() + 5 * DAY - 12 * 3600 * 1000));
  eq('half a day of drift is tolerated', mild.active, true);

  // The suspect moment must NOT be written into the record: recording it would
  // launder the lie and the check would agree with it next time.
  const before = act.readActivation().lastSeenAt;
  act.refreshInterimGate(rolledBack);
  eq('a suspect clock does not advance last-seen', act.readActivation().lastSeenAt, before);
  eq('and the gate stays closed', act.refreshInterimGate(rolledBack).active, false);

  // Once the clock is put right, the gate opens again with no data lost.
  const restored = act.evaluateActivation(new Date(t0.getTime() + 6 * DAY));
  eq('putting the clock right re-opens the gate', restored.active, true);
}

/* ================================================================== *
 * 5 · the cache the router reads
 * ================================================================== */

section('5 · the synchronous answer the router depends on');

{
  reset();
  const t0 = at('2026-10-17T10:00:00');
  eq('with no record the gate is locked', act.isInterimUnlocked(), false);

  act.activateWithCode('10172026', t0);
  eq('after a correct code it is unlocked', act.isInterimUnlocked(), true);

  // A locked gate must report locked even before anything has refreshed it.
  reset();
  eq('a fresh session with no record starts locked', act.isInterimUnlocked(), false);
  act.lockInterimGate();
  eq('and stays locked after an explicit lock', act.isInterimUnlocked(), false);
}

/* ================================================================== *
 * 6 · the rule that matters most: the gate never touches shop data
 * ================================================================== */

section('6 · the gate cannot touch, delete or hide shop data');

{
  const src = await readSrc('js/interim-activation.js');
  // The claims are about CODE, not prose: the header deliberately talks about
  // shop data at length, and it would be absurd for a correct comment to fail
  // a check. Comments are stripped before the source is inspected.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  ok('it never imports the database', !/from\s+['"][^'"]*db\.js['"]/.test(code));
  ok('it never names IndexedDB', !/indexedDB/i.test(code));
  ok('it never calls fetch', !/\bfetch\b/.test(code));
  ok('it never mentions shop records',
    !/product|sale|invoice|supplier|purchase/i.test(code));
  ok('it has no delete/clear/remove path for the record either',
    !/(delete|remove|clear)\w*\s*\(/i.test(code));

  // And the cross-module contract: the key it uses is reserved, so the backup
  // layer strips it and an activation can never travel (or re-lock) with a file.
  const xfer = await import(js('data-transfer.js'));
  ok('its storage key carries the reserved prefix',
    act.ACTIVATION_STORAGE_KEY.startsWith(act.ACTIVATION_KEY_PREFIX));
  ok('and the backup layer treats that prefix as reserved',
    xfer.isReservedStorageKey(act.ACTIVATION_STORAGE_KEY));
}

/* ================================================================== *
 * Summary
 * ================================================================== */

console.log(`\n${'='.repeat(56)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log('='.repeat(56));

process.exitCode = failed === 0 ? 0 : 1;
