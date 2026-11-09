/**
 * Interim date-code gate — the temporary protection for the `interim` build.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW STRONG IS THIS? (Read this before relying on it.)
 * ─────────────────────────────────────────────────────────────────────────
 * It is deliberately, openly, VERY weak protection.
 *
 * The code is the date shown on the device's own clock, in MMDDYYYY form. Any
 * user who reads the screen, or the calendar, or asks anyone the date, can
 * type it. This only stops a copy of the app being opened by someone who is
 * not even looking for a code, and it buys time until the real licence and
 * Google sign-in go into the same code base. It is a locked door with a
 * paper sign, not a vault. Do not present it to a customer as security.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * The rules it has to keep
 * ─────────────────────────────────────────────────────────────────────────
 *  1. The code is TODAY, `MMDDYYYY`, digits only, in the device's own local
 *     time. Yesterday and tomorrow are accepted too, so a two-hour timezone
 *     difference cannot lock a customer out of their own phone.
 *  2. A correct code stores `activatedAt` and buys exactly 30 days from that
 *     moment. There is no permanent "on" flag: after 30 days the gate asks for
 *     a new code, and a new code restarts 30 fresh days from when it is typed.
 *  3. Clock rollback is caught by remembering the newest time we have ever
 *     seen (`lastSeenAt`) and comparing against it: if the device clock is
 *     more than a day BEHIND that, the activation is treated as finished.
 *  4. **The gate never touches shop data.** Not on expiry, not on a bad code,
 *     not on a corrupt or missing record. It stores nothing but its own one
 *     record, and it reads nothing but its own one record. Losing this gate —
 *     or never passing it — must never cost a shop owner a product, a sale or
 *     an invoice. That is a hard rule, not a nicety: their money is in there.
 *  5. Its own record is a localStorage entry with a reserved key prefix, which
 *     js/data-transfer.js is required to leave out of every backup file. A
 *     backup therefore carries no activation state and never re-locks a device
 *     that restores one.
 */

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** Reserved storage key. `data-transfer.js` excludes anything with this prefix. */
export const ACTIVATION_STORAGE_KEY = 'saher.interim.activation.v1';

/** Reserved localStorage prefix — excluded from every backup file. */
export const ACTIVATION_KEY_PREFIX = 'saher.interim.';

/** Days a correct code buys, exactly. */
export const ACTIVATION_TTL_DAYS = 30;
export const ACTIVATION_TTL_MS = ACTIVATION_TTL_DAYS * 86400000;

/** How far behind `lastSeenAt` the clock may sit before it is suspect. */
export const CLOCK_BACK_TOLERANCE_MS = 86400000; // 1 day

const RECORD_VERSION = 1;

/* ------------------------------------------------------------------ *
 * Storage
 *
 * localStorage when there is one, an in-memory Map when there is not. The
 * fallback is not decoration: it is what lets this module — and the gate
 * tests — run inside Node, which has no `localStorage`.
 * ------------------------------------------------------------------ */

const memory = new Map();

function backend() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch {
    // A browser can hand us a localStorage that throws on *access* (private
    // mode, blocked cookies). Falling through to memory is the safe answer.
  }
  return null;
}

export function readRaw() {
  const s = backend();
  if (!s) return memory.get(ACTIVATION_STORAGE_KEY) ?? null;
  try {
    return s.getItem(ACTIVATION_STORAGE_KEY);
  } catch {
    return memory.get(ACTIVATION_STORAGE_KEY) ?? null;
  }
}

function writeRaw(value) {
  memory.set(ACTIVATION_STORAGE_KEY, value);
  const s = backend();
  if (!s) return;
  try {
    s.setItem(ACTIVATION_STORAGE_KEY, value);
  } catch {
    // Quota or a blocked store: the in-memory copy still covers this session,
    // and the shop data is untouched either way. Never throw from here.
  }
}

/* ------------------------------------------------------------------ *
 * The code itself
 * ------------------------------------------------------------------ */

const pad2 = (n) => String(n).padStart(2, '0');

/** `MMDDYYYY` for a local date — 17 Oct 2026 → `10172026`. */
export function codeForDate(date) {
  return `${pad2(date.getMonth() + 1)}${pad2(date.getDate())}${date.getFullYear()}`;
}

/** Midnight of `date`, local. */
function midnight(date, dayDelta = 0) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + dayDelta);
}

/**
 * The codes that count right now: today, yesterday, tomorrow — each rendered
 * from LOCAL midnight so daylight-saving edges cannot shift the day.
 *
 * @param {Date} [now]
 * @returns {string[]} three `MMDDYYYY` strings, today first
 */
export function acceptedCodes(now = new Date()) {
  return [0, -1, 1].map((delta) => codeForDate(midnight(now, delta)));
}

/** Keeps digits only. Anything else the user types (a space, a slash) is dropped. */
export function normalizeCode(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw).replace(/[^0-9]/g, '');
}

/**
 * Is `raw` one of the accepted codes for `now`?
 *
 * @param {string} raw  what the user typed
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isAcceptedCode(raw, now = new Date()) {
  const code = normalizeCode(raw);
  if (code.length !== 8) return false; // MMDDYYYY is exactly eight digits
  return acceptedCodes(now).includes(code);
}

/* ------------------------------------------------------------------ *
 * The record
 * ------------------------------------------------------------------ */

/** @returns {{v:number, activatedAt:number, lastSeenAt:number}|null} */
export function readActivation() {
  const raw = readRaw();
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw);
    if (!rec || typeof rec !== 'object' || typeof rec.activatedAt !== 'number') return null;
    if (typeof rec.lastSeenAt !== 'number') rec.lastSeenAt = rec.activatedAt;
    return rec;
  } catch {
    // A corrupt record is treated as no record: the gate simply asks for a code
    // again. It is never an error the shop owner has to see, and it never
    // touches anything else.
    return null;
  }
}

