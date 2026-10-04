/**
 * Store Hub — backup and restore tests.
 *
 *   node tests/backup.test.mjs
 *
 * ─────────────────────────────────────────────────────────────────────────
 * What makes this file different from the other test assets
 * ─────────────────────────────────────────────────────────────────────────
 * It runs the *real* `js/db.js`, on top of the IndexedDB double next door.
 * Not a stand-in for the data layer, and not a hand-written snapshot: the real
 * module, with its real migrations, its real number guards and its real
 * `importAll` transaction. A backup format tested against a mock database can
 * only ever prove the format round-trips through the mock.
 *
 * That matters because the two claims this phase rests on are both about the
 * real thing:
 *
 *   1. **Completeness.** Every business store ends up in the file. If a store is
 *      added to `saher_db` later and forgotten here, the tests below fail —
 *      which is the point of deriving the expectation from the live schema.
 *
 *   2. **No product images.** Not "the `image` field is dropped" but: no data
 *      URL of any kind survives, at any depth, under any key — including a key
 *      nobody has written yet. The phase brief excludes media outright, and an
 *      exclusion that can be dodged by renaming a field is not an exclusion.
 *
 * Zero dependencies, like every test here: the project has no node_modules and
 * is not allowed to grow one.
 */

import { createFakeIndexedDB } from './fake-indexeddb.mjs';

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

