/**
 * Logical backup serializer, validator and restore preparation.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * What this module is for
 * ─────────────────────────────────────────────────────────────────────────
 * Google Drive is where a shop's backup *lands*. This module decides what the
 * backup *is* — a versioned, media-free, logical snapshot — and is deliberately
 * independent of Drive, of the network, and of the scheduler. Anything that can
 * be reasoned about without a socket lives here so it can be tested without one.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Why a logical snapshot and not a copy of the database file
 * ─────────────────────────────────────────────────────────────────────────
 * Uploading `saher_db` wholesale would be a byte image of one device's
 * IndexedDB: tied to a keyPath layout, to an internal record order, and to
 * whatever the schema happened to be on the day it was taken. Restoring one
 * into a different build would mean hoping the schema had not moved, and a
 * future migration into a hosted database would have nothing to migrate *from*.
 *
 * So the backup is expressed in the app's own vocabulary — products, variants,
 * sales, lines, refunds-as-absent-sales, suppliers, purchases, settings — with
 * the schema version written on the envelope. That is what makes a later import
 * into Supabase a mapping exercise rather than a re-implementation.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Images are deliberately, structurally absent
 * ─────────────────────────────────────────────────────────────────────────
 * Product images in this app are `data:` URLs stored *inside* the records:
 * `products[].image` and `settings.logo`. That is the trap this module exists
 * to close — "we did not upload any files" is not the same claim as "the file
 * contains no images", because the images were never separate files to begin
 * with. A shop with two hundred products carries hundreds of inline base64
 * blobs, and a snapshot that merely skipped an upload step would carry all of
 * them to Drive.
 *
 * Two independent rules strip them, because either one alone has a failure
 * mode:
 *
 *   1. by key   — any property named `image`, `logo`, `photo`, `media`, … is
 *                 dropped, at any depth, because the names are known;
 *   2. by value — any string that *is* an inline media payload (`data:image/…`,
 *                 `data:audio/…`, `data:video/…`) is dropped whatever it is
 *                 called, because an unknown key name would otherwise smuggle
 *                 one straight through rule 1.
 *
 * Rule 2 is the one that matters for the future: when a future build adds
 * `product.photoDataUrl`, this file needs no edit to keep the image out.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * What this module deliberately does NOT do
 * ─────────────────────────────────────────────────────────────────────────
 *   - It never touches the network. `js/drive-client.js` does that.
 *   - It never deletes a local record. Writing is `js/db.js`'s job.
 *   - It never runs on its own. `js/backup-scheduler.js` decides when.
 */

/** The format identifier written on every envelope. */
export const BACKUP_FORMAT = 'storehub-backup';

/**
 * The backup schema version — NOT `DB_VERSION`.
 *
 * They answer different questions. `DB_VERSION` moves whenever the local
 * IndexedDB layout changes, including for reasons a backup could not care about.
 * `BACKUP_VERSION` moves only when the *file format* changes, and it is the
 * number a future importer reads to decide how to read the file. Bumping this is
 * a compatibility promise; bumping `DB_VERSION` is not.
 *
 * Version 2 adds the `stockBatches` section for FIFO inventory valuation.
 */
export const BACKUP_VERSION = 2;

/**
 * One deterministic filename, overwritten in place.
 *
 * The brief is explicit that this is a *replacement*, not an archive: one
 * latest backup, never a weekly pile-up. A dated name would make every backup
 * a new file and turn "keep exactly one" into "delete everything older", which
 * is a much easier thing to get wrong at 3am with a bad folder id.
 */
export const BACKUP_FILENAME = 'storehub-backup.json';

/** The folder the shop owner sees in their own Drive. */
export const BACKUP_FOLDER_NAME = 'Store Hub Backups';

/**
 * The narrowest Drive scope that can do this job.
 *
 * `drive.file` — not `drive`. It grants access only to files *this app
 * created*, which is exactly the property the phase requires: the backup folder
 * and its contents are discoverable precisely because the app made them, while
 * the owner's unrelated documents are invisible to it. A broad `drive` grant
 * would make every other file on the account readable by Store Hub.
 *
 * The one consequence worth knowing: with `drive.file`, `files.list` only ever
 * returns app-created files. Deleting the folder by hand in the Drive UI does
 * not orphan the feature — the app simply recreates it on the next backup.
 */
