/**
 * Identity / install / licence metadata, in its OWN IndexedDB database.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Why this is not another object store in `saher_db`
 * ─────────────────────────────────────────────────────────────────────────
 * `db.js` exports `exportAll()`, which builds the store's backup file by
 * reading all seven stores of `saher_db`. If identity lived in an eighth
 * store, then identity would be one edit away from being swept into every
 * customer backup — and, worse, `importAll()` could write licence state back
 * onto a device. A separate database makes that impossible rather than merely
 * discouraged: `exportAll()` enumerates `saher_db`, so it physically cannot
 * reach anything stored here. The separation is structural, not a convention
 * someone has to remember.
 *
 * It also gives the two databases independent lifecycles. "Clear app data" or
 * a wiped browser must not silently de-license a customer, and restoring a
 * backup must not rewrite entitlement.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * What is NOT here, and must not be
 * ─────────────────────────────────────────────────────────────────────────
 *   - Store data. Products, sales, invoices, suppliers, reports, settings.
 *     Those live in `saher_db` and never travel to a licence backend.
 *   - Google's access token or refresh token. There is no Google sign-in yet.
 *     When there is, the plan is to exchange the Google ID token for a
 *     backend-issued session, so no long-lived Google secret is parked here.
 *     This module deliberately has no field for one.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * What a record here does NOT mean
 * ─────────────────────────────────────────────────────────────────────────
 * An `account` record is not proof that anyone is signed in. It is a local
 * cache of "this install was last associated with this Google subject". There
 * is no authentication here yet, so nothing in this file may be read as
 * "the user is authenticated" — the licence phase will need a live check, and
 * that is precisely why the module offers no `isAuthenticated()`.
 */

/** The identity database name. Intentionally NOT `saher_db`. */
export const IDENTITY_DB_NAME = 'storehub_identity';

/** Schema version. Bump only when the shape below actually changes. */
export const IDENTITY_DB_VERSION = 1;

/**
 * Object stores. Each holds exactly one record, keyed by a fixed `key`, so
 * "the current account" is a lookup rather than a query.
 */
export const IDENTITY_STORES = Object.freeze({
  /** Schema bookkeeping only. */
  meta: 'meta',
  /** Google's stable subject id, email, display name — placeholders for now. */
  account: 'account',
  /** This install: install_id and the platform it runs on. */
  device: 'device',
  /** Entitlement cache: licence id, status, and verification timestamps. */
  license: 'license',
  /** Auth session: backend-issued session token and expiry. */
  authSession: 'authSession',
});

const RECORD_KEY = 'current';
const META_KEY = 'schema';

let options = null;
let dbPromise = null;

/**
 * Points the module at an IndexedDB implementation and database name.
 *
 * Injectable for a reason beyond testing: it is the only way this file can be
 * exercised in plain Node, and it is the seam a future in-memory or
 * non-IndexedDB fallback would use. In the app it is simply never called.
 *
 * @param {{indexedDB?: IDBFactory, name?: string, version?: number}} [next]
 */
export function configureIdentity(next = {}) {
  const idb = next.indexedDB || (typeof globalThis !== 'undefined' ? globalThis.indexedDB : undefined);
  options = {
    indexedDB: idb,
    name: next.name || IDENTITY_DB_NAME,
    version: next.version || IDENTITY_DB_VERSION,
  };
  dbPromise = null;
  return options;
}

/** Forgets the cached connection so the next call re-opens (or re-fails). */
export function resetIdentityConnection() {
  if (dbPromise) {
    dbPromise.then((db) => db.close()).catch(() => {});
  }
  dbPromise = null;
}

/** @returns {object|null} the active configuration, if any. */
export function identityConfig() {
  return options ? { ...options } : null;
}

/**
 * Opens the identity database, creating its stores on first run.
 * @returns {Promise<IDBDatabase>}
 */
export async function getIdentityDb() {
  if (dbPromise) return dbPromise;
  if (!options) configureIdentity();

  const { indexedDB: idb, name, version } = options;
  if (!idb || typeof idb.open !== 'function') {
    throw new Error('IndexedDB is unavailable — identity metadata cannot be stored');
  }

  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = idb.open(name, version);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of Object.values(IDENTITY_STORES)) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // A newer tab upgrading the schema must not leave this one holding a
      // connection that blocks it.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('identity database failed to open'));
    req.onblocked = () => reject(new Error('identity database is blocked by another tab'));
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });

  return dbPromise;
}

/** Wraps a request in a promise. */
function fromRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('identity database request failed'));
  });
}

/** Runs `fn` inside one transaction and resolves when it commits. */
async function withStore(storeNames, mode, fn) {
  const db = await getIdentityDb();
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(storeNames, mode);
    } catch (err) {
      reject(err);
      return;
    }
    let out;
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error || new Error('identity transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('identity transaction aborted'));
    Promise.resolve(fn(tx))
      .then((value) => {
        out = value;
      })
      .catch((err) => {
        try {
          tx.abort();
        } catch {
          /* already finished */
        }
        reject(err);
      });
  });
}

