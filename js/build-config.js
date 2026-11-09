/**
 * Build-mode switch — one flag, two shipped shapes of the same code.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Why this file exists
 * ─────────────────────────────────────────────────────────────────────────
 * Store Hub ships from ONE code base in two shapes:
 *
 *   'full'    the normal build — licence checks, Google sign-in, Drive backup.
 *   'interim' a temporary build handed to a customer while that backend is not
 *             reachable yet. It must never talk to a server and must never show
 *             an error caused by the absence of one.
 *
 * `MODE` is the single flag that decides which shape a given build is. Nothing
 * else in the app may ask "is this interim?" by any other means — not by user
 * agent, not by probing a URL, not by reading another module. One flag, read
 * here, so flipping it back to 'full' removes the interim behaviour from the
 * whole application in a single line.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * RULES — do not break these
 * ─────────────────────────────────────────────────────────────────────────
 *  1. `MODE` is a build-time constant. It is never written at runtime, never
 *     persisted to storage, never read from a URL or a user setting.
 *  2. In interim mode the app makes ZERO network requests on the launch path
 *     and on the sale path: no licence check, no `drive/status`, no `auth/me`.
 *     It must not redirect to the licence `activate` screen, and no toast or
 *     message caused by a missing server may reach the shop owner.
 *  3. The interim gate (js/interim-activation.js) decides ONLY whether the date
 *     code screen is shown. It may never delete, hide, disable or lock away a
 *     single byte of shop data — including when its own state is broken.
 *  4. Backup and restore (js/data-transfer.js) is deliberately NOT gated by
 *     `MODE`. A restore has to work in the interim build, in the future full
 *     build, and on a device that has never heard of this flag.
 */

/** The one build-mode constant. `'interim'` or `'full'`. */
export const MODE = 'interim';

export const MODE_INTERIM = 'interim';
export const MODE_FULL = 'full';

/**
 * @returns {boolean} true when this build is the temporary, server-less one.
 */
export const isInterim = () => MODE === MODE_INTERIM;