/** Equality that also works for arrays and objects, whose identities differ. */
function eq(label, actual, expected) {
  if (Object.is(actual, expected)) {
    ok(label, true);
    return;
  }
  const bothObjects =
    actual !== null && expected !== null && typeof actual === 'object' && typeof expected === 'object';
  ok(label, bothObjects && JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(title) {
  console.log(`\n${title}`);
}

/** Runs `promise`, expecting a rejection. Returns the error, or null. */
async function rejects(label, promise) {
  try {
    await promise;
    ok(label, false, 'it resolved when it should have thrown');
    return null;
  } catch (err) {
    ok(label, true);
    return err;
  }
}

/* ------------------------------------------------------------------ *
 * The real database, on the double
 * ------------------------------------------------------------------ */

// Must be installed before `js/db.js` is imported: the module opens `saher_db`
// against the global `indexedDB` the first time it is called.
const fakeIdb = createFakeIndexedDB();
globalThis.indexedDB = fakeIdb;

const db = await import(js('db.js'));
const backup = await import(js('backup.js'));

/**
 * Fills the shop with one of everything, through the real write functions, so
 * the backup is built from records the app would actually produce.
 *
 * @param {{logo?: string, productImage?: string}} [opts]
 */
async function seedShop(opts = {}) {
  const productImage =
    opts.productImage ?? 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJ';
  const logo = opts.logo ?? 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';

  await db.saveProduct({
    id: 'p-shirt',
    name: 'قميص',
    sku: 'SH-1',
    category: 'قمصان',
    price: 50,
    costPrice: 20,
    variants: [
      { size: 'L', color: 'أبيض', quantity: 4 },
      { size: 'M', color: 'أسود', quantity: 2 },
    ],
    image: productImage,
  });
  await db.saveProduct({
    id: 'p-trouser',
    name: 'بنطال',
    sku: 'TR-1',
    price: 80,
    costPrice: 35,
    variants: [{ size: '32', color: 'كحلي', quantity: 5 }],
  });

  await db.createSale({
    id: 's-1',
    items: [
      // Deliberately includes `image`, which `createSale` does not copy. The
      // point is that even if a sale *did* carry one, it would still be stripped.
      { productId: 'p-shirt', name: 'قميص', size: 'L', color: 'أبيض', qty: 2, price: 50, costPrice: 20, image: productImage },
      { productId: 'p-trouser', name: 'بنطال', size: '32', color: 'كحلي', qty: 1, price: 80, costPrice: 35 },
    ],
  });

  await db.saveSupplier({ id: 'sup-1', name: 'مورد الأقمشة', phone: '0599', openingBalance: 120 });
  await db.createPurchase({
    id: 'po-1',
    productId: 'p-shirt',
    lines: [{ size: 'L', color: 'أبيض', qty: 10 }],
    unitCost: 18,
    newPrice: 52,
  });

  await db.saveSettings({ storeName: 'محل ساهر', openingBalance: 500, logo });
}

/** Every record currently in the database, for before/after comparison. */
async function shopFingerprint() {
  const snapshot = await db.exportAll();
  return JSON.stringify({
    products: snapshot.products.map((p) => p.id).sort(),
    sales: snapshot.sales.map((s) => s.id).sort(),
    purchases: snapshot.purchases.map((p) => p.id).sort(),
    suppliers: snapshot.suppliers.map((s) => s.id).sort(),
    supplierInvoices: snapshot.supplierInvoices.map((s) => s.id).sort(),
    supplierPayments: snapshot.supplierPayments.map((s) => s.id).sort(),
    settings: { storeName: snapshot.settings.storeName, openingBalance: snapshot.settings.openingBalance },
  });
}

/* ================================================================== *
 * 1 · COMPLETENESS — every store, every record
 * ================================================================== */

section('1 · the backup carries every business store');

await seedShop();

let envelope;
let serialised;
{
  envelope = await backup.createBackup(db, { appVersion: '1.0.0', createdAt: '2026-03-01T00:00:00.000Z' });
  serialised = backup.serialiseBackup(envelope);

  eq('the format is identified', envelope.format, backup.BACKUP_FORMAT);
  eq('the version is 2', envelope.version, 2);
  eq('it is a number', typeof envelope.version, 'number');
  eq('the creation time is carried', envelope.createdAt, '2026-03-01T00:00:00.000Z');
  eq('the app version is carried', envelope.appVersion, '1.0.0');
  ok('it is valid JSON', (() => { try { JSON.parse(serialised); return true; } catch { return false; } })());
  ok('the file name is deterministic', backup.BACKUP_FILENAME === 'storehub-backup.json');

  // Completeness against the *live* schema, not a restated list. If a store is
  // added to `saher_db` and forgotten in the backup, this is what notices.
  for (const store of Object.keys(db.STORES)) {
    ok(`section "${store}" is present`, store in envelope.data, `missing from the envelope`);
  }
  eq('and no extra section was invented',
    Object.keys(envelope.data).filter((k) => !db.STORES[k]), []);

  // Every record of every populated store.
  eq('two products', envelope.data.products.length, 2);
  eq('one sale', envelope.data.sales.length, 1);
  eq('one supplier', envelope.data.suppliers.length, 1);
  eq('one purchase', envelope.data.purchases.length, 1);
  ok('settings came through as an object', envelope.data.settings && typeof envelope.data.settings === 'object');
  eq('with the store name', envelope.data.settings.storeName, 'محل ساهر');
  eq('and the opening balance', envelope.data.settings.openingBalance, 500);

  // The counts block agrees with the arrays, because Settings shows it to a
  // person deciding whether to restore.
  eq('counts are recorded', envelope.counts, {
    products: 2, sales: 1, purchases: 1, suppliers: 1, supplierInvoices: 0, supplierPayments: 0, stockBatches: 3,
  });

  // Business fields survive — a backup of nothing but ids would be useless.
  //
  // Read the expectation from the live database rather than hardcoding it. The
  // purchase below restocks and reprices, so the live values are the only ones
  // that can be right — and "the backup equals what the shop actually holds" is
  // a stronger claim than any list of numbers.
  const live = await db.exportAll();
  const liveShirt = live.products.find((p) => p.id === 'p-shirt');
  const shirt = envelope.data.products.find((p) => p.id === 'p-shirt');
  eq('product name survives', shirt.name, liveShirt.name);
  eq('product price survives', shirt.price, liveShirt.price);
  eq('variants survive whole', shirt.variants.length, liveShirt.variants.length);
  eq('variant stock survives', shirt.variants[0].quantity, liveShirt.variants[0].quantity);
  eq('sku survives', shirt.sku, liveShirt.sku);
  eq('cost price survives', shirt.costPrice, liveShirt.costPrice);

  const sale = envelope.data.sales[0];
  const liveSale = live.sales.find((s) => s.id === 's-1');
  eq('sale lines survive', sale.items.length, liveSale.items.length);
  eq('sale arithmetic is not touched', sale.total, liveSale.total);

  const supplier = envelope.data.suppliers[0];
  const liveSupplier = live.suppliers.find((s) => s.id === 'sup-1');
  eq('supplier name survives', supplier.name, liveSupplier.name);
  eq('supplier ledger survives', supplier.openingBalance, liveSupplier.openingBalance);

  // The whole snapshot, media aside, must be identical to what is in the
  // database. This is the "complete logical snapshot" claim in one assertion.
  const stripForCompare = (v) => JSON.parse(JSON.stringify(backup.stripMedia(v)));
  const stripForCompareWithImages = (v) => {
    const copy = JSON.parse(JSON.stringify(v));
    for (const p of copy.products || []) delete p.image;
    if (copy.settings) delete copy.settings.logo;
    return copy;
  };
  const { products, sales, purchases, suppliers, supplierInvoices, supplierPayments, stockBatches, settings } = live;
  const expectedData = stripForCompareWithImages({
    products, sales, purchases, suppliers, supplierInvoices, supplierPayments, stockBatches, settings,
  });
  const actualData = JSON.parse(JSON.stringify(stripForCompare(envelope.data)));
  // `exportAll` stamps `exportedAt`/`version` at the top level only; the sections
  // themselves must match record for record.
  eq('every store matches the database record for record', actualData, expectedData);
}

/* ================================================================== *
 * 2 · NO IMAGES — the exclusion cannot be dodged
 * ================================================================== */

section('2 · product images and logos are excluded, and stay excluded');

{
  eq('a product image is gone', 'image' in (envelope.data.products.find((p) => p.id === 'p-shirt') || {}), false);
  eq('the store logo is gone', 'logo' in envelope.data.settings, false);

  // The real proof is at the byte level: no data URL anywhere in the file.
  // Checking the fields by name would pass even if something else carried one.
  ok('no data URL survives anywhere in the file', !/data:(?:image|audio|video)\//i.test(serialised));
  ok('not even the base64 prefix of one', !/data:image\/;base64/i.test(serialised));

  // …and the file says so, so a future restore never has to guess.
  eq('the file states media is excluded', envelope.media.included, false);
  ok('and says why in words a person can read',
    typeof envelope.media.policy === 'string' && envelope.media.policy.length > 20);

  // A sale line that smuggled an image in is cleaned too, even though
  // `createSale` already refuses to store one.
  ok('nothing under a sale line carries media', !/data:(?:image|audio|video)\//i.test(JSON.stringify(envelope.data.sales)));
}

{
  // The value rule, on its own: a field nobody has heard of, holding a data URL.
  const sneaky = {
    products: [{ id: 'p1', name: 'قميص', photoDataUrl: 'data:image/gif;base64,R0lGOD' }],
    // Nested arbitrarily deep, under keys that all mean something innocent.
    meta: { theme: { picture: 'data:image/webp;base64,UklGR' } },
    // And the same prefix in a non-image flavour.
    clip: 'data:video/mp4;base64,AAAA',
    voice: 'data:audio/mpeg;base64,AAAA',
    settings: { logo: 'data:image/png;base64,CCCC' },
    // A data URL under an innocuous key — the value rule has to hold
    // regardless of what the key is called.
    innocentKey: 'data:image/png;base64,BBBB',
  };
  const cleaned = backup.stripMedia(sneaky);
  const text = JSON.stringify(cleaned);

  ok('an unexpected key holding an image is stripped', !('photoDataUrl' in cleaned.products[0]));
  ok('a nested picture is stripped', !('picture' in cleaned.meta.theme));
  ok('a video payload is stripped', !('clip' in cleaned));
  ok('an audio payload is stripped', !('voice' in cleaned));
  ok('the logo is stripped', !('logo' in cleaned.settings));
  ok('no data URL survives at all', !/data:(?:image|audio|video)\//i.test(JSON.stringify(cleaned)));

  // A bare data URL with no key above it at all — the value rule has to hold
  // even where there is no key to judge by.
  eq('a bare data URL becomes empty', backup.stripMedia('data:image/png;base64,BBBB'), '');
  eq('but an ordinary bare string is untouched', backup.stripMedia('قميص'), 'قميص');

  // …and what is not media is left completely alone.
  eq('the product name is untouched', cleaned.products[0].name, 'قميص');
  ok('an ordinary nested object is untouched', cleaned.meta?.theme !== undefined);
}

{
  // A record with a self-reference cannot come out of JSON, so a backup file can
  // never contain one — but the walk also runs over whatever the database hands
  // back, and a `RangeError` thrown from inside a backup is a crash the caller
  // cannot tell apart from any other.
  const cyclic = { id: 'p-cycle', name: 'دائري' };
  cyclic.self = cyclic;

  let threw = null;
  let result = null;
  try {
    result = backup.stripMedia({ products: [cyclic] });
  } catch (err) {
    threw = err;
  }
  ok('a cyclic record does not blow the stack', threw === null, threw && `${threw.name}: ${threw.message}`);

  // The guard truncates the runaway branch rather than rejecting the envelope,
  // so what matters is only that the walk terminated and produced a plain value
  // the rest of the pipeline can handle.
  ok('it yields a plain, finite object', result !== null && typeof result === 'object');
  ok('with the record still identifiable', result.products[0].id === 'p-cycle');

  let prepareThrew = null;
  try {
    backup.prepareRestore({
      format: backup.BACKUP_FORMAT,
      version: 1,
      data: { products: [cyclic], sales: [], purchases: [], suppliers: [], supplierInvoices: [], supplierPayments: [] },
    });
  } catch (err) {
    prepareThrew = err;
  }
  ok('and the validator does not blow the stack either', prepareThrew === null);
}

{
  // By name, case-insensitively, at any depth — a hand-edited file cannot dodge.
  ok('IMAGE in caps is stripped', !('IMAGE' in backup.stripMedia({ IMAGE: 'x' })));
  ok('Logo in mixed case is stripped', !('Logo' in backup.stripMedia({ Logo: 'x' })));
  ok('a deeply nested image key is stripped',
    !('thumbnail' in backup.stripMedia({ a: { b: { c: { thumbnail: 'x' } } } })));

  // And the deep copy is a real copy: the caller's live snapshot is untouched,
  // which matters because `exportAll()` handed it to us.
  const live = { products: [{ id: 'p1', image: 'data:image/png;base64,AAAA', name: 'قميص' }] };
  const copy = backup.stripMedia(live);
  ok('the input is not mutated', 'image' in live.products[0]);
  ok('and the copy really is a different object', copy.products !== live.products);
}

{
  // A record key that merely *contains* a media word is business data. Over-eager
  // stripping would quietly destroy a shop's own fields, which is a worse bug
  // than a large backup.
  const kept = backup.stripMedia({
    products: [{ id: 'p1', attachmentRequired: false, galleryCode: 'G-7', imagesCount: 3 }],
  });
  const p = kept.products[0];
  eq('a business field named attachmentRequired survives', p.attachmentRequired, false);
  eq('a business field named galleryCode survives', p.galleryCode, 'G-7');
  eq('a business field named imagesCount survives', p.imagesCount, 3);
}

/* ================================================================== *
 * 3 · THE FORMAT AND ITS VERSION
 * ================================================================== */

section('3 · format identity and versioning');

{
  eq('the format string is stable', backup.BACKUP_FORMAT, 'storehub-backup');
  eq('the backup version is 2', backup.BACKUP_VERSION, 2);
  ok('the backup version is not the database version', backup.BACKUP_VERSION !== db.DB_VERSION,
    `both are ${backup.BACKUP_VERSION}`);
  ok('the migration registry has v1->v2 migration', typeof backup.MIGRATIONS === 'object' && Object.keys(backup.MIGRATIONS).length === 1 && typeof backup.MIGRATIONS[1] === 'function');

  const parsed = backup.deserialiseBackup(serialised);
  ok('the file parses back', parsed.ok === true);
  eq('to the same version', parsed.value.version, 2);

  const newer = backup.migrateBackup({ ...envelope, version: 3 });
  ok('a newer version is refused, not guessed at', newer.ok === false);
  eq('with a specific code', newer.code, 'UNSUPPORTED_VERSION');
  ok('and an actionable message', /تحديث|أحدث/.test(newer.message));

  const unversioned = backup.migrateBackup({ ...envelope, version: undefined });
  ok('a file with no version is refused', unversioned.ok === false);
  eq('with a specific code', unversioned.code, 'MISSING_VERSION');

  const zero = backup.migrateBackup({ ...envelope, version: 0 });
  ok('version 0 is refused', zero.ok === false);
}

/* ================================================================== *
 * 4 · VALIDATION — nothing invalid reaches the database
 * ================================================================== */

section('4 · a bad backup is refused before anything is written');

const BAD_CASES = [
  {
    label: 'not JSON at all',
    text: '{ this is not json',
    code: 'MALFORMED_JSON',
  },
  {
    label: 'an empty file',
    text: '',
    code: 'MALFORMED_JSON',
  },
  {
    label: 'JSON, but not a backup',
    text: JSON.stringify({ hello: 'world' }),
    code: 'WRONG_FORMAT',
  },
  {
    label: 'another app\'s backup',
    text: JSON.stringify({ format: 'some-other-app', version: 1, data: {} }),
    code: 'WRONG_FORMAT',
  },
  {
    label: 'a bare array',
    text: JSON.stringify([1, 2, 3]),
    code: 'MALFORMED_BACKUP',
  },
  {
    label: 'a newer format version',
    text: JSON.stringify({ ...envelope, version: 3 }),
    code: 'UNSUPPORTED_VERSION',
  },
  {
    label: 'no version at all',
    text: JSON.stringify({ format: backup.BACKUP_FORMAT, data: envelope.data }),
    code: 'MISSING_VERSION',
  },
  {
    label: 'no data section',
    text: JSON.stringify({ format: backup.BACKUP_FORMAT, version: 1 }),
    code: 'MISSING_SECTION',
  },
  {
    label: 'a missing store',
    text: JSON.stringify((() => {
      const e = JSON.parse(JSON.stringify(envelope));
      delete e.data.suppliers;
      return e;
    })()),
    code: 'MISSING_SECTION',
  },
  {
    label: 'a store that is an object, not a list',
    text: JSON.stringify((() => {
      const e = JSON.parse(JSON.stringify(envelope));
      e.data.products = { p1: {} };
      return e;
    })()),
    code: 'MISSING_SECTION',
  },
  {
    label: 'a record that is not an object',
    text: JSON.stringify((() => {
      const e = JSON.parse(JSON.stringify(envelope));
      e.data.products = ['not a record'];
      return e;
    })()),
    code: 'INVALID_RECORD',
  },
  {
    label: 'a record with no id',
    text: JSON.stringify((() => {
      const e = JSON.parse(JSON.stringify(envelope));
      e.data.products = [{ name: 'بلا مُعرّف' }];
      return e;
    })()),
    code: 'INVALID_RECORD',
  },
  {
    label: 'a record with an empty id',
    text: JSON.stringify((() => {
      const e = JSON.parse(JSON.stringify(envelope));
      e.data.products = [{ id: '', name: 'فارغ' }];
      return e;
    })()),
    code: 'INVALID_RECORD',
  },
  {
    label: 'a sale whose items are not a list',
    text: JSON.stringify((() => {
      const e = JSON.parse(JSON.stringify(envelope));
      e.data.sales = [{ id: 's1', items: 'nope' }];
      return e;
    })()),
    code: 'INVALID_RECORD',
  },
  {
    label: 'a null where the data should be',
    text: JSON.stringify({ format: backup.BACKUP_FORMAT, version: 1, data: null }),
    code: 'MISSING_SECTION',
  },
];

{
  const before = await shopFingerprint();

  for (const badCase of BAD_CASES) {
    const parsed = backup.deserialiseBackup(badCase.text);
    if (!parsed.ok) {
      eq(`${badCase.label} — refused at the JSON stage`, parsed.code, badCase.code);
      continue;
    }
    const prepared = backup.prepareRestore(parsed.value);
    eq(`${badCase.label} — refused at the validator`, prepared.code, badCase.code);
  }

  eq('and not one of them touched the shop', await shopFingerprint(), before);
}

{
  // A legacy file — a bare `exportAll()` dump, which the app has been producing
  // since long before Drive existed — must still restore. One validator serving
  // both is better than two validators that can disagree.
  const legacy = { app: 'saher', version: db.DB_VERSION, exportedAt: '2025-01-01T00:00:00.000Z',
    products: [{ id: 'p1', name: 'قميص', price: 10, image: 'data:image/png;base64,AAAA' }],
    sales: [], settings: { key: 'app', storeName: 'محل قديم' } };
  const prepared = backup.prepareRestore(legacy);
  ok('a legacy export is accepted', prepared.ok === true);
  eq('and is wrapped in the current format', prepared.envelope.version, backup.BACKUP_VERSION);
  eq('with its createdAt carried across', prepared.createdAt, '2025-01-01T00:00:00.000Z');
  ok('and its image stripped on the way in', !('image' in prepared.legacy.products[0]));
}

/* ================================================================== *
 * 5 · RESTORE — correct, complete, and all-or-nothing
 * ================================================================== */

section('5 · restore replaces the shop, and only with a validated backup');

{
  const before = await shopFingerprint();
  const prepared = backup.prepareRestore(envelope);
  ok('the good backup validates', prepared.ok === true);

  const result = await backup.applyRestore(db, prepared, { appVersion: '1.0.0' });
  ok('it restored', Boolean(result));
  ok('and returned a safety snapshot', Boolean(result.safetySnapshot));
  eq('the safety snapshot is a versioned envelope', result.safetySnapshot.format, backup.BACKUP_FORMAT);

  // The shop is back where it started.
  const after = await db.exportAll();
  eq('the products came back', after.products.length, 2);
  eq('the sale came back', after.sales.length, 1);
  eq('the supplier came back', after.suppliers.length, 1);
  eq('the store name came back', after.settings.storeName, 'محل ساهر');

  // …and the images did not, because the file never had them.
  //
  // `getSettings()` merges the defaults, and the default for `logo` is an empty
  // string — so the assertion is that it is *empty*, not that the key is gone.
  // A shop that had uploaded a logo is left with none, which is the whole point
  // of excluding media: the field exists, it just holds nothing.
  eq('a restored product has no image', 'image' in after.products[0], false);
  eq('restored settings carry no logo', after.settings.logo, '');

  const summary = backup.describeBackup(prepared);
  eq('the description matches the counts', summary.products, 2);
  eq('and names the source', summary.createdAt, '2026-03-01T00:00:00.000Z');
}

{
  // The safety snapshot is the *current* shop, not the restored one — it is
  // what makes a restore undoable. Check it against what was there before.
  const prepared = backup.prepareRestore(envelope);
  const before = await db.exportAll();
  const result = await backup.applyRestore(db, prepared);

  eq('the safety snapshot has the pre-restore products', result.safetySnapshot.data.products.length,
    before.products.length);
  ok('and it is not the file that was restored',
    result.safetySnapshot.data.products.length !== prepared.envelope.data.products.length ||
    JSON.stringify(result.safetySnapshot.createdAt) !== JSON.stringify(prepared.envelope.createdAt));

  // Never uploaded — §10 is explicit, and an unasked-for upload would overwrite
  // the very backup being restored. `applyRestore` has no Drive dependency at
  // all, which is the structural reason it cannot.
  const src = await readSrc('js/backup.js');
  ok('backup.js has no network dependency whatsoever', !/\bfetch\b/.test(src));
  ok('and never imports the Drive client', !/from\s+['"]\.\/drive-client\.js/.test(src));
}

{
  // An invalid "prepared" object must be refused outright. `applyRestore`
  // trusting its caller would mean any future call site could skip the gate.
  const err = await rejects('an unprepared object is refused', backup.applyRestore(db, { data: {} }));
  ok('with a message that says what is needed', /validated/i.test(err?.message || ''));

  const err2 = await rejects('a null prepared object is refused', backup.applyRestore(db, null));
  ok('with a message that says what is needed', /validated/i.test(err2?.message || ''));

  const err3 = await rejects('a db without importAll is refused',
    backup.applyRestore({}, backup.prepareRestore(envelope)));
  ok('with a message that says what is needed', /data layer/i.test(err3?.message || ''));
}

{
  // `importAll` has its own last-line guard, and it is worth proving that it
  // fires *before* the transaction opens — that is the difference between "the
  // shop was left alone" and "the shop was half-replaced".
  //
  // The way to reach it is to hand `applyRestore` a validated backup and then
  // tamper with it, which is exactly the mistake a future call site could make.
  await db.clearAll();
  await seedShop();
  const before = await shopFingerprint();

  const prepared = backup.prepareRestore(envelope);
  ok('the backup validates', prepared.ok === true);
  prepared.legacy.app = 'not-saher'; // breaks importAll's own check

  const err = await rejects('a tampered backup is refused at the import', backup.applyRestore(db, prepared));
  ok('with a message from the data layer', Boolean(err?.message));
  eq('and the shop is untouched', await shopFingerprint(), before);

  // And the same for a prepared object whose store list was replaced wholesale.
  const prepared2 = backup.prepareRestore(envelope);
  prepared2.legacy.products = 'not a list';
  await rejects('a tampered store list is refused', backup.applyRestore(db, prepared2));
  eq('and the shop is still untouched', await shopFingerprint(), before);

  // A well-formed restore still works afterwards, so nothing above left the
  // database wedged.
  await backup.applyRestore(db, backup.prepareRestore(envelope));
  ok('a good restore still works', (await db.exportAll()).products.length >= 2);
}

{
  // A restore into an empty shop, then a second restore over it. This is the
  // "replacing a whole shop" flow the feature exists for.
  await db.clearAll();
  eq('the shop is empty', (await db.exportAll()).products.length, 0);

  const prepared = backup.prepareRestore(envelope);
  await backup.applyRestore(db, prepared);
  eq('the first restore brought the shop back', (await db.exportAll()).products.length, 2);

  // A second, different backup replaces it wholesale rather than merging.
  const other = backup.buildBackupEnvelope(
    { products: [{ id: 'p-only', name: 'منتج آخر', price: 5, image: 'data:image/png;base64,ZZ' }] },
    { createdAt: '2026-04-01T00:00:00.000Z' },
  );
  await backup.applyRestore(db, backup.prepareRestore(other));
  const final = await db.exportAll();
  eq('the second restore replaced, not merged', final.products.length, 1);
  eq('with the new product', final.products[0].id, 'p-only');
  eq('and removed the old one', final.products.some((p) => p.id === 'p-shirt'), false);
  eq('and left no image behind', 'image' in final.products[0], false);
}

/* ================================================================== *
 * 6 · SCHEDULING — the weekly gate
 * ================================================================== */

const scheduler = await import(js('backup-scheduler.js'));

section('6 · the backup runs at most weekly, and only when everything allows it');

{
  const DAY = 24 * 60 * 60 * 1000;
  const T0 = Date.parse('2026-03-01T00:00:00.000Z');
  const allYes = {
    online: true,
    authenticated: true,
    entitled: true,
    driveConnected: true,
    enabled: true,
    now: T0,
  };

  const plan = (overrides) => scheduler.planBackup({ ...allYes, ...overrides });

  eq('the interval is a week', scheduler.BACKUP_INTERVAL_DAYS, 7);

  ok('never backed up → due immediately', plan({ record: null }).shouldRun === true);
  ok('no record at all → due', plan({ record: undefined }).shouldRun === true);

  const sixDays = { lastSuccessAt: new Date(T0 - 6 * DAY).toISOString() };
  eq('six days after a success → not due', plan({ record: sixDays }).reason, scheduler.SKIP.NOT_DUE);

  const exactlySeven = { lastSuccessAt: new Date(T0 - 7 * DAY).toISOString() };
  ok('exactly seven days → due', plan({ record: exactlySeven }).shouldRun === true);

  const eightDays = { lastSuccessAt: new Date(T0 - 8 * DAY).toISOString() };
  ok('eight days → due', plan({ record: eightDays }).shouldRun === true);

  // Every gate, one at a time. Each must be silent — a shop that is offline
  // must not see a complaint.
  eq('offline → skipped quietly', plan({ online: false }).reason, scheduler.SKIP.OFFLINE);
  eq('not signed in → skipped quietly', plan({ authenticated: false }).reason, scheduler.SKIP.NOT_AUTHENTICATED);
  eq('not entitled → skipped quietly', plan({ entitled: false }).reason, scheduler.SKIP.NOT_ENTITLED);
  eq('Drive not connected → skipped quietly', plan({ driveConnected: false }).reason, scheduler.SKIP.DRIVE_NOT_CONNECTED);
  eq('the feature switched off → skipped quietly', plan({ enabled: false }).reason, scheduler.SKIP.DISABLED);
  eq('a run already in flight → skipped quietly', plan({ running: true }).reason, scheduler.SKIP.ALREADY_RUNNING);

  // A manual run overrides the week, but every other gate still applies — a shop
  // that is offline cannot back up just because someone tapped the button.
  ok('a forced run is allowed before the week is up', plan({ record: sixDays, forced: true }).shouldRun === true);
  eq('offline is still offline, forced or not',
    plan({ record: sixDays, forced: true, online: false }).reason, scheduler.SKIP.OFFLINE);
  eq('and Drive still has to be connected',
    plan({ record: sixDays, forced: true, driveConnected: false }).reason,
    scheduler.SKIP.DRIVE_NOT_CONNECTED);

  // Gate order: the cheapest and most common first, so a shop in a basement
  // answers immediately without touching anything else.
  const reasons = [
    plan({ enabled: false, online: false, authenticated: false }).reason,
    plan({ running: true, online: false }).reason,
    plan({ online: false, authenticated: false }).reason,
    plan({ authenticated: false, entitled: false }).reason,
    plan({ entitled: false, driveConnected: false }).reason,
  ];
  eq('gates are checked in order of how often they are hit', reasons, [
    scheduler.SKIP.DISABLED,
    scheduler.SKIP.ALREADY_RUNNING,
    scheduler.SKIP.OFFLINE,
    scheduler.SKIP.NOT_AUTHENTICATED,
    scheduler.SKIP.NOT_ENTITLED,
  ]);

  // The display maths, since Settings shows it.
  eq('six days since last backup reads as one day remaining', scheduler.daysUntilDue(sixDays, T0), 1);
  eq('a week out reads as zero', scheduler.daysUntilDue(sixDays, T0 + 6 * DAY), 0);
  eq('an overdue backup reads as zero, never negative',
    scheduler.daysUntilDue(eightDays, T0 + 30 * DAY), 0);
  eq('never backed up has no due date to show', scheduler.daysUntilDue(null, T0), null);
  eq('an unreadable timestamp has no due date either',
    scheduler.daysUntilDue({ lastSuccessAt: 'not a date' }, T0), null);
  eq('and nextDueAt is null for it too',
    scheduler.nextDueAt({ lastSuccessAt: 'not a date' }), null);
}

section('7 · a failed backup is recorded and retried, never fatal');

{
  // A scripted record store, so the assertions are about what the scheduler
  // wrote rather than about IndexedDB. The database is shared, so re-seed to
  // a known state — the previous section's "replace a whole shop" test left
  // the database with one product.
  await db.clearAll();
  await seedShop();

  const written = [];
  const saveRecord = async (patch) => {
    Object.assign(record, patch);
    written.push(patch);
    return record;
  };
  let record = { lastSuccessAt: null, status: scheduler.BACKUP_STATUS.NEVER };

  const deps = {
    db,
    record,
    online: true,
    authenticated: true,
    entitled: true,
    driveConnected: true,
    getAccessToken: async () => 'ya29.test-token',
    now: () => Date.parse('2026-03-01T00:00:00.000Z'),
    saveRecord,
    // The Drive is unreachable, which is the interesting case.
    fetchImpl: async () => {
      throw new Error('no network in this test');
    },
  };

  const failed = await scheduler.maybeRunBackup(deps);
  eq('a failing backup reports failure', failed.ok, false);
  eq('without pretending it was a skip', failed.skipped, false);
  eq('and the reason is a failure, not a gate', failed.reason, 'failed');
  ok('with the message recorded', typeof failed.error === 'string' && failed.error.length > 0);
  eq('the status is error', record.status, scheduler.BACKUP_STATUS.ERROR);
  eq('lastSuccessAt was NOT advanced', record.lastSuccessAt, null);

  // The shop is untouched, and no token was requested — the failure came first.
  eq('the local data is intact', (await db.exportAll()).products.length, 2);

  // Retried on the next eligible launch, because the week is still up.
  const retried = await scheduler.maybeRunBackup({ ...deps, record });
  eq('it is attempted again', retried.reason, 'failed');
  eq('and is not throttled to once a week', written.filter((w) => w.status === scheduler.BACKUP_STATUS.RUNNING).length, 2);

  // A gate that says no writes nothing at all — no "running", no status churn.
  const writesBefore = written.length;
  const skipped = await scheduler.maybeRunBackup({ ...deps, record, online: false });
  eq('an offline launch writes nothing', written.length, writesBefore);
  eq('and is reported as an offline skip', skipped.reason, scheduler.SKIP.OFFLINE);
  eq('which is a skip, not a failure', skipped.skipped, true);
  eq('and carries no error', skipped.error, undefined);

  // After a success the week closes.
  record.lastSuccessAt = '2026-03-01T00:00:00.000Z';
  const tooSoon = await scheduler.maybeRunBackup({ ...deps, record });
  eq('a successful backup is not repeated within the week', tooSoon.reason, scheduler.SKIP.NOT_DUE);

  // A week later it is due again — the previous failure did not permanently
  // block the feature. The next backup is due on March 8, not March 15.
  record.lastSuccessAt = '2026-03-01T00:00:00.000Z';
  record.status = scheduler.BACKUP_STATUS.ERROR;
  const due = scheduler.planBackup({
    record, online: true, authenticated: true, entitled: true,
    driveConnected: true, now: Date.parse('2026-03-08T00:00:00.000Z'),
  });
  ok('and is due again exactly a week later', due.shouldRun === true,
    `a stale failure did not block the retry: reason=${due.reason}`);
}

section('8 · a successful backup records only what it must');

{
  // Re-seed to a known state.
  await db.clearAll();
  await seedShop();

  const record = { lastSuccessAt: null };
  const saved = [];
  let storedFetch = null;

  // A minimal Drive that matches the real client's URL patterns in order.
  const folderId = 'folder-x';
  const fileId = 'new-file';
  let jsonSize = 0; // the actual JSON payload size (what Drive reports)
  const fakeFetch = async (url, init = {}) => {
    storedFetch = { url: String(url), method: init.method };
    const u = String(url);
    const text = typeof init.body === 'string' ? init.body : '';

    // The order matters: findBackupFolder's URL contains BOTH mimeType= AND fields=,
    // so it must be checked BEFORE the metadata check which also looks for fields=.
    // Real call order: find folder → list files → upload → metadata → delete.

    // 1. findBackupFolder -> GET with mimeType= and name= (also has fields=!)
    if (u.includes('mimeType=') && u.includes('name=')) {
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ files: [{ id: folderId, name: 'Store Hub Backups' }] }),
        json: async () => ({ files: [{ id: folderId, name: 'Store Hub Backups' }] }),
      };
    }

    // 2. listBackupFiles -> GET with 'folder-id' in parents (also has fields=!)
    if (u.includes("'") && u.includes('in parents')) {
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ files: [] }),
        json: async () => ({ files: [] }),
      };
    }

    // 3. upload -> multipart POST to upload endpoint
    if (u.includes('/upload/drive/v3/files') && u.includes('uploadType=multipart')) {
      // The multipart body: boundary, metadata headers, metadata, boundary, JSON headers, JSON, boundary--
      // The first boundary has no leading CRLF, subsequent ones do.
      const boundary = '\r\n--storehub-backup-boundary';
      const parts = text.split(boundary);
      // parts[0] = first boundary + metadata headers
      // parts[1] = second boundary + JSON headers + JSON body
      // parts[2] = closing boundary
      const jsonPart = parts[1] || '';
      const jsonBody = jsonPart.split('\r\n\r\n')[1] || '';
      jsonSize = new TextEncoder().encode(jsonBody).length;

      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ id: fileId, name: 'storehub-backup.json', size: jsonSize }),
        json: async () => ({ id: fileId, name: 'storehub-backup.json', size: jsonSize }),
      };
    }

    // 4. getFileMetadata -> GET /files/{id}?fields= (no mimeType, no in parents)
    if (u.includes('/files/') && u.includes('fields=') && !u.includes('mimeType=') && !u.includes("in parents")) {
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ id: fileId, name: 'storehub-backup.json', size: jsonSize, trashed: false }),
        json: async () => ({ id: fileId, name: 'storehub-backup.json', size: jsonSize, trashed: false }),
      };
    }

    // 5. createBackupFolder -> POST /files (folder creation)
    if (u.endsWith('/files') && init.method === 'POST' && !u.includes('/upload/')) {
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ id: folderId, name: 'Store Hub Backups', mimeType: 'application/vnd.google-apps.folder' }),
        json: async () => ({ id: folderId, name: 'Store Hub Backups', mimeType: 'application/vnd.google-apps.folder' }),
      };
    }

    return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
  };

  const outcome = await scheduler.maybeRunBackup({
    db,
    record,
    online: true,
    authenticated: true,
    entitled: true,
    driveConnected: true,
    getAccessToken: async () => 'ya29.test-token',
    appVersion: '1.0.0',
    now: () => Date.parse('2026-03-01T00:00:00.000Z'),
    saveRecord: async (patch) => { Object.assign(record, patch); saved.push(patch); return record; },
    fetchImpl: fakeFetch,
  });

  ok('the backup succeeded', outcome.ok === true, `reason=${outcome.reason} error=${outcome.error}`);
  eq('the file id was recorded', record.fileId, fileId);
  eq('the folder id was recorded', record.folderId, folderId);
  eq('the format version was recorded', record.formatVersion, 2);
  eq('the success time was recorded', record.lastSuccessAt, '2026-03-01T00:00:00.000Z');
  eq('the status is ok', record.status, 'ok');
  ok('a byte count was recorded', typeof record.bytes === 'number' && record.bytes > 0);
  eq('counts were recorded', record.counts.products, 2);

  // The record holds metadata and nothing else. A token here would be a
  // credential sitting in IndexedDB forever.
  const recordKeys = Object.keys(record).sort();
  ok('the record has no token field', !recordKeys.some((k) => /token|secret|refresh|access/i.test(k)),
    `saw ${recordKeys.join(', ')}`);
  const recordText = JSON.stringify(record);
  ok('and no token value in it', !/ya29\.|1\/\/|ya29|refresh_token/.test(recordText));
  ok('and no product data in it', !/قميص|بنطال/.test(recordText));

  ok('Drive was actually contacted', storedFetch !== null);
  ok('and it was Drive, not the backend', storedFetch.url.startsWith('https://www.googleapis.com/'));
}