function writeActivation(rec) {
  writeRaw(JSON.stringify({ ...rec, v: RECORD_VERSION }));
}

/**
 * The decision, as a pure function of the clock and the stored record.
 *
 * Split out from the reading and the writing so it can be tested with a clock
 * the test controls — the whole point of the tamper rule is what happens when
 * the clock is a lie.
 *
 * @param {Date} now
 * @param {{v:number, activatedAt:number, lastSeenAt:number}|null} [rec]
 * @returns {{active:boolean, reason:'ok'|'never'|'expired'|'clock', daysRemaining:number, activatedAt:number|null, expiresAt:number|null}}
 */
export function evaluateActivation(now = new Date(), rec = readActivation()) {
  const t = now.getTime();
  const base = { active: false, daysRemaining: 0, activatedAt: null, expiresAt: null };

  if (!rec) return { ...base, reason: 'never' };

  // Clock tamper first: if the device is more than a day BEHIND the newest
  // time we ever saw, it is either rolled back or lying. Either way the 30
  // days cannot be trusted, so the gate closes.
  if (rec.lastSeenAt - t > CLOCK_BACK_TOLERANCE_MS) {
    return { ...base, reason: 'clock', activatedAt: rec.activatedAt, expiresAt: rec.activatedAt + ACTIVATION_TTL_MS };
  }

  const expiresAt = rec.activatedAt + ACTIVATION_TTL_MS;
  if (t >= expiresAt) {
    return { ...base, reason: 'expired', activatedAt: rec.activatedAt, expiresAt };
  }

  const msLeft = expiresAt - t;
  return {
    active: true,
    reason: 'ok',
    // Never report "0 days" while there is still time left on the clock.
    daysRemaining: Math.max(1, Math.ceil(msLeft / 86400000)),
    activatedAt: rec.activatedAt,
    expiresAt,
  };
}

/**
 * Remembers that we have seen this moment, so a later rollback can be caught.
 *
 * Deliberately refuses to record a time that is BEHIND `lastSeenAt`: writing a
 * backwards clock into the record would launder the lie and make the tamper
 * check agree with it. Also refuses to record anything at all when there is no
 * activation to defend.
 *
 * @param {Date} [now]
 * @returns {object|null} the stored record, or null when there is none
 */
export function touchActivation(now = new Date()) {
  const rec = readActivation();
  if (!rec) return null;
  const t = now.getTime();
  if (t > rec.lastSeenAt) {
    rec.lastSeenAt = t;
    writeActivation(rec);
  }
  return rec;
}

/**
 * Reads the current state, records the moment, and keeps the cached answer the
 * router can check without going near IndexedDB or the network.
 *
 * Order matters and is not incidental: the state is EVALUATED before the
 * moment is recorded, otherwise recording `lastSeenAt = now` first would erase
 * the very difference the tamper rule exists to detect. And when the reason is
 * `'clock'` the moment is not recorded at all, so the record keeps its lead
 * over the lying clock until the clock is put right.
 *
 * @param {Date} [now]
 * @returns {{active:boolean, reason:string, daysRemaining:number, activatedAt:number|null, expiresAt:number|null}}
 */
export function refreshInterimGate(now = new Date()) {
  const res = evaluateActivation(now);
  if (res.reason !== 'clock') touchActivation(now);
  cachedUnlocked = res.active;
  return res;
}

/**
 * Enters the gate as locked — used after a code is rejected so the next route
 * change is answered from memory instead of re-reading storage.
 */
export function lockInterimGate() {
  cachedUnlocked = false;
}

/** @type {boolean|null} null until the first read. */
let cachedUnlocked = null;

/**
 * Synchronous answer for the router's guard: "may routes other than the gate
 * be shown?". Reads the stored record lazily the first time.
 *
 * @returns {boolean}
 */
export function isInterimUnlocked() {
  if (cachedUnlocked === null) cachedUnlocked = evaluateActivation().active;
  return cachedUnlocked;
}

/**
 * Forgets the cached answer. Tests and nothing else: the app has no "lock"
 * action, because a lock that could be triggered at runtime could be triggered
 * while the owner is standing in the middle of a sale.
 */
export function resetInterimGateCache() {
  cachedUnlocked = null;
}

/**
 * Accepts a code the user typed and starts a fresh 30 days.
 *
 * On success the record is rewritten with BOTH timestamps set to `now`. That
 * reset is deliberate: `lastSeenAt` guards the days bought by the *previous*
 * activation, and carrying an older, forward-dated value across would condemn
 * a legitimate new activation as a tampered clock forever.
 *
 * On failure nothing is written at all — the record, and every byte of shop
 * data, is left exactly as it was.
 *
 * @param {string} raw  what the user typed
 * @param {Date} [now]
 * @returns {{ok:true, message:string, daysRemaining:number, expiresAt:number} |
 *           {ok:false, message:string}}
 */
export function activateWithCode(raw, now = new Date()) {
  if (!isAcceptedCode(raw, now)) {
    return { ok: false, message: 'الكود غير صحيح' };
  }
  const t = now.getTime();
  const rec = { v: RECORD_VERSION, activatedAt: t, lastSeenAt: t };
  writeActivation(rec);
  cachedUnlocked = true;
  return {
    ok: true,
    message: 'تم التفعيل',
    daysRemaining: ACTIVATION_TTL_DAYS,
    expiresAt: t + ACTIVATION_TTL_MS,
  };
}

/**
 * What the Settings screen shows under "التفعيل": how many days are left, or
 * why there are none. Purely informational.
 *
 * @param {Date} [now]
 */
export function activationStatus(now = new Date()) {
  return evaluateActivation(now);
}