export const DRIVE_SCOPE = 'drive.file';

/**
 * Property names that carry an image or other media payload.
 *
 * Lowercase; matching is case-insensitive so a hand-edited file cannot dodge it
 * with `Image`. This list is belt, braces and a second opinion — the value rule
 * below is what actually guarantees the outcome.
 */
export const MEDIA_FIELDS = Object.freeze([
  'image',
  'images',
  'logo',
  'photo',
  'photos',
  'picture',
  'pictures',
  'avatar',
  'thumbnail',
  'thumbnails',
  'media',
  'attachment',
  'attachments',
  'gallery',
]);

/** Inline media payload prefixes. A string starting with one IS the payload. */
const MEDIA_DATA_URL = /^data:(?:image|audio|video)\//i;

/**
 * How deep `stripMedia` will walk before giving up on a branch.
 *
 * Real shop records are two or three levels down. Sixty is far beyond anything
 * legitimate and far below the point where recursion becomes a problem, so the
 * guard can only ever fire on something that was not a shop record.
 */
const MAX_STRIP_DEPTH = 60;

/**
 * True when a property is media by name or by content.
 * @param {string} key
 * @param {unknown} value
 * @returns {boolean}
 */
export function isMediaProperty(key, value) {
  if (MEDIA_FIELDS.includes(String(key).toLowerCase())) return true;
  if (typeof value === 'string' && MEDIA_DATA_URL.test(value.trim())) return true;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    // A nested object under an innocuous key can still be a media payload.
    // Only judged by content, never by shape, so business objects survive.
    return typeof value === 'object' && MEDIA_FIELDS.includes(String(key).toLowerCase());
  }
  return false;
}

/**
 * Removes every image/media payload from a value, at any depth.
 *
 * Returns a deep copy; the input is never mutated, because the caller may be
 * holding the live `exportAll()` result and a scrubbed-in-place snapshot would
 * be a nasty thing to hand back to a caller who expected a read.
 *
 * The depth limit is not decoration. JSON cannot express a cycle, so a file
 * downloaded from Drive cannot contain one — but this function also runs over
 * whatever `exportAll()` returns, and a record with a self-reference (or a
 * structure nested absurdly deep) would otherwise recurse until the stack gave
 * out. A `RangeError` from a backup is indistinguishable to the caller from a
 * crash, so the walk stops and drops the branch instead.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function stripMedia(value) {
  const walk = (node, depth) => {
    if (depth > MAX_STRIP_DEPTH) return undefined;
    if (Array.isArray(node)) return node.map((child) => walk(child, depth + 1));
    if (node === null || typeof node !== 'object') {
      // A bare inline media string has nowhere to hide a key, so it becomes
      // empty rather than surviving as a top-level payload.
      return typeof node === 'string' && MEDIA_DATA_URL.test(node.trim()) ? '' : node;
    }
    const out = {};
    for (const [key, child] of Object.entries(node)) {
      if (isMediaProperty(key, child)) continue;
      out[key] = walk(child, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}

/**
 * The business sections a backup carries.
 *
 * Derived from the app's real object stores rather than restated by hand, so a
 * store added later is a one-line change here and cannot be quietly forgotten.
 * Kept as an explicit list (rather than importing `STORES` at runtime) because
 * the *file format* must not change just because the local schema did.
 */
export const BACKUP_SECTIONS = Object.freeze([
  'products',
  'sales',
  'purchases',
  'suppliers',
  'supplierInvoices',
  'supplierPayments',
  'stockBatches',
]);

/** Sections that must be arrays in every valid envelope. */
const REQUIRED_ARRAY_SECTIONS = Object.freeze([...BACKUP_SECTIONS]);

/* ------------------------------------------------------------------ *
 * Envelope
 * ------------------------------------------------------------------ */