/**
 * Reads the single record in `store`.
 *
 * IndexedDB answers a miss with `undefined` rather than `null`, which is an easy
 * trap for a caller writing `if (record.googleSub)`. Normalised here so every
 * read in this module means the same thing: an object, or null.
 */
async function readRecord(store) {
  const db = await getIdentityDb();
  const tx = db.transaction(store, 'readonly');
  const found = await fromRequest(tx.objectStore(store).get(RECORD_KEY));
  return found === undefined ? null : found;
}

/** Writes the single record in `store`, stamping it with `key`. */
async function writeRecord(store, value) {
  await withStore(store, 'readwrite', async (tx) => {
    tx.objectStore(store).put({ ...value, key: RECORD_KEY });
  });
  return value;
}

/** Removes the single record in `store`. */
async function deleteRecord(store) {
  await withStore(store, 'readwrite', async (tx) => {
    tx.objectStore(store).delete(RECORD_KEY);
  });
}

/* ------------------------------------------------------------------ *
 * Cryptographically strong random identifier
 * ------------------------------------------------------------------ */

/**
 * A random v4-shaped id from the platform CSPRNG.
 *
 * Never derived from anything about the device: not a fingerprint, not a
 * hostname, not a MAC address, not a timestamp. It is a random number, so it
 * identifies *this install* and carries no information about the person or the
 * hardware. Two installs get two unrelated ids.
 *
 * @returns {string}
 */
export function randomInstallId() {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('No cryptographically secure random source is available');
  }
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* ------------------------------------------------------------------ *
 * Install id
 * ------------------------------------------------------------------ */

/**
 * In-flight creation, so two callers racing at startup cannot each mint a
 * different id and leave one of them orphaned.
 * @type {Promise<string>|null}
 */
let installIdPending = null;

/**
 * This install's stable id, created on first call and reused forever after.
 *
 * "First call" rather than "first app launch" on purpose: nothing in the app
 * imports this yet, so generating an id during boot would mean adding a module
 * to the critical startup path for a value nobody reads. The id is created the
 * moment something actually needs it, and the phase that needs it also adds it
 * to the service worker's precache list.
 *
 * @returns {Promise<string>}
 */
export function getInstallId() {
  if (installIdPending) return installIdPending;
  installIdPending = (async () => {
    const existing = await getDeviceRecord();
    if (existing && typeof existing.installId === 'string' && existing.installId) {
      return existing.installId;
    }
    const installId = randomInstallId();
    await writeRecord(IDENTITY_STORES.device, {
      installId,
      createdAt: existing?.createdAt || new Date().toISOString(),
      lastSeenAt: null,
      platform: null,
      platformBuild: null,
    });
    return installId;
  })().catch((err) => {
    installIdPending = null;
    throw err;
  });
  return installIdPending;
}

/* ------------------------------------------------------------------ *
 * Records
 * ------------------------------------------------------------------ */

/** @returns {Promise<object|null>} the device record, or null. */
export function getDeviceRecord() {
  return readRecord(IDENTITY_STORES.device);
}

/**
 * Records the platform this install runs on. Not required for the install id,
 * so `getInstallId()` deliberately does not call it — that would make the
 * platform module a dependency of the identity database.
 *
 * @param {{platform?: string, platformBuild?: string}} info
 */
export async function savePlatformInfo(info = {}) {
  const existing = (await getDeviceRecord()) || {};
  await writeRecord(IDENTITY_STORES.device, {
    ...existing,
    platform: info.platform ?? existing.platform ?? null,
    platformBuild: info.platformBuild ?? existing.platformBuild ?? null,
    lastSeenAt: new Date().toISOString(),
  });
  return getDeviceRecord();
}

/**
 * @returns {Promise<object|null>} cached Google identity placeholders, or null.
 *   Presence is NOT authentication — see the file header.
 */
export function getAccountRecord() {
  return readRecord(IDENTITY_STORES.account);
}

/**
 * Stores Google's subject id / email / display name for this install.
 *
 * No token field exists here on purpose; see the file header.
 *
 * @param {{googleSub?: string, email?: string, displayName?: string}} patch
 */
export async function saveAccountRecord(patch = {}) {
  const existing = (await getAccountRecord()) || {};
  return writeRecord(IDENTITY_STORES.account, {
    ...existing,
    googleSub: patch.googleSub ?? existing.googleSub ?? null,
    email: patch.email ?? existing.email ?? null,
    displayName: patch.displayName ?? existing.displayName ?? null,
    updatedAt: new Date().toISOString(),
  });
}

/** Forgets the cached Google identity. Does not touch licence or install data. */
export function clearAccountRecord() {
  return deleteRecord(IDENTITY_STORES.account);
}