/* ================================================================== *
 * 9 · THE FILE NEVER TOUCHES THE BACKEND
 * ================================================================== */

section('9 · the backup contents never pass through the backend');

{
  // Three separate claims, checked three separate ways. Any one of them alone
  // would be satisfiable by an implementation that broke the other two.

  // (a) The serializer has no network dependency at all.
  const backupSrc = await readSrc('js/backup.js');
  ok('backup.js never calls fetch', !/\bfetch\b/.test(backupSrc));
  ok('backup.js imports nothing from the Drive client', !/from\s+['"]\.\/drive-client\.js/.test(backupSrc));
  ok('backup.js imports nothing that talks to the backend',
    !/from\s+['"]\.\/(?:license-client|auth-client|drive-auth-client)\.js/.test(backupSrc));

  // (b) The local record that tracks backups carries metadata only.
  const identitySrc = await readSrc('js/identity-store.js');
  const recordBlock = identitySrc.slice(identitySrc.indexOf('export async function saveBackupRecord'));
  ok('the backup record writer mentions no token', !/token/i.test(recordBlock));
  ok('and no product, sale or invoice field', !/product|sale|invoice|supplier|settings/i.test(recordBlock));

  // (c) The backup metadata lives in the identity database, not the shop
  // database — so `exportAll()` can never sweep a credential into the file it
  // is about to upload, and `importAll()` can never write one back.
  const identity = await import(js('identity-store.js'));
  ok('there is a separate backup store', 'backup' in identity.IDENTITY_STORES);
  const dbSrc = await readSrc('js/db.js');
  ok('the shop database module never names the identity database',
    !dbSrc.includes('storehub_identity'));
  ok('and backup.js does not either', !backupSrc.includes('storehub_identity'));
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

process.exitCode = failed === 0 ? 0 : 1;