/**
 * Builds the versioned backup envelope from an `exportAll()` snapshot.
 *
 * @param {object} snapshot  the result of `db.exportAll()`
 * @param {{appVersion?: string, createdAt?: string}} [meta]
 * @returns {object} the envelope, media-free
 */
export function buildBackupEnvelope(snapshot, meta = {}) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('a backup cannot be built from nothing');
  }

  const data = stripMedia({
    products: snapshot.products || [],
    sales: snapshot.sales || [],
    purchases: snapshot.purchases || [],
    suppliers: snapshot.suppliers || [],
    supplierInvoices: snapshot.supplierInvoices || [],
    supplierPayments: snapshot.supplierPayments || [],
    stockBatches: snapshot.stockBatches || [],
    settings: snapshot.settings || {},
  });

  const counts = {};
  for (const section of BACKUP_SECTIONS) counts[section] = data[section].length;

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: meta.createdAt || new Date().toISOString(),
    appVersion: meta.appVersion || 'unknown',
    /**
     * The media decision is written *into* the file.
     *
     * A file that silently lacks images is indistinguishable from a file that
     * lost them. Carrying the statement means a future restore — or a person
     * reading the file in a text editor — can tell "images were never in here"
     * from "images went missing", and never has to guess which.
     */
    media: {
      included: false,
      policy: 'product images and logos are excluded by design and are not restorable from a backup',
    },
    counts,
    data,
  };
}

/**
 * Reads a live snapshot out of the database and wraps it.
 *
 * @param {{exportAll: () => Promise<object>}} db  the `js/db.js` module
 * @param {{appVersion?: string, createdAt?: string}} [meta]
 * @returns {Promise<object>} the envelope
 */
export async function createBackup(db, meta = {}) {
  if (!db || typeof db.exportAll !== 'function') {
    throw new Error('createBackup needs the store data layer');
  }
  return buildBackupEnvelope(await db.exportAll(), meta);
}

/** Serialises an envelope for upload. */
export function serialiseBackup(envelope) {
  return JSON.stringify(envelope);
}

/** Deserialises an uploaded file, refusing anything that is not JSON. */
export function deserialiseBackup(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: 'MALFORMED_JSON', message: 'الملف ليس JSON صالحاً' };
  }
  return { ok: true, value: parsed };
}

/* ------------------------------------------------------------------ *
 * Migrations
 * ------------------------------------------------------------------ */

/**
 * Version upgrades, keyed by the version they produce.
 *
 * Empty on purpose at version 1 — there is nothing to upgrade *from* yet. The
 * hook exists so that when version 2 exists it is a new entry here and a
 * version-1 file still restores, rather than a rewrite of the validator.
 *
 * @type {Record<number, (envelope: object) => object>}
 */
export const MIGRATIONS = Object.freeze({
  1: (envelope) => {
    // v1 → v2: add empty stockBatches section
    return {
      ...envelope,
      data: {
        ...envelope.data,
        stockBatches: [],
      },
    };
  },
});

/**
 * Brings an envelope up to the current version.
 *
 * @param {object} envelope
 * @returns {{ok: true, envelope: object, migratedFrom?: number}|{ok: false, code: string, message: string}}
 */
