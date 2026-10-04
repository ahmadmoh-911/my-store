/**
 * When a backup runs, and what happens when it does.
 *
 * ──────────────────────────────────────────��──────────────────────────────
 * Backup, not sync
 * ─────────────────────────────────────────────────────────────────────────
 * There is no timer in this file, and that is the design rather than an
 * omission. Store Hub is offline-first: the till must open and work in a shop
 * with no signal, on a tablet that has been asleep for a week, with the network
 * radio switched off. A background synchroniser would be the first thing to make
 * that slow, to consume battery, and to hold the UI open while it waited.
 *
 * So the only trigger is the moment the app opens, the gates below are checked,
 * and if the week is up a backup happens once. That is a *snapshot on a schedule*,
 * not a mirror of the shop. Nothing here merges, reconciles, or pushes local
 * edits in either direction, and nothing here ever runs while the app is closed.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * The gates, and why each one is separate
 * ─────────────────────────────────────────────────────────────────────────
 * A shop that is offline, unlicensed, or has not connected Drive must not see a
 * warning, a spinner, or a failed state. Backup is a background comfort feature;
 * every gate that says "no" is silent. Only a *failed attempt* is recorded and
 * shown, because a backup that quietly never happens is indistinguishable from a
 * backup that is not working.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Failure is recorded, not retried in a loop
 * ─────────────────────────────────────────────────────────────────────────
 * A failed backup leaves `lastSuccessAt` alone. That is what makes the retry
 * correct: the week is still up, so the next eligible launch tries again instead
 * of waiting another seven days after a failure it already knows about.
 */

import { createBackup, prepareRestore, serialiseBackup, backupByteLength, BACKUP_VERSION } from './backup.js';
import { ensureBackupFolder, publishLatestBackup, fetchLatestBackup } from './drive-client.js';
import { saveBackupRecord } from './identity-store.js';

/** One week, in milliseconds. The interval the phase brief specifies. */
export const BACKUP_INTERVAL_DAYS = 7;
export const BACKUP_INTERVAL_MS = BACKUP_INTERVAL_DAYS * 24 * 60 * 60 * 1000;

/**
 * Why a backup did not run.
 *
 * Every value here is a *silent* outcome. `Settings` shows a connection state
 * and a last-backup date; it does not show a complaint because the shop was
 * offline at launch.
 */
export const SKIP = Object.freeze({
  /** The feature is switched off by configuration. */
  DISABLED: 'disabled',
  /** No network. Expected, not a fault. */
  OFFLINE: 'offline',
  /** Not signed in to Google, so there is no shop identity to back up for. */
  NOT_AUTHENTICATED: 'not_authenticated',
  /** Entitlement does not permit normal operation. */
  NOT_ENTITLED: 'not_entitled',
  /** Signed in, but Drive has never been connected for this account. */
  DRIVE_NOT_CONNECTED: 'drive_not_connected',
  /** Less than a week since the last successful backup. */
  NOT_DUE: 'not_due',
  /** A run is already in flight in this tab. */
  ALREADY_RUNNING: 'already_running',
});

/** Status values persisted in the backup record. */
export const BACKUP_STATUS = Object.freeze({
  NEVER: 'never',
  RUNNING: 'running',
  OK: 'ok',
  ERROR: 'error',
});

/**
 * When the next backup falls due, or null if one has never succeeded.
 *
 * @param {{lastSuccessAt?: string|null}} record
 * @returns {number|null} epoch ms
 */
export function nextDueAt(record) {
  if (!record?.lastSuccessAt) return null;
  const last = Date.parse(record.lastSuccessAt);
  if (Number.isNaN(last)) return null;
  return last + BACKUP_INTERVAL_MS;
}

/**
 * How much of the week is left, for display.
 *
 * @param {{lastSuccessAt?: string|null}} record
 * @param {number} now
 * @returns {number|null} days remaining, 0 when due
 */
