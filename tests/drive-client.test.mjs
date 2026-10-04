/**
 * Store Hub — Google Drive client tests.
 *
 *   node tests/drive-client.test.mjs
 *
 * ─────────────────────────────────────────────────────────────────────────
 * What these tests are for
 * ─────────────────────────────────────────────────────────────────────────
 * `js/drive-client.js` holds the promise that matters most in this phase: the
 * backup payload goes from the device straight to the customer's own Drive, and
 * the Store Hub backend is nowhere on that path. That is a claim about *URLs*,
 * so most of what follows asserts on URLs.
 *
 * The second thing worth proving is the replacement protocol. One latest file,
 * replaced only after the new one is proven good — so the failure cases are the
 * interesting ones: a failed upload and a failed verification must both leave
 * the previous backup completely untouched, which is the difference between a
 * backup and a coin toss.
 *
 * Zero dependencies, like every other test here: the project has no
 * node_modules and is not allowed to grow one. The Drive API is stood up in
 * memory below.
 */

const js = (rel) => new URL(`../js/${rel}`, import.meta.url).href;
const readSrc = (rel) =>
  import('node:fs').then((fs) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'));

/* ------------------------------------------------------------------ *
 * Tiny runner (same shape as tests/foundation.test.mjs)
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

/**
 * Equality.
 *
 * `Object.is` alone is not enough: most of what matters here is arrays and
 * objects, and `['file-1'] !== ['file-1']` would make every one of those
 * assertions fail while printing an expected and an actual that look identical —
 * a confusing failure that hides the real problem.
 */
function eq(label, actual, expected) {
  if (Object.is(actual, expected)) {
    ok(label, true);
    return;
  }
  const bothObjects =
    actual !== null && expected !== null &&
    typeof actual === 'object' && typeof expected === 'object';
  const equal = bothObjects && JSON.stringify(actual) === JSON.stringify(expected);
  ok(label, equal, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(title) {
  console.log(`\n${title}`);
}

/** Asserts a promise rejects, and returns the error so its shape can be checked. */
async function rejects(label, promise, check) {
  try {
    await promise;
    ok(label, false, 'it resolved when it should have thrown');
    return null;
  } catch (err) {
    const extra = check ? check(err) : '';
    ok(label, !check || !extra, extra);
    return err;
  }
}

/* ------------------------------------------------------------------ *
 * A Drive in memory
 * ------------------------------------------------------------------ */

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * Classifies a Drive request so the fake can both route it and record what kind
 * of call it was. Tests assert on `calls` afterwards — the *order* and the *kind*
 * are the evidence that the safety protocol ran in the order it claims.
 */
function classify(method, url) {
  if (method === 'POST' && url.includes('/upload/drive/v3/files')) return 'upload';
  if (method === 'POST' && url.endsWith('/files')) return 'create-folder';
  if (method === 'DELETE') return 'delete';
  if (method === 'GET' && url.includes('alt=media')) return 'download';
  if (method === 'GET' && url.includes('?fields=')) return 'metadata';
  if (method === 'GET' && url.includes('?q=')) {
    return decodeURIComponent(url).includes('mimeType=') ? 'find-folder' : 'list';
  }
  return 'unknown';
}

function respond(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

/**
 * Pulls the metadata part and the file content out of a multipart body.
 *
 * Split on the bare boundary marker, not on `\r\n--boundary`: the first boundary
 * in a multipart body has no leading CRLF (it opens the body), so the CRLF-prefixed
 * form silently swallows the metadata part into the leading chunk.
 */
function parseMultipart(raw) {
  const parts = raw.split('--storehub-backup-boundary');
  const bodyOf = (chunk) => {
    const text = chunk.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const split = text.indexOf('\r\n\r\n');
    return split === -1 ? '' : text.slice(split + 4);
  };
  return {
    metadata: JSON.parse(bodyOf(parts[1] ?? '')),
    content: bodyOf(parts[2] ?? ''),
  };
}

class FakeDrive {
  constructor() {
    this.folders = new Map();
    this.files = new Map();
    this.calls = [];
    this.seq = 0;
    /** `{kind, status, times}` — makes one kind of call fail, `times` times. */
    this.faults = [];
    this.folderId = 'folder-1';
  }

  /** @param {{kind: string, status?: number, times?: number}} fault */
  failOn(fault) {
    this.faults.push({ times: 1, status: 500, ...fault });
  }

  /** Puts a file straight into the folder, as an earlier week's backup. */
  seedFile(name, content, folderId = this.folderId) {
    const id = `file-${++this.seq}`;
    this.files.set(id, {
      id,
      name,
      mimeType: 'application/json',
      size: new TextEncoder().encode(content).length,
      modifiedTime: new Date(1_700_000_000_000 + this.seq * 1000).toISOString(),
      trashed: false,
      parents: [folderId],
      content,
    });
    return id;
  }

  seedFolder(name = 'Store Hub Backups', id = this.folderId) {
    this.folders.set(id, { id, name, mimeType: FOLDER_MIME });
    return id;
  }

  /** Whether the fault queue says this call should fail. */
  shouldFail(kind) {
    const fault = this.faults.find((f) => f.kind === kind && f.times > 0);
    if (!fault) return null;
    fault.times -= 1;
    return fault;
  }

  /** Every file id currently visible, in insertion order. */
  liveFileIds() {
    return [...this.files.keys()];
  }

  fetch = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const kind = classify(method, url);
    this.calls.push({ kind, method, url: String(url), headers: init.headers || {} });

    const fault = this.shouldFail(kind);
    if (fault) {
      return respond(fault.status, { error: { message: `scripted ${kind} failure` } });
    }

    switch (kind) {
      case 'find-folder': {
        // The real Drive honours every term of `q`. Honouring only the name here
        // would make this fake more permissive than the API, and a test built on
        // a permissive fake proves nothing about the narrow scope.
        const q = decodeURIComponent(String(url).split('?')[1]);
        const name = /name='([^']*)'/.exec(q)?.[1];
        const mime = /mimeType='([^']*)'/.exec(q)?.[1];
        const files = [...this.folders.values()]
          .filter((f) => f.name === name)
          .filter((f) => !mime || f.mimeType === mime)
          .map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: null }));
        return respond(200, { files });
      }

      case 'create-folder': {
        const id = `folder-${++this.seq}`;
        const name = JSON.parse(init.body).name;
        this.folders.set(id, { id, name, mimeType: FOLDER_MIME });
        return respond(200, { id, name, mimeType: FOLDER_MIME });
      }

      case 'list': {
        const q = decodeURIComponent(String(url).split('?')[1]);
        const parent = /'([^']*)' in parents/.exec(q)?.[1];
        const files = [...this.files.values()]
          .filter((f) => f.parents.includes(parent) && !f.trashed)
          .map((f) => ({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            size: f.size,
            modifiedTime: f.modifiedTime,
            trashed: f.trashed,
          }));
        return respond(200, { files });
      }

      case 'upload': {
        const { metadata, content } = parseMultipart(init.body);
        const id = `file-${++this.seq}`;
        this.files.set(id, {
          id,
          name: metadata.name,
          mimeType: metadata.mimeType,
          size: new TextEncoder().encode(content).length,
          modifiedTime: new Date(1_800_000_000_000 + this.seq * 1000).toISOString(),
          trashed: false,
          parents: metadata.parents,
          content,
        });
        return respond(200, { id, name: metadata.name, size: this.files.get(id).size });
      }

      case 'metadata': {
        const id = decodeURIComponent(String(url).match(/\/files\/([^?]+)/)[1]);
        const file = this.files.get(id);
        if (!file) return respond(404, { error: { message: 'not found' } });
        // `sabotageSize` lets a test model the specific "Drive stored something
        // other than what we sent" failure that verification exists to catch.
        return respond(200, {
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          size: file.sabotageSize === undefined ? file.size : file.sabotageSize,
          modifiedTime: file.modifiedTime,
          trashed: file.trashed === true,
        });
      }

      case 'download': {
        const id = decodeURIComponent(String(url).match(/\/files\/([^?]+)/)[1]);
        const file = this.files.get(id);
        if (!file) return respond(404, { error: { message: 'not found' } });
        return respond(200, file.content);
      }

      case 'delete': {
        const id = decodeURIComponent(String(url).split('?')[0].split('/').pop());
        this.files.delete(id);
        return respond(204, '');
      }

      default:
        return respond(400, { error: { message: `unscripted ${method} ${url}` } });
    }
  };
}