/** @returns {Promise<object|null>} cached licence metadata, or null. */
export function getLicenseRecord() {
  return readRecord(IDENTITY_STORES.license);
}

/**
 * Caches what a licence check returned, plus when it was verified and the
 * server timestamp it was verified against.
 *
 * `lastVerifiedAt` and `lastServerTime` are separate on purpose: the first is
 * the device's wall clock (for "how long have we been offline"), the second is
 * the server's (for "is it really expired"). The licence phase will need both
 * and must not conflate them.
 *
 * `linkedAccountId` stores the Google subject id that the licence is bound to.
 * It is a placeholder until the identity phase supplies real account ids.
 *
 * @param {{licenseId?: string, status?: string, expiresAt?: number|null,
 *          lastVerifiedAt?: string, lastServerTime?: number|null,
 *          linkedAccountId?: string|null}} patch
 */
export async function saveLicenseRecord(patch = {}) {
  const existing = (await getLicenseRecord()) || {};
  return writeRecord(IDENTITY_STORES.license, {
    ...existing,
    licenseId: patch.licenseId ?? existing.licenseId ?? null,
    status: patch.status ?? existing.status ?? null,
    expiresAt: patch.expiresAt ?? existing.expiresAt ?? null,
    lastVerifiedAt: patch.lastVerifiedAt ?? existing.lastVerifiedAt ?? null,
    lastServerTime: patch.lastServerTime ?? existing.lastServerTime ?? null,
    linkedAccountId: patch.linkedAccountId ?? existing.linkedAccountId ?? null,
  });
}

/** Forgets cached licence metadata. The install id survives. */
export function clearLicenseRecord() {
  return deleteRecord(IDENTITY_STORES.license);
}

/* ------------------------------------------------------------------ *
 * Auth session (backend-issued, not Google tokens)
 * ------------------------------------------------------------------ */

/**
 * @returns {Promise<object|null>} cached auth session, or null.
 *   Contains: sessionToken, expiresAt, googleSub, email, displayName, avatarUrl
 */
export function getAuthSession() {
  return readRecord(IDENTITY_STORES.authSession);
}

/**
 * Stores the auth session returned by the backend.
 *
 * @param {{sessionToken: string, expiresAt: number, googleSub: string, email: string, displayName?: string, avatarUrl?: string}} session
 */
export async function saveAuthSession(session) {
  return writeRecord(IDENTITY_STORES.authSession, {
    ...session,
    updatedAt: new Date().toISOString(),
  });
}

/** Clears the auth session. Does not touch account or licence data. */
export function clearAuthSession() {
  return deleteRecord(IDENTITY_STORES.authSession);
}

/** @returns {Promise<boolean>} true if a valid (non-expired) auth session exists. */
export async function hasValidAuthSession() {
  const session = await getAuthSession();
  if (!session || !session.sessionToken) return false;
  if (session.expiresAt && Date.now() >= session.expiresAt) {
    await clearAuthSession();
    return false;
  }
  return true;
}

/**
 * Everything in the identity database, in one round trip.
 *
 * A fresh database returns `{ device: null, account: null, license: null, authSession: null }` —
 * the same shape as a populated one, so a caller never has to distinguish
 * "nothing stored yet" from "missing key".
 *
 * @returns {Promise<{device: object|null, account: object|null, license: object|null, authSession: object|null}>}
 */
export async function readIdentitySummary() {
  const db = await getIdentityDb();
  const names = [IDENTITY_STORES.device, IDENTITY_STORES.account, IDENTITY_STORES.license, IDENTITY_STORES.authSession];
  const tx = db.transaction(names, 'readonly');
  const found = await Promise.all(names.map((n) => fromRequest(tx.objectStore(n).get(RECORD_KEY))));
  const [device, account, license, authSession] = found.map((v) => (v === undefined ? null : v));
  return { device, account, license, authSession };
}

/**
 * Deletes the whole identity database.
 *
 * A developer/test tool ("start over on this device"), and the right behaviour
 * for a future "sign out" — it must not touch `saher_db`.
 *
 * @returns {Promise<void>}
 */
export async function clearIdentityData() {
  resetIdentityConnection();
  if (!options) configureIdentity();
  const { indexedDB: idb, name } = options;
  if (!idb || typeof idb.deleteDatabase !== 'function') return;
  await new Promise((resolve, reject) => {
    const req = idb.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error || new Error('identity database could not be deleted'));
    req.onblocked = () => resolve(); // another tab will finish the job
  });
  dbPromise = null;
  installIdPending = null;
}

/** Writes the schema bookkeeping row. Idempotent. */
export async function ensureMeta() {
  const existing = await readRecord(IDENTITY_STORES.meta);
  if (existing && existing.version === options?.version) return existing;
  return writeRecord(IDENTITY_STORES.meta, {
    schema: META_KEY,
    version: options?.version || IDENTITY_DB_VERSION,
    createdAt: existing?.createdAt || new Date().toISOString(),
  });
}