export function daysUntilDue(record, now) {
  const due = nextDueAt(record);
  if (due === null) return null;
  return Math.max(0, Math.ceil((due - now) / (24 * 60 * 60 * 1000)));
}

/**
 * The decision, with no side effects at all.
 *
 * Pure, so the schedule is testable without a network, a clock, or a database —
 * and so a bug in the gate order shows up as a wrong return value rather than as
 * an unwanted upload.
 *
 * @param {{
 *   record?: object|null,
 *   online: boolean,
 *   authenticated: boolean,
 *   entitled: boolean,
 *   driveConnected: boolean,
 *   enabled?: boolean,
 *   now: number,
 *   forced?: boolean,
 *   running?: boolean,
 * }} input
 * @returns {{shouldRun: boolean, reason: string, dueAt: number|null}}
 */
export function planBackup(input) {
  const {
    record = null,
    online,
    authenticated,
    entitled,
    driveConnected,
    enabled = true,
    now,
    forced = false,
    running = false,
  } = input;

  const dueAt = nextDueAt(record);
  // Ordered cheapest-and-most-likely first. `enabled` before anything else
  // because nothing should even be inspected on a disabled deployment; `online`
  // next because it is the gate a shop in a basement hits every single launch.
  const stop = (reason) => ({ shouldRun: false, reason, dueAt });
  if (!enabled) return stop(SKIP.DISABLED);
  if (running) return stop(SKIP.ALREADY_RUNNING);
  if (!online) return stop(SKIP.OFFLINE);
  if (!authenticated) return stop(SKIP.NOT_AUTHENTICATED);
  if (!entitled) return stop(SKIP.NOT_ENTITLED);
  if (!driveConnected) return stop(SKIP.DRIVE_NOT_CONNECTED);
  if (dueAt !== null && now < dueAt && !forced) {
    // A forced run — the button in Settings — overrides the week, which is the
    // entire difference between it and the automatic launch. Every other gate
    // still applies: a shop that is offline, unlicensed or has no Drive
    // connection cannot back up just because someone tapped a button.
    return stop(SKIP.NOT_DUE);
  }
  return { shouldRun: true, reason: 'due', dueAt, forced };
}

/**
 * Carries out one backup: build, validate, upload, verify, replace.
 *
 * Every step that can fail leaves the previous backup exactly as it was — that
 * guarantee lives in `publishLatestBackup`, which is the only thing that
 * touches Drive. Local data is only ever read here.
 *
 * @param {{
 *   db: object,
 *   accessToken: string,
 *   appVersion?: string,
 *   fetchImpl?: Function,
 *   folderName?: string,
 *   now?: () => number,
 * }} deps
 * @returns {Promise<{fileId: string, folderId: string, bytes: number, counts: object, createdAt: string}>}
 * @throws when the backup could not be produced, uploaded or verified
 */
export async function performBackup(deps) {
  const {
    db,
    accessToken,
    appVersion = 'unknown',
    fetchImpl,
    folderName,
    now = () => Date.now(),
  } = deps;

  const createdAt = new Date(now()).toISOString();

  // 1 · Read the shop and wrap it. `exportAll` is read-only; nothing here can
  //     modify local data, which is why a failure at any later step cannot have
  //     damaged it.
  const envelope = await createBackup(db, { appVersion, createdAt });

  // 2 · Validate what we are about to send. A backup that cannot be read back is
  //     worse than no backup, because it displaces a good one — so this runs
  //     before the upload, not after.
  const checked = prepareRestore(envelope);
  if (!checked.ok) {
    const err = new Error(`النسخة الاحتياطية غير صالحة: ${checked.message}`);
    err.code = checked.code;
    throw err;
  }

  const body = serialiseBackup(envelope);

  // 3 · Upload and verify. Drive owns the ordering guarantee: the previous file
  //     is deleted only once the new one is confirmed readable at the right size.
  const folder = await ensureBackupFolder({ token: accessToken, fetchImpl, folderName });
  const published = await publishLatestBackup({
    token: accessToken,
    fetchImpl,
    folderName,
    folderId: folder.id,
    body,
  });

  return {
    fileId: published.fileId,
    folderId: folder.id,
    bytes: backupByteLength(envelope),
    counts: envelope.counts,
    createdAt,
  };
}