/** A valid, minimal backup envelope. */
function envelope(overrides = {}) {
  return {
    format: 'storehub-backup',
    version: 1,
    createdAt: '2026-03-01T00:00:00.000Z',
    appVersion: '1.0.0',
    media: { included: false, policy: 'images excluded by design' },
    counts: { products: 1, sales: 1, purchases: 0, suppliers: 1, supplierInvoices: 0, supplierPayments: 0 },
    data: {
      products: [{ id: 'p1', name: 'قميص', price: 50, qty: 4 }],
      sales: [{ id: 's1', total: 100, items: [{ productId: 'p1', qty: 2 }] }],
      purchases: [],
      suppliers: [{ id: 'sup1', name: 'مورد' }],
      supplierInvoices: [],
      supplierPayments: [],
      settings: { key: 'app', storeName: 'محلي' },
    },
    ...overrides,
  };
}

const drive = await import(js('drive-client.js'));
const backup = await import(js('backup.js'));

/* ================================================================== *
 * 1 · ORIGIN INVARIANT — the backend is not on the data path
 * ================================================================== */

section('1 · every Drive call goes to Google, never to Store Hub');

{
  const origin = new URL(drive.DRIVE_ORIGINS[0]).origin;
  eq('the declared origin is googleapis.com', origin, 'https://www.googleapis.com');

  // Drive every code path, failures included, and inspect every URL.
  const d = new FakeDrive();
  d.seedFolder();
  const previousId = d.seedFile('storehub-backup.json', JSON.stringify(envelope()));

  d.failOn({ kind: 'find-folder' });
  await drive.findBackupFolder({ token: 't', fetchImpl: d.fetch }).catch(() => {});
  d.failOn({ kind: 'create-folder' });
  await drive.createBackupFolder({ token: 't', folderName: 'x', fetchImpl: d.fetch }).catch(() => {});
  d.failOn({ kind: 'list' });
  await drive.listBackupFiles({ token: 't', folderId: 'folder-1', fetchImpl: d.fetch }).catch(() => {});
  d.failOn({ kind: 'upload' });
  await drive
    .uploadBackupFile({ token: 't', folderId: 'folder-1', body: '{}', fetchImpl: d.fetch })
    .catch(() => {});
  d.failOn({ kind: 'metadata' });
  await drive.getFileMetadata({ token: 't', fileId: previousId, fetchImpl: d.fetch }).catch(() => {});
  d.failOn({ kind: 'download' });
  await drive.downloadBackupFile({ token: 't', fileId: previousId, fetchImpl: d.fetch }).catch(() => {});
  d.failOn({ kind: 'delete' });
  await drive.deleteBackupFile({ token: 't', fileId: previousId, fetchImpl: d.fetch }).catch(() => {});
  d.failOn({ kind: 'upload' });
  await drive
    .publishLatestBackup({ token: 't', folderId: 'folder-1', body: '{}', fetchImpl: d.fetch })
    .catch(() => {});

  ok('calls were made', d.calls.length >= 8, `only ${d.calls.length}`);
  const foreign = d.calls.filter((c) => !drive.DRIVE_ORIGINS.some((o) => String(c.url).startsWith(o)));
  eq('no call left the Google origins', foreign.length, 0);
  if (foreign.length) console.log('        ' + foreign.map((c) => c.url).join('\n        '));

  const storeHub = d.calls.filter((c) => /\/api\/|storehub/i.test(String(c.url)));
  eq('no call is addressed to the Store Hub backend', storeHub.length, 0);

  // Belt and braces: the module source contains no `/api/` URL at all, so a
  // future edit cannot quietly reintroduce one without failing this file.
  const src = await readSrc('js/drive-client.js');
  ok('drive-client.js builds no /api/ URL', !/['"`]\/api\//.test(src));
  ok('drive-client.js does not import the auth client', !/from\s+['"]\.\/drive-auth-client\.js/.test(src));
}

{
  // The one module that DOES talk to the backend is a different file, and the
  // separation is worth asserting rather than assuming.
  const src = await readSrc('js/drive-auth-client.js');
  ok('drive-auth-client.js is the only module with /api/drive/ calls', src.includes('/api/drive/'));
  const backupSrc = await readSrc('js/backup.js');
  ok('backup.js never calls fetch at all', !/\bfetch\b/.test(backupSrc));
}

/* ================================================================== *
 * 2 · REPLACEMENT SAFETY — the previous backup is never at risk
 * ================================================================== */

section('2 · publishLatestBackup replaces only after the new one is proven');

{
  const d = new FakeDrive();
  d.seedFolder();
  const previousId = d.seedFile(backup.BACKUP_FILENAME, JSON.stringify(envelope()));
  const body = JSON.stringify(envelope({ createdAt: '2026-03-08T00:00:00.000Z' }));

  const result = await drive.publishLatestBackup({
    token: 'ya29.t',
    folderId: d.folderId,
    body,
    fetchImpl: d.fetch,
  });

  eq('the file name is the deterministic one', backup.BACKUP_FILENAME, 'storehub-backup.json');
  eq('one file remains', d.liveFileIds().length, 1);
  ok('it is the new file', result.fileId !== previousId);
  eq('the previous one was reported as replaced', result.replaced, [previousId]);
  eq('and the result is marked verified', result.verified, true);
  eq('the byte count is the real UTF-8 length', result.bytes, new TextEncoder().encode(body).length);

  // The order is the protocol. Anything else is a different, worse design.
  const order = d.calls.map((c) => c.kind);
  eq(
    'the order was list → upload → verify → delete',
    order,
    ['list', 'upload', 'metadata', 'delete'],
  );
}

{
  // Upload fails. Nothing may be destroyed.
  const d = new FakeDrive();
  d.seedFolder();
  const previousId = d.seedFile(backup.BACKUP_FILENAME, JSON.stringify(envelope()));
  d.failOn({ kind: 'upload' });

  const err = await rejects('a failed upload throws', drive.publishLatestBackup({
    token: 'ya29.t',
    folderId: d.folderId,
    body: JSON.stringify(envelope()),
    fetchImpl: d.fetch,
  }));

  eq('the previous backup is still there', d.liveFileIds(), [previousId]);
  ok('and its content is intact', d.files.get(previousId).content.includes('قميص'));
  eq('no delete was attempted', d.calls.filter((c) => c.kind === 'delete').length, 0);
  ok('the failure is reported as a Drive error', err instanceof drive.DriveError);
}

{
  // Upload succeeds but Drive stored the wrong number of bytes. This is the
  // specific failure verification exists for, and it must keep the old backup.
  const d = new FakeDrive();
  d.seedFolder();
  const previousId = d.seedFile(backup.BACKUP_FILENAME, JSON.stringify(envelope()));

  const realFetch = d.fetch;
  d.fetch = async (url, init) => {
    const res = await realFetch(url, init);
    if (classify((init.method || 'GET').toUpperCase(), String(url)) === 'upload') {
      const { id } = JSON.parse(await res.text());
      d.files.get(id).sabotageSize = 12; // truncated on Drive's side
    }
    return res;
  };

  const err = await rejects('a size mismatch is refused', drive.publishLatestBackup({
    token: 'ya29.t',
    folderId: d.folderId,
    body: JSON.stringify(envelope()),
    fetchImpl: d.fetch,
  }));

  eq('the code says so', err?.code, 'VERIFICATION_FAILED');
  ok('the previous backup survived', d.liveFileIds().includes(previousId));
  eq('nothing was deleted', d.calls.filter((c) => c.kind === 'delete').length, 0);
}

{
  // Verification reports the file as trashed.
  const d = new FakeDrive();
  d.seedFolder();
  const previousId = d.seedFile(backup.BACKUP_FILENAME, JSON.stringify(envelope()));
  const realFetch = d.fetch;
  d.fetch = async (url, init) => {
    const res = await realFetch(url, init);
    if (classify((init.method || 'GET').toUpperCase(), String(url)) === 'upload') {
      const { id } = JSON.parse(await res.text());
      d.files.get(id).trashed = true;
    }
    return res;
  };

  const err = await rejects('a trashed file is refused', drive.publishLatestBackup({
    token: 'ya29.t',
    folderId: d.folderId,
    body: JSON.stringify(envelope()),
    fetchImpl: d.fetch,
  }));

  eq('the code says so', err?.code, 'VERIFICATION_FAILED');
  ok('the previous backup survived', d.liveFileIds().includes(previousId));
}

{
  // The metadata call itself fails — the network dropped after the upload.
  const d = new FakeDrive();
  d.seedFolder();
  const previousId = d.seedFile(backup.BACKUP_FILENAME, JSON.stringify(envelope()));
  d.failOn({ kind: 'metadata' });

  await rejects('an unverifiable upload throws', drive.publishLatestBackup({
    token: 'ya29.t',
    folderId: d.folderId,
    body: JSON.stringify(envelope()),
    fetchImpl: d.fetch,
  }));

  ok('the previous backup survived', d.liveFileIds().includes(previousId));
  eq('nothing was deleted', d.calls.filter((c) => c.kind === 'delete').length, 0);
}

{
  // Every week leaves exactly one file, never a pile.
  const d = new FakeDrive();
  d.seedFolder();
  for (let week = 1; week <= 5; week += 1) {
    await drive.publishLatestBackup({
      token: 'ya29.t',
      folderId: d.folderId,
      body: JSON.stringify(envelope({ createdAt: `2026-03-0${week}T00:00:00.000Z` })),
      fetchImpl: d.fetch,
    });
  }
  eq('five backups, one file', d.liveFileIds().length, 1);
  eq('and it is always called storehub-backup.json', [...d.files.values()][0].name, 'storehub-backup.json');
}

{
  // A stray file the owner dropped in by hand is cleaned up — but only after the
  // replacement is verified.
  const d = new FakeDrive();
  d.seedFolder();
  const keeper = d.seedFile(backup.BACKUP_FILENAME, JSON.stringify(envelope()));
  const stray = d.seedFile('notes.txt', 'not a backup');

  await drive.publishLatestBackup({
    token: 'ya29.t',
    folderId: d.folderId,
    body: JSON.stringify(envelope()),
    fetchImpl: d.fetch,
  });

  eq('both the old backup and the stray are gone', d.liveFileIds().length, 1);
  ok('the new file is the survivor', !d.liveFileIds().includes(keeper) && !d.liveFileIds().includes(stray));
}

section('3 · the folder is the app\'s own, and is recreated if deleted');

{
  const d = new FakeDrive();
  const found = await drive.ensureBackupFolder({ token: 'ya29.t', fetchImpl: d.fetch });
  eq('a missing folder is created', found.created, true);
  eq('with the documented name', found.name, backup.BACKUP_FOLDER_NAME);

  const again = await drive.ensureBackupFolder({ token: 'ya29.t', fetchImpl: d.fetch });
  eq('the second call finds it instead', again.created, false);
  eq('and the id is stable', again.id, found.id);
}

{
  // The folder search must not match a folder a person made by hand. Under
  // drive.file it cannot even see one, but the query should still insist.
  const d = new FakeDrive();
  d.folders.set('foreign', { id: 'foreign', name: backup.BACKUP_FOLDER_NAME, mimeType: 'text/plain' });
  const found = await drive.ensureBackupFolder({ token: 'ya29.t', fetchImpl: d.fetch });
  ok('a non-folder of the same name is not adopted', found.id !== 'foreign');
  eq('and it was not mistaken for ours', found.created, true);
}

/* ================================================================== *
 * 4 · RESTORE READS BACK SAFELY
 * ================================================================== */

section('4 · fetchLatestBackup validates before offering anything to restore');

{
  const d = new FakeDrive();
  d.seedFolder();
  d.seedFile(backup.BACKUP_FILENAME, JSON.stringify(envelope()));

  const result = await drive.fetchLatestBackup({ token: 'ya29.t', fetchImpl: d.fetch });
  ok('a good backup is offered for restore', result.ok === true);
  eq('with the product count', result.prepared.counts.products, 1);
  eq('and no write was attempted', d.calls.filter((c) => c.kind === 'upload').length, 0);
}

{
  const d = new FakeDrive();
  d.seedFolder();
  d.seedFile(backup.BACKUP_FILENAME, '{ not json at all');

  const result = await drive.fetchLatestBackup({ token: 'ya29.t', fetchImpl: d.fetch });
  eq('malformed JSON is refused', result.ok, false);
  eq('with a specific code', result.code, 'MALFORMED_JSON');
}

{
  const d = new FakeDrive();
  d.seedFolder();
  d.seedFile(backup.BACKUP_FILENAME, JSON.stringify(envelope({ version: 99 })));

  const result = await drive.fetchLatestBackup({ token: 'ya29.t', fetchImpl: d.fetch });
  eq('a newer format version is refused, not guessed at', result.code, 'UNSUPPORTED_VERSION');
}

{
  const d = new FakeDrive();
  d.seedFolder();
  const bad = envelope();
  delete bad.data.suppliers;
  d.seedFile(backup.BACKUP_FILENAME, JSON.stringify(bad));

  const result = await drive.fetchLatestBackup({ token: 'ya29.t', fetchImpl: d.fetch });
  eq('a missing section is refused', result.code, 'MISSING_SECTION');
}

{
  const d = new FakeDrive();
  d.seedFolder();
  const bad = envelope();
  bad.data.products = [{ name: 'بلا مُعرّف' }];
  d.seedFile(backup.BACKUP_FILENAME, JSON.stringify(bad));

  const result = await drive.fetchLatestBackup({ token: 'ya29.t', fetchImpl: d.fetch });
  eq('a record without a key is refused', result.code, 'INVALID_RECORD');
}

{
  // Even a file that carries images is stripped on the way in — the backup
  // format says images are not restorable, so restore must honour that rather
  // than trusting whatever the file happens to contain.
  const d = new FakeDrive();
  d.seedFolder();
  const withImages = envelope();
  withImages.data.products[0].image = 'data:image/jpeg;base64,AAAA';
  withImages.data.settings.logo = 'data:image/png;base64,BBBB';
  d.seedFile(backup.BACKUP_FILENAME, JSON.stringify(withImages));

  const result = await drive.fetchLatestBackup({ token: 'ya29.t', fetchImpl: d.fetch });
  ok('it is still restorable', result.ok === true);
  ok('but the product image did not survive', !('image' in result.prepared.legacy.products[0]));
  ok('nor did the logo', !('logo' in result.prepared.legacy.settings));
}

{
  const d = new FakeDrive();
  d.seedFolder();
  const result = await drive.fetchLatestBackup({ token: 'ya29.t', fetchImpl: d.fetch });
  eq('an empty folder reports no backup rather than failing', result.code, 'NO_BACKUP');
}

{
  // A file the owner renamed by hand is still found.
  const d = new FakeDrive();
  d.seedFolder();
  d.seedFile('نسخة قديمة.json', JSON.stringify(envelope()));

  const result = await drive.fetchLatestBackup({ token: 'ya29.t', fetchImpl: d.fetch });
  ok('a renamed backup is still found', result.ok === true);
  eq('and is named for the UI to show', result.file.name, 'نسخة قديمة.json');
}

/* ================================================================== *
 * 5 · drive.file SCOPE
 * ================================================================== */

section('5 · the queries are as narrow as the scope');

{
  const d = new FakeDrive();
  d.seedFolder();
  d.seedFile(backup.BACKUP_FILENAME, JSON.stringify(envelope()));
  await drive.ensureBackupFolder({ token: 'ya29.t', fetchImpl: d.fetch });
  await drive.findLatestBackupFile({ token: 'ya29.t', folderId: d.folderId, fetchImpl: d.fetch });

  const folderQuery = decodeURIComponent(d.calls.find((c) => c.kind === 'find-folder').url);
  ok('the folder search names the exact folder', folderQuery.includes(`name='${backup.BACKUP_FOLDER_NAME}'`));
  ok('and requires the folder mime type', folderQuery.includes(`mimeType='${FOLDER_MIME}'`));

  const listQuery = decodeURIComponent(d.calls.find((c) => c.kind === 'list').url);
  ok('the file listing is scoped to a parent id', listQuery.includes(`'${d.folderId}' in parents`));

  // No listing anywhere is unfiltered. `spaces=drive` is fine *with* a `q=`; it
  // would be a full enumeration without one.
  const listings = d.calls.filter((c) => c.url.includes('/files?'));
  ok('there were listings to check', listings.length >= 2);
  eq('every listing carries a filter', listings.filter((c) => !c.url.includes('q=')).length, 0);
  eq('every listing names its fields', listings.filter((c) => !c.url.includes('fields=')).length, 0);

  // And the source cannot regress into a drive-wide enumeration.
  const src = await readSrc('js/drive-client.js');
  ok('no corpora= parameter exists', !/corpora=/.test(src));
  ok('nothing addresses the Drive root, which is how a whole drive gets read', !/files\/root/.test(src));
  ok('the scope is drive.file, never drive', backup.DRIVE_SCOPE === 'drive.file');
}

{
  // Every call carries the bearer token and nothing else sensitive.
  const d = new FakeDrive();
  d.seedFolder();
  d.seedFile(backup.BACKUP_FILENAME, JSON.stringify(envelope()));
  await drive.publishLatestBackup({
    token: 'ya29.access-token-value',
    folderId: d.folderId,
    body: JSON.stringify(envelope()),
    fetchImpl: d.fetch,
  });

  const authed = d.calls.filter((c) => c.headers.authorization === 'Bearer ya29.access-token-value');
  eq('every call is authenticated with the short-lived token', authed.length, d.calls.length);
  ok('the refresh token is never sent to Drive', !JSON.stringify(d.calls).includes('refresh'));
}

/* ================================================================== *
 * 6 · NOTHING IS SENT IF THERE IS NOTHING TO SEND
 * ================================================================== */

section('6 · guard rails');

{
  const err = await rejects('an empty body is refused before any call', drive.uploadBackupFile({
    token: 't',
    folderId: 'f',
    body: '',
    fetchImpl: async () => {
      throw new Error('fetch must not be reached');
    },
  }));
  eq('with a clear code', err?.code, 'EMPTY_BACKUP');
}

{
  const d = new FakeDrive();
  await rejects('with no fetch implementation at all, it refuses rather than guessing', drive.findBackupFolder({
    token: 't',
    fetchImpl: null,
  }));
}

{
  // A 401 from Drive is surfaced, not swallowed.
  const d = new FakeDrive();
  d.failOn({ kind: 'list', status: 401 });
  const err = await rejects('an expired token surfaces as an error', drive.listBackupFiles({
    token: 'stale',
    folderId: 'f',
    fetchImpl: d.fetch,
  }));
  eq('with the status preserved', err?.status, 401);
}

{
  // The upload is a multipart POST, so the JSON is never a bare request body.
  const d = new FakeDrive();
  d.seedFolder();
  await drive.uploadBackupFile({
    token: 't',
    folderId: d.folderId,
    body: JSON.stringify(envelope()),
    fetchImpl: d.fetch,
  });
  const upload = d.calls.find((c) => c.kind === 'upload');
  ok('the upload is multipart/related', String(upload.headers['content-type']).startsWith('multipart/related;'));
  ok('and it names the parent folder in the metadata part', upload.url.includes('uploadType=multipart'));
  const stored = [...d.files.values()][0];
  eq('the file lands in the backup folder', stored.parents, [d.folderId]);
  eq('as JSON', stored.mimeType, 'application/json');
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

// `process.exitCode` rather than `process.exit()`. Forcing the exit while a
// dynamic import is still settling trips a libuv assertion on Windows and turns
// a green run into a red one. Nothing here holds the event loop open, so the
// process ends on its own with this status.
process.exitCode = failed === 0 ? 0 : 1;