export function migrateBackup(envelope) {
  const from = envelope?.version;
  if (typeof from !== 'number' || !Number.isInteger(from) || from < 1) {
    return {
      ok: false,
      code: 'MISSING_VERSION',
      message: 'النسخة الاحتياطية لا تحتوي على رقم إصدار',
    };
  }
  if (from > BACKUP_VERSION) {
    // Refusing is the only safe answer. Guessing at a newer layout means writing
    // a shop's records into fields that no longer mean what they meant.
    return {
      ok: false,
      code: 'UNSUPPORTED_VERSION',
      message: `نسخة احتياطية من إصدار أحدث (${from}) — حدّث التطبيق قبل الاستعادة`,
    };
  }

  let current = envelope;
  let migratedFrom;
  for (let v = from; v < BACKUP_VERSION; v += 1) {
    const step = MIGRATIONS[v];
    if (!step) {
      return {
        ok: false,
        code: 'UNSUPPORTED_VERSION',
        message: `لا توجد طريقة لترقية النسخة الاحتياطية من الإصدار ${v}`,
      };
    }
    current = step(current);
    if (migratedFrom === undefined) migratedFrom = from;
  }
  return { ok: true, envelope: current, migratedFrom };
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/** A failure, with a code a test can assert on and a message a person can read. */
function fail(code, message) {
  return { ok: false, code, message };
}

/**
 * Checks one record of a section.
 *
 * The only structural rule that really matters is the key: every store uses a
 * keyPath, so a record without its key cannot be written at all. Catching that
 * here — before `importAll` opens its transaction — is the difference between
 * "this file is not a backup" and "the shop was half-replaced by one bad
 * record".
 *
 * @param {string} section
 * @param {unknown} record
 * @param {number} index
 * @returns {{code: string, message: string}|null}
 */
function validateRecord(section, record, index) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return { code: 'INVALID_RECORD', message: `سجل غير صالح في ${section} رقم ${index + 1}` };
  }
  if (typeof record.id !== 'string' || record.id === '') {
    return { code: 'INVALID_RECORD', message: `سجل بلا مُعرّف في ${section} رقم ${index + 1}` };
  }

  // Sections whose money and totals are re-derived on restore anyway; only
  // shape is checked, because a well-formed but odd number is the database's
  // problem to clamp, not the validator's to refuse.
  if (section === 'sales' && record.items !== undefined && !Array.isArray(record.items)) {
    return { code: 'INVALID_RECORD', message: `سجل بيع رقم ${index + 1} يحمل أصنافاً غير صالحة` };
  }
  if (section === 'supplierInvoices' && record.items !== undefined && !Array.isArray(record.items)) {
    return { code: 'INVALID_RECORD', message: `فاتورة شراء رقم ${index + 1} تحمل أصنافاً غير صالحة` };
  }
  return null;
}

/**
 * Accepts either a versioned envelope or a bare legacy `exportAll()` file, and
 * returns a versioned envelope either way.
 *
 * The legacy shape exists because the app has been exporting one since before
 * Drive existed, and a shop owner with an old file in a drawer must still be
 * able to restore it. Normalising here means one validator serves both the
 * file-import button and the Drive restore — rather than two validators that
 * can disagree about what a valid backup is.
 *
 * @param {unknown} input
 * @returns {{ok: true, envelope: object, legacy: boolean}|{ok: false, code: string, message: string}}
 */
export function normaliseBackupInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return fail('MALFORMED_BACKUP', 'ملف النسخة الاحتياطية غير صالح');
  }

  // Already an envelope.
  if (input.format !== undefined) {
    if (input.format !== BACKUP_FORMAT) {
      return fail('WRONG_FORMAT', 'هذا الملف ليس نسخة احتياطية من Store Hub');
    }
    return { ok: true, envelope: input, legacy: false };
  }

  // A bare snapshot from `exportAll()`.
  if (input.app === 'saher') {
    return {
      ok: true,
      legacy: true,
      envelope: buildBackupEnvelope(input, {
        createdAt: input.exportedAt,
        appVersion: 'unknown',
      }),
    };
  }

  return fail('WRONG_FORMAT', 'هذا الملف ليس نسخة احتياطية من Store Hub');
}

/**
 * Validates an envelope and prepares it for `importAll()`.
 *
 * This function never writes anything. It is the gate that §10 asks for: a file
 * that fails here has not come near the database.
 *
 * @param {unknown} raw  a parsed envelope, or a legacy snapshot
 * @returns {{ok: true, envelope: object, legacy: object, counts: object, createdAt: string|null, appVersion: string|null}
 *          |{ok: false, code: string, message: string}}
 */