/**
 * Fetches the current backup and prepares it for restore, touching nothing.
 *
 * @param {{accessToken: string, fetchImpl?: Function, folderName?: string}} deps
 * @returns {Promise<object>} the result of `prepareRestore`, or a failure
 */
export async function fetchPreparedBackup(deps) {
  return fetchLatestBackup(deps);
}

/**
 * The launch-time entry point.
 *
 * Never throws and never rejects: a caller in `main.js` must not need a
 * `try`/`catch` around a background comfort feature, and an unhandled rejection
 * here would surface as a crash on a shopkeeper's screen.
 *
 * @param {{
 *   db: object,
 *   record?: object|null,
 *   enabled?: boolean,
 *   online?: boolean,
 *   authenticated?: boolean,
 *   entitled?: boolean,
 *   driveConnected?: boolean,
 *   getAccessToken: () => Promise<string>,
 *   appVersion?: string,
 *   fetchImpl?: Function,
 *   folderName?: string,
 *   now?: () => number,
 *   saveRecord?: (patch: object) => Promise<object>,
 *   forced?: boolean,
 *   running?: boolean,
 * }} deps
 * @returns {Promise<{ok: boolean, reason: string, result?: object, error?: string}>}
 */
export async function maybeRunBackup(deps) {
  const {
    db,
    record = null,
    enabled = true,
    online,
    authenticated,
    entitled,
    driveConnected,
    getAccessToken,
    appVersion = 'unknown',
    fetchImpl,
    folderName,
    now = () => Date.now(),
    saveRecord = saveBackupRecord,
    forced = false,
    running = false,
  } = deps;

  const plan = planBackup({
    record,
    online,
    authenticated,
    entitled,
    driveConnected,
    enabled,
    now: now(),
    forced,
    running,
  });

  if (!plan.shouldRun) {
    return { ok: false, reason: plan.reason, skipped: true };
  }

  const attemptAt = new Date(now()).toISOString();
  // Marked before the work, so a second launch in another tab can see that a run
  // is in flight. `lastSuccessAt` is deliberately *not* touched here.
  await saveRecord({
    status: BACKUP_STATUS.RUNNING,
    lastAttemptAt: attemptAt,
    // Cleared up front so a stale failure does not sit on screen during the run
    // and then survive a success.
    lastError: null,
  });

  try {
    const accessToken = await getAccessToken();
    const result = await performBackup({ db, accessToken, appVersion, fetchImpl, folderName, now });

    await saveRecord({
      status: BACKUP_STATUS.OK,
      // Only now, and only on a confirmed upload. This is the single line that
      // makes the weekly schedule honest.
      lastSuccessAt: result.createdAt,
      lastAttemptAt: attemptAt,
      lastError: null,
      folderId: result.folderId,
      fileId: result.fileId,
      bytes: result.bytes,
      formatVersion: BACKUP_VERSION,
      counts: result.counts,
    });

    return { ok: true, reason: 'completed', result };
  } catch (err) {
    // Local data is untouched and the previous Drive backup is still there, so
    // this is a record and nothing more. `lastSuccessAt` is left alone on
    // purpose: the week is still up, and the next eligible launch will retry.
    const message = String(err?.message || err).slice(0, 300);
    await saveRecord({
      status: BACKUP_STATUS.ERROR,
      lastAttemptAt: attemptAt,
      lastError: message,
    });
    return { ok: false, reason: 'failed', error: message, skipped: false };
  }
}

export default {
  BACKUP_INTERVAL_DAYS,
  BACKUP_INTERVAL_MS,
  SKIP,
  BACKUP_STATUS,
  nextDueAt,
  daysUntilDue,
  planBackup,
  performBackup,
  fetchPreparedBackup,
  maybeRunBackup,
};