/**
 * Google Drive client for the Store Hub backup.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * The one thing to understand about this file
 * ─────────────────────────────────────────────────────────────────────────
 * It talks to `googleapis.com` and to nothing else. In particular it does NOT
 * talk to the Store Hub backend, and the backup payload never travels through
 * it: the caller passes a short-lived access token, and the backup JSON is
 * uploaded straight from this device to the customer's own Drive.
 *
 * That is the whole reason Drive is a *backup destination* and not a backend
 * feature. The Store Hub backend brokers the Google authorisation; it is not on
 * the data path. `tests/backup.test.mjs` asserts that no call made by this
 * module ever points anywhere but at Google.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Scope
 * ─────────────────────────────────────────────────────────────────────────
 * `drive.file` only. Every query is either scoped to the backup folder's id or
 * filtered to the exact filename, so the app can only ever see the folder and
 * files it created. It has no ability to list, read or delete anything else in
 * the owner's Drive, which is the property `drive.file` exists to provide.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Injection
 * ─────────────────────────────────────────────────────────────────────────
 * `fetchImpl` and `now` are parameters rather than globals so the whole
 * replacement-safety protocol — upload, verify, only then delete — can be
 * driven through a scripted fake, including its failure paths.
 */

import {
  BACKUP_FILENAME,
  BACKUP_FOLDER_NAME,
  deserialiseBackup,
} from './backup.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Every origin this module is permitted to reach. Asserted by the tests. */
export const DRIVE_ORIGINS = Object.freeze([
  'https://www.googleapis.com',
  'https://content.googleapis.com',
]);

/** Resolves the fetch implementation, refusing to run without one. */
function resolveFetch(options) {
  const impl = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);
  if (!impl) throw new Error('لا يوجد اتصال بالإنترنت — لا يمكن تنفيذ النسخ الاحتياطي');
  return impl;
}

/** Escapes a value for the Drive `q` query language. */
function escapeQueryValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** UTF-8 byte length — what Drive reports as `size`. */
function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

/** A failure carrying enough detail for the Settings screen to be honest. */
export class DriveError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, code?: string, detail?: string}} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'DriveError';
    this.status = info.status ?? null;
    this.code = info.code ?? 'DRIVE_ERROR';
    this.detail = info.detail ?? '';
  }
}

async function readError(res) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message || JSON.stringify(body);
  } catch {
    try {
      detail = await res.text();
    } catch {
      detail = '';
    }
  }
  return detail;
}

/**
 * @param {Response} res
 * @param {string} what  what the call was trying to do, for the message
 * @returns {Promise<any>} the parsed body
 */
async function expectOk(res, what) {
  if (res.ok) {
    if (res.status === 204) return null;
    return res.json();
  }
  const detail = await readError(res);
  throw new DriveError(`تعذّر ${what}`, { status: res.status, code: 'DRIVE_ERROR', detail });
}

/* ------------------------------------------------------------------ *
 * Folder
 * ------------------------------------------------------------------ */

/**
 * Finds the Store Hub backup folder, or returns null if it is not there.
 *
 * The search is by exact name *and* folder mime type, and with `drive.file` it
 * can only ever match a folder this app created — a folder a user happened to
 * name "Store Hub Backups" by hand is invisible here, which is the correct
 * outcome: we manage our own folder and nobody else's.
 *
 * @param {{token: string, folderName?: string, fetchImpl?: Function}} options
 * @returns {Promise<{id: string, name: string}|null>}
 */
