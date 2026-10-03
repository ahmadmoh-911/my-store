/**
 * The ONE logical Store Hub version.
 *
 * Store Hub is a single product shipped two ways — a web/PWA and an Android
 * APK — and those two builds are technically different (one runs a service
 * worker, the other has none; one has a versionName, the other has a cache
 * key). They are still the same product at the same release, so they must be
 * able to agree on a version number. This module is that single agreement.
 *
 * Why this is NOT the service worker's BUILD number:
 *   sw.js `BUILD` ('v13') is a *cache identity*. It changes whenever cached
 *   bytes change — including for reasons that have nothing to do with a
 *   release, such as swapping an icon file. Reporting it to a customer or to a
 *   licence backend as "the app version" would mean the app claims a new
 *   version every time an asset is re-encoded. It is an implementation detail
 *   and it stays inside sw.js.
 *
 * Rules for this file:
 *   - APP_VERSION is the only place a Store Hub version is written down.
 *   - It is a plain semantic version string (MAJOR.MINOR.PATCH).
 *   - Nothing may import it to *branch* on behaviour. It exists to be read,
 *     displayed and reported — not to gate features.
 */

/** The logical Store Hub release. Semantic version, no build metadata here. */
export const APP_VERSION = '1.0.0';

/**
 * The version, as a plain string.
 *
 * A function rather than only a constant so that callers can be written today
 * against a stable API even if the source of the number later moves (for
 * instance into a build-generated file, so the Android versionName can be
 * derived from the same value instead of being typed by hand).
 *
 * @returns {string}
 */
export function getAppVersion() {
  return APP_VERSION;
}

/**
 * Splits a semantic version into comparable numbers.
 *
 * Deliberately forgiving: a missing or malformed part reads as 0 rather than
 * throwing, because a version arriving from a server or an old install must
 * never be able to crash the app on a string comparison. Build metadata
 * (`+...`) and pre-release markers (`-...`) are not interpreted — Store Hub
 * does not use them, and guessing at their precedence rules would be worse
 * than ignoring them.
 *
 * @param {string} value
 * @returns {{major:number, minor:number, patch:number}}
 */
export function parseVersion(value) {
  const text = typeof value === 'string' ? value.trim().replace(/^v/i, '').split('+')[0].split('-')[0] : '';
  const parts = text.split('.');
  const num = (i) => {
    const n = Number.parseInt(parts[i], 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  return { major: num(0), minor: num(1), patch: num(2) };
}

/**
 * Compares two versions.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} -1 if a < b, 0 if equal, 1 if a > b.
 */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (const part of ['major', 'minor', 'patch']) {
    if (x[part] !== y[part]) return x[part] < y[part] ? -1 : 1;
  }
  return 0;
}

/**
 * True when `current` is the same as, or newer than, `required`.
 *
 * This is the comparison an update notice or a minimum-supported-version check
 * will need. It is provided now so that whoever builds those features does not
 * invent a second, subtly different comparison.
 *
 * @param {string} current
 * @param {string} required
 * @returns {boolean}
 */
export function isAtLeast(current, required) {
  return compareVersions(current, required) >= 0;
}

/**
 * True when `candidate` is strictly newer than `current` — i.e. an update is
 * available.
 *
 * @param {string} current
 * @param {string} candidate
 * @returns {boolean}
 */
export function isNewer(current, candidate) {
  return compareVersions(candidate, current) > 0;
}