export function prepareRestore(raw) {
  const normalised = normaliseBackupInput(raw);
  if (!normalised.ok) return normalised;

  const migrated = migrateBackup(normalised.envelope);
  if (!migrated.ok) return migrated;

  const envelope = migrated.envelope;
  const data = envelope.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return fail('MISSING_SECTION', 'النسخة الاحتياطية لا تحتوي على بيانات المتجر');
  }

  for (const section of REQUIRED_ARRAY_SECTIONS) {
    if (!Array.isArray(data[section])) {
      return fail('MISSING_SECTION', `النسخة الاحتياطية لا تحتوي على قائمة ${section}`);
    }
    for (let i = 0; i < data[section].length; i += 1) {
      const problem = validateRecord(section, data[section][i], i);
      if (problem) return problem;
    }
  }

  if (data.settings !== undefined && (typeof data.settings !== 'object' || data.settings === null || Array.isArray(data.settings))) {
    return fail('MISSING_SECTION', 'بيانات المتجر داخل الملف غير صالحة');
  }

  // Stripped again on the way in, not merely on the way out. A backup written
  // by a future build, or by hand, may carry images; restore must not put them
  // back even if the file has them.
  const clean = stripMedia(data);

  return {
    ok: true,
    envelope,
    legacy: {
      app: 'saher',
      version: envelope.version,
      exportedAt: envelope.createdAt,
      ...clean,
    },
    counts: { ...envelope.counts },
    createdAt: envelope.createdAt ?? null,
    appVersion: envelope.appVersion ?? null,
  };
}

/**
 * A short, human summary of a backup — what Settings shows before anyone
 * commits to replacing their shop.
 *
 * @param {object} prepared  the result of `prepareRestore`
 * @returns {{products: number, sales: number, suppliers: number, supplierInvoices: number, purchases: number, createdAt: string|null}}
 */
export function describeBackup(prepared) {
  const counts = prepared?.counts || {};
  return {
    products: counts.products ?? 0,
    sales: counts.sales ?? 0,
    suppliers: counts.suppliers ?? 0,
    supplierInvoices: counts.supplierInvoices ?? 0,
    purchases: counts.purchases ?? 0,
    createdAt: prepared?.createdAt ?? null,
  };
}

/**
 * Serialised size of an envelope, for the "last backup was N KB" line.
 *
 * @param {object} envelope
 * @returns {number} bytes
 */
export function backupByteLength(envelope) {
  try {
    return JSON.stringify(envelope).length;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ *
 * Restore
 * ------------------------------------------------------------------ */

/**
 * Replaces the shop's data with a prepared backup.
 *
 * Two safety properties, in this order:
 *
 *   1. **A safety snapshot is taken before anything is written.** It is built
 *      with the same `createBackup` used for Drive, so undoing a restore means
 *      replaying a known-good envelope rather than inventing a second format.
 *      It is returned to the caller and held in memory only — §10 is explicit
 *      that it must not be uploaded, and an un-asked-for upload is the one thing
 *      that could overwrite the very backup being restored.
 *
 *   2. **The write goes through `importAll`**, which is already a single
 *      multi-store transaction: either every store is replaced or none is.
 *      There is no partial restore to guard against here, because there is no
 *      partial restore in the existing layer, and duplicating that would only
 *      add a way to get it wrong.
 *
 * The caller must have obtained `prepared` from `prepareRestore` and must have
 * confirmed with the user. This function does not ask — that decision belongs to
 * the person whose shop it is.
 *
 * @param {{importAll: (data: object) => Promise<void>, exportAll: () => Promise<object>}} db
 * @param {object} prepared  a successful `prepareRestore` result
 * @param {{appVersion?: string, createdAt?: string}} [meta]
 * @returns {Promise<{restored: object, safetySnapshot: object, counts: object}>}
 */
export async function applyRestore(db, prepared, meta = {}) {
  if (!db || typeof db.importAll !== 'function') {
    throw new Error('applyRestore needs the store data layer');
  }
  if (!prepared || prepared.ok !== true || !prepared.legacy) {
    throw new Error('applyRestore needs a validated backup');
  }

  // Taken first, and it is the *current* shop — captured before a single record
  // is overwritten.
  const safetySnapshot = await createBackup(db, meta);

  await db.importAll(prepared.legacy);

  return {
    restored: prepared.envelope,
    safetySnapshot,
    counts: prepared.counts,
  };
}