export async function findBackupFolder(options) {
  const fetchImpl = resolveFetch(options);
  const name = escapeQueryValue(options.folderName || BACKUP_FOLDER_NAME);
  const q = `name='${name}' and mimeType='${FOLDER_MIME}' and trashed=false`;
  const url = `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(
    'files(id,name,mimeType,modifiedTime)',
  )}&pageSize=10&spaces=drive`;

  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${options.token}` },
  });
  const data = await expectOk(res, 'العثور على مجلد النسخ الاحتياطية');
  const found = (data?.files || [])[0];
  return found ? { id: found.id, name: found.name } : null;
}

/**
 * Creates the backup folder.
 *
 * Only ever called when `findBackupFolder` found nothing — a folder deleted by
 * hand in the Drive UI is recreated rather than treated as a failure, because
 * from the app's point of view the folder is its own and its absence is not the
 * shop's problem.
 *
 * @param {{token: string, folderName?: string, fetchImpl?: Function}} options
 * @returns {Promise<{id: string, name: string}>}
 */
export async function createBackupFolder(options) {
  const fetchImpl = resolveFetch(options);
  const name = options.folderName || BACKUP_FOLDER_NAME;

  const res = await fetchImpl(`${DRIVE_API}/files`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
  });
  const data = await expectOk(res, 'إنشاء مجلد النسخ الاحتياطية');
  return { id: data.id, name: data.name || name };
}

/**
 * The folder, creating it only if it is genuinely absent.
 * @param {object} options
 * @returns {Promise<{id: string, name: string, created: boolean}>}
 */
export async function ensureBackupFolder(options) {
  const existing = await findBackupFolder(options);
  if (existing) return { ...existing, created: false };
  const created = await createBackupFolder(options);
  return { ...created, created: true };
}

/* ------------------------------------------------------------------ *
 * Files
 * ------------------------------------------------------------------ */

/**
 * Lists the backup files currently in the folder.
 *
 * @param {{token: string, folderId: string, fetchImpl?: Function}} options
 * @returns {Promise<Array<{id: string, name: string, size: number|null, modifiedTime: string|null}>>}
 */
export async function listBackupFiles(options) {
  const fetchImpl = resolveFetch(options);
  const q = `'${escapeQueryValue(options.folderId)}' in parents and trashed=false`;
  const url = `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(
    'files(id,name,mimeType,size,modifiedTime,trashed)',
  )}&orderBy=${encodeURIComponent('modifiedTime desc')}&pageSize=100&spaces=drive`;

  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${options.token}` },
  });
  const data = await expectOk(res, 'قراءة محتويات مجلد النسخ الاحتياطية');
  return (data?.files || []).map((f) => ({
    id: f.id,
    name: f.name,
    size: typeof f.size === 'number' ? f.size : null,
    modifiedTime: f.modifiedTime ?? null,
  }));
}

/**
 * Fetches a file's metadata. Also used as the post-upload verification step.
 *
 * @param {{token: string, fileId: string, fetchImpl?: Function}} options
 * @returns {Promise<{id: string, name: string, size: number|null, mimeType: string|null, modifiedTime: string|null, trashed: boolean}>}
 */
export async function getFileMetadata(options) {
  const fetchImpl = resolveFetch(options);
  const url = `${DRIVE_API}/files/${encodeURIComponent(options.fileId)}?fields=${encodeURIComponent(
    'id,name,mimeType,size,modifiedTime,trashed',
  )}`;
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${options.token}` },
  });
  const data = await expectOk(res, 'التحقق من ملف النسخة الاحتياطية');
  return {
    id: data.id,
    name: data.name,
    mimeType: data.mimeType ?? null,
    size: typeof data.size === 'number' ? data.size : null,
    modifiedTime: data.modifiedTime ?? null,
    trashed: data.trashed === true,
  };
}

/**
 * Uploads the backup JSON as a new file in the folder.
 *
 * A *new* file rather than an in-place update, deliberately. Drive's update
 * endpoint overwrites the bytes as it receives them, so a connection that drops
 * half way through leaves a truncated file where a good backup used to be. A new
 * file plus a verified swap means the previous backup is never at risk.
 *
 * @param {{token: string, folderId: string, name?: string, body: string, fetchImpl?: Function}} options
 * @returns {Promise<{id: string, name: string, bytes: number}>}
 */
export async function uploadBackupFile(options) {
  const fetchImpl = resolveFetch(options);
  const name = options.name || BACKUP_FILENAME;
  const body = options.body;

  if (typeof body !== 'string' || body.length === 0) {
    throw new DriveError('لا يوجد محتوى لرفعه', { code: 'EMPTY_BACKUP' });
  }

  const boundary = 'storehub-backup-boundary';
  const metadata = JSON.stringify({ name, parents: [options.folderId], mimeType: 'application/json' });
  const multipart = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    metadata,
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    body,
    `--${boundary}--`,
    '',
  ].join('\r\n');

  const url = `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=${encodeURIComponent('id,name,size')}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.token}`,
      'content-type': `multipart/related; boundary=${boundary}`,
    },
    body: multipart,
  });
  const data = await expectOk(res, 'رفع النسخة الاحتياطية');
  return { id: data.id, name: data.name || name, bytes: byteLength(body) };
}

/**
 * Downloads a backup file's contents as text.
 *
 * @param {{token: string, fileId: string, fetchImpl?: Function}} options
 * @returns {Promise<string>}
 */
export async function downloadBackupFile(options) {
  const fetchImpl = resolveFetch(options);
  const url = `${DRIVE_API}/files/${encodeURIComponent(options.fileId)}?alt=media`;
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${options.token}` },
  });
  if (!res.ok) {
    throw new DriveError('تعذّر تنزيل النسخة الاحتياطية', {
      status: res.status,
      detail: await readError(res),
    });
  }
  return res.text();
}

/**
 * @param {{token: string, fileId: string, fetchImpl?: Function}} options
 * @returns {Promise<void>}
 */
export async function deleteBackupFile(options) {
  const fetchImpl = resolveFetch(options);
  const res = await fetchImpl(`${DRIVE_API}/files/${encodeURIComponent(options.fileId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${options.token}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new DriveError('تعذّر حذف النسخة الاحتياطية القديمة', {
      status: res.status,
      detail: await readError(res),
    });
  }
}

/* ------------------------------------------------------------------ *
 * Replacement — the safety protocol
 * ------------------------------------------------------------------ */

/**
 * Publishes a new backup, replacing the previous one only once it is proven good.
 *
 * The order below is the whole point of this function, and it is not
 * interchangeable:
 *
 *   1. list what is there now, so the previous backup is known by id;
 *   2. upload the new file;
 *   3. verify it — Drive must report a file, not trashed, of the right size;
 *   4. only then delete the previous one.
 *
 * A failure at 2 or 3 throws with the previous backup untouched and still
 * restorable. Deleting first would mean a flaky connection could take the shop's
 * only backup with it, which is the single worst outcome this feature has.
 *
 * @param {{
 *   token: string,
 *   folderId: string,
 *   body: string,
 *   name?: string,
 *   folderName?: string,
 *   fetchImpl?: Function,
 * }} options
 * @returns {Promise<{fileId: string, folderId: string, bytes: number, replaced: string[], verified: boolean}>}
 */
export async function publishLatestBackup(options) {
  const fetchImpl = resolveFetch(options);
  const name = options.name || BACKUP_FILENAME;

  // 1 · what exists now, recorded BEFORE anything is written.
  const before = await listBackupFiles({ ...options, fetchImpl });
  const previous = before.filter((f) => f.name === name || before.length === 1);
  const stale = before.filter((f) => !previous.includes(f));

  // 2 · upload. Throwing here leaves everything from step 1 in place.
  const uploaded = await uploadBackupFile({ ...options, name, fetchImpl });

  // 3 · verify before destroying anything.
  const verified = await getFileMetadata({ ...options, fileId: uploaded.id, fetchImpl });
  const expectedBytes = byteLength(options.body);
  if (verified.trashed) {
    throw new DriveError('تم رفع النسخة الاحتياطية لكنها غير موجودة في Google Drive', {
      code: 'VERIFICATION_FAILED',
      detail: `file ${uploaded.id} reports trashed`,
    });
  }
  if (verified.size === null || verified.size !== expectedBytes) {
    throw new DriveError('النسخة المرفوعة لم تُتحقَّق — لم يتم حذف النسخة السابقة', {
      code: 'VERIFICATION_FAILED',
      detail: `expected ${expectedBytes} bytes, Drive reports ${verified.size}`,
    });
  }

  // 4 · the replacement is proven; the old copy can finally go.
  for (const file of [...previous, ...stale]) {
    if (file.id === uploaded.id) continue;
    await deleteBackupFile({ ...options, fileId: file.id, fetchImpl });
  }

  return {
    fileId: uploaded.id,
    folderId: options.folderId,
    bytes: expectedBytes,
    replaced: [...previous, ...stale].filter((f) => f.id !== uploaded.id).map((f) => f.id),
    verified: true,
  };
}

/**
 * Finds the backup file to restore from, if there is one.
 *
 * Prefers the exact filename, then the most recently modified file in the
 * folder — so a file the user renamed by hand is still found rather than
 * reported as "no backup".
 *
 * @param {object} options
 * @returns {Promise<{id: string, name: string, size: number|null, modifiedTime: string|null}|null>}
 */
export async function findLatestBackupFile(options) {
  const files = await listBackupFiles(options);
  if (files.length === 0) return null;
  const exact = files.find((f) => f.name === (options.name || BACKUP_FILENAME));
  if (exact) return exact;
  return files.slice().sort((a, b) => String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || '')))[0];
}

/**
 * Downloads and parses the current backup without touching the database.
 *
 * Returning the *prepared* result — validated, media-stripped, and reduced to the
 * shape `importAll` accepts — is what lets the UI show the user what is about to
 * replace their shop, and lets them refuse, with nothing written either way.
 *
 * @param {object} options
 * @returns {Promise<{ok: true, file: object, prepared: object}|{ok: false, code: string, message: string}>}
 */
export async function fetchLatestBackup(options) {
  const fetchImpl = resolveFetch(options);
  const folder = await ensureBackupFolder(options);
  const file = await findLatestBackupFile({ ...options, folderId: folder.id, fetchImpl });
  if (!file) {
    return { ok: false, code: 'NO_BACKUP', message: 'لا توجد نسخة احتياطية في Google Drive' };
  }

  const text = await downloadBackupFile({ ...options, fileId: file.id, fetchImpl });
  const parsed = deserialiseBackup(text);
  if (!parsed.ok) return parsed;

  // Imported here rather than passed up as raw JSON: the validation has to
  // happen before anything is shown as restorable, and the scheduler keeps this
  // module free of any knowledge of the envelope.
  const { prepareRestore } = await import('./backup.js');
  const prepared = prepareRestore(parsed.value);
  if (!prepared.ok) return prepared;

  return { ok: true, file, prepared };
}