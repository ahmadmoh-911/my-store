/**
 * Clock and time-trust, separated from `Date.now()`.
 *
 * Why this exists: the licence check will eventually have to answer "has this
 * licence expired?", and the honest answer cannot come from the device's own
 * clock. A shop owner can change the phone's date, and every phone clock drifts.
 * So the time that decides entitlement has to come from the licence server, and
 * the device clock is only ever allowed to estimate *how long we have been
 * offline* — never *whether we are entitled*.
 *
 * The rule this module exists to enforce: **local time is never presented as
 * server time.** Until a trusted server time has been handed in, every function
 * that would answer "what time is it, really?" returns null or says so. A
 * licence check written later cannot accidentally trust the device clock,
 * because the trusted value is not available to it until something sets it.
 *
 * There is no backend yet. Nothing here contacts a network, and nothing here
 * grants or denies anything — this is the arithmetic and the storage, ready for
 * the phase that will feed it a real server response.
 */

/** What a caller receives when no trusted time has been established. */
export const NO_TRUSTED_TIME = null;

/**
 * Where the elapsed-time estimate comes from.
 *
 * `performance.now()` is monotonic and cannot be moved by changing the system
 * date, so it is the right anchor *within* a session. It resets when the app
 * restarts, which is why a wall-clock fallback exists at all.
 */
function monotonicNow() {
  const p = globalThis.performance;
  if (p && typeof p.now === 'function') {
    try {
      return { value: p.now(), monotonic: true };
    } catch {
      /* fall through to the wall clock */
    }
  }
  return { value: Date.now(), monotonic: false };
}

/**
 * The anchor we hung the trusted server time on.
 * @type {{serverTime:number, anchor:number, monotonic:boolean, recordedAtWall:number}|null}
 */
let anchor = null;

/**
 * The device's own wall clock, which is NOT trusted.
 *
 * @returns {number} ms since epoch, straight from the device.
 */
export function localTime() {
  return Date.now();
}

/**
 * True once a trusted server time has been supplied.
 *
 * @returns {boolean}
 */
export function hasTrustedTime() {
  return anchor !== null;
}

/**
 * Hands the module a server timestamp to trust from now on.
 *
 * Called by whatever receives the licence response in a later phase — not by
 * this file, and never with the device's own clock. Storing a device timestamp
 * here is the one mistake that would make the whole abstraction a lie, so the
 * argument is validated rather than trusted: a non-finite or non-positive
 * value is rejected instead of silently poisoning the anchor.
 *
 * @param {number} serverTimeMs epoch milliseconds as reported by the server.
 * @returns {boolean} true if the value was accepted.
 */
export function setTrustedServerTime(serverTimeMs) {
  if (typeof serverTimeMs !== 'number' || !Number.isFinite(serverTimeMs) || serverTimeMs <= 0) return false;
  const m = monotonicNow();
  anchor = {
    serverTime: Math.floor(serverTimeMs),
    anchor: m.value,
    monotonic: m.monotonic,
    recordedAtWall: Date.now(),
  };
  return true;
}

/**
 * The best available estimate of true current time, or null if there is none.
 *
 * The estimate advances from the trusted value by elapsed *monotonic* time, so
 * changing the phone's date cannot move it. When the app restarts the monotonic
 * counter resets; past a session we fall back to advancing by wall-clock
 * elapsed time, which is the best that can be done without a server — and is
 * exactly why `hasTrustedTime()` and the licence phase must re-anchor on every
 * successful check rather than trusting a stored estimate from a previous run.
 *
 * @returns {number|null} epoch ms, or null when no server time is known.
 */
export function estimatedServerTime() {
  if (!anchor) return NO_TRUSTED_TIME;
  const m = monotonicNow();
  if (m.monotonic && anchor.monotonic) {
    const elapsed = m.value - anchor.anchor;
    // A negative or absurd delta means the anchor came from a different process
    // (or a restored snapshot). Rather than return a nonsense instant, decline.
    if (elapsed < 0 || elapsed > 1000 * 60 * 60 * 24 * 400) return NO_TRUSTED_TIME;
    return anchor.serverTime + elapsed;
  }
  // Cross-session fallback: wall clock, clamped so it can never run backwards
  // past the moment we last knew the true time.
  const elapsed = Date.now() - anchor.recordedAtWall;
  if (elapsed < 0) return anchor.serverTime;
  if (elapsed > 1000 * 60 * 60 * 24 * 400) return NO_TRUSTED_TIME;
  return anchor.serverTime + elapsed;
}

/**
 * How far the device clock is believed to be from true time.
 *
 * Positive means the device clock is ahead of the server.
 *
 * @returns {number|null} ms, or null when there is nothing to compare against.
 */
export function clockSkewMs() {
  const est = estimatedServerTime();
  if (est === NO_TRUSTED_TIME) return NO_TRUSTED_TIME;
  return Date.now() - est;
}

/**
 * True when the device clock is far enough from the server to be suspicious.
 *
 * A threshold, not a verdict: a few minutes of drift is normal, and locking a
 * shop out over a 30-second skew would be absurd. The licence phase decides what
 * to do about a large skew; this only reports it.
 *
 * @param {number} [toleranceMs=60000]
 * @returns {boolean} false when there is no trusted time to compare against.
 */
export function isClockSuspect(toleranceMs = 60000) {
  const skew = clockSkewMs();
  if (skew === NO_TRUSTED_TIME) return false;
  return Math.abs(skew) > toleranceMs;
}

/**
 * Forgets the trusted time.
 *
 * Used by tests, and by the day the licence phase decides a stored estimate is
 * too stale to keep trusting. After this, the module is back to admitting it
 * knows nothing — which is the safe direction to fail in.
 */
export function resetTrustedTime() {
  anchor = null;
}

/**
 * The raw anchor, for tests and diagnostics. Not for feature logic.
 * @returns {object|null}
 */
export function _trustedAnchor() {
  return anchor ? { ...anchor } : null;
}