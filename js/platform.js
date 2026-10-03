/**
 * Which runtime is this copy of Store Hub running in?
 *
 * Store Hub ships as one product in two shapes: a web/PWA in a browser, and an
 * Android APK inside a Capacitor WebView. Later, the licence backend has to be
 * told which one it is talking to (`platform` + `appVersion` in every request).
 * This module is the single place that answers that question.
 *
 * Design notes, because the obvious version of this file is a trap:
 *
 *   - It does NOT probe the user agent. UA sniffing is a guess dressed up as a
 *     fact, and the whole point of the Capacitor shell is that it looks like a
 *     browser. `native.js` already owns the one authoritative test for "am I in
 *     the shell" — `isNative()` — so this reuses it instead of inventing a
 *     second opinion that can disagree with the rest of the app.
 *
 *   - It does NOT assume Capacitor exists. The web build ships no bridge at all
 *     (`native.js` reads it off `window.Capacitor` precisely because the plugin
 *     packages are not part of the web bundle). Everything here therefore has to
 *     work, unchanged, with no bridge present — which is the normal case for
 *     every PWA install.
 *
 *   - It is read-only and has no side effects. Asking what platform we are on
 *     must never change what the app does.
 */
import { isNative, nativePlatform } from './native.js';
import { getAppVersion } from './version.js';

/** A browser (or an installed PWA) — the default, and the only case on web. */
export const PLATFORM_WEB = 'web';
/** The Android APK inside the Capacitor shell. */
export const PLATFORM_ANDROID = 'android';
/** An iOS shell, if one is ever added. Declared so the set is closed. */
export const PLATFORM_IOS = 'ios';
/**
 * A native shell that would not say which platform it is.
 *
 * A distinct value rather than a guess: if the bridge ever fails to answer,
 * the licence backend should be told the truth and treat it as an unknown
 * platform, not be handed a confident "android" for an iPhone.
 */
export const PLATFORM_UNKNOWN = 'unknown';

/** Every value `getPlatform()` can return. */
export const PLATFORMS = [PLATFORM_WEB, PLATFORM_ANDROID, PLATFORM_IOS, PLATFORM_UNKNOWN];

/**
 * The current platform id.
 *
 * @returns {string} one of PLATFORMS.
 */
export function getPlatform() {
  if (!isNative()) return PLATFORM_WEB;
  const reported = nativePlatform();
  if (reported === PLATFORM_ANDROID || reported === PLATFORM_IOS) return reported;
  return PLATFORM_UNKNOWN;
}

/**
 * True in a plain browser or installed PWA.
 *
 * @returns {boolean}
 */
export function isWeb() {
  return getPlatform() === PLATFORM_WEB;
}

/**
 * Everything the licence backend will need to know about this install's build.
 *
 * Grouped in one function so the payload the backend eventually receives is
 * defined in exactly one place, and cannot quietly grow a field that should
 * never leave the device. Note what is NOT here: no store name, no product or
 * sale counts, no identifiers of any kind. Platform and version describe the
 * *software*; they say nothing about the shop.
 *
 * @returns {{platform: string, isNative: boolean, isWeb: boolean, appVersion: string}}
 */
export function platformInfo() {
  const platform = getPlatform();
  return {
    platform,
    isNative: isNative(),
    isWeb: platform === PLATFORM_WEB,
    appVersion: getAppVersion(),
  };
}