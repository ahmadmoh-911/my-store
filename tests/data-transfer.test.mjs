/**
 * The full-backup file: build it, verify it, refuse a bad one, restore it.
 *
 * This is the module a customer's data depends on, so the tests are written
 * around the two claims that matter:
 *
 *   1. a round trip is LOSSLESS — every record of every table, byte for byte,
 *      including Arabic text, media and awkward floating-point money; and
 *   2. a restore is ALL OR NOTHING — a file that is wrong is refused before the
 *      database is touched, and a restore that goes wrong half-way leaves the
 *      shop exactly as it was.
 *
 * Where a claim cannot be tested by observation alone (the whole point of the
 * fingerprint is that a tampered file is detected), the test builds the tamper
 * itself and asserts the refusal — and then asserts the data is untouched,
 * because "it was rejected" is worth nothing without "and nothing changed".
 */

import { createFakeIndexedDB } from './fake-indexeddb.mjs';
import { createFakeLocalStorage } from './fake-localstorage.mjs';

const js = (rel) => new URL(`../js/${rel}`, import.meta.url).href;
const readSrc = (rel) =>
  import('node:fs').then((fs) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'));

/* ------------------------------------------------------------------ *
 * Tiny runner
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
 * The world the module runs in
 * ------------------------------------------------------------------ */

globalThis.indexedDB = createFakeIndexedDB();
const fakeStorage = createFakeLocalStorage();
globalThis.localStorage = fakeStorage;

const db = await import(js('db.js'));
const xfer = await import(js('data-transfer.js'));

/* ------------------------------------------------------------------ *
 * Comparison helpers
 *
 * `canon` is the deep comparison: every record of every table, serialised and
 * sorted, so two databases are "the same" only if their CONTENT is the same and
 * never merely because the counts line up.
 * ------------------------------------------------------------------ */

const canon = (stores) => JSON.stringify(
  Object.fromEntries(
    Object.keys(stores).sort().map((k) => [
      k,
      (stores[k] || []).map((r) => JSON.stringify(r)).sort(),
    ]),
  ),
);

const countsOf = (stores) => Object.fromEntries(
  Object.keys(stores).sort().map((k) => [k, (stores[k] || []).length]),
);

/** A deep, order-independent picture of the database as it is right now. */
const snap = async () => canon(await xfer.readAllStores());

/** The payload the fingerprint must cover, rebuilt independently of the module. */
const fingerprintOf = async (file) => xfer.sha256Hex(
  JSON.stringify({ stores: file.stores, storage: file.storage, counters: file.counters }),
);

async function clearAll() {
  for (const name of Object.values(db.STORES)) await db.clearStore(name);
}

/* ------------------------------------------------------------------ *
 * A large, realistic shop
 *
 * Written through the app's own write functions, not by poking records in, so
 * the shapes in the file are the shapes the app actually produces — variant
 * lists, FIFO stock batches, supplier ledgers, discounts and all.
 * ------------------------------------------------------------------ */

const PRODUCTS = 30;
const VARIANTS = 3;
const SUPPLIERS = 3;
const INVOICES = 40;
const PAYMENTS = 40;
const PURCHASES = 40;
const SALES = 1200;

const colorFor = (v) => (v % 2 ? 'أبيض' : 'أسود');

async function seedShop() {
  for (let i = 0; i < PRODUCTS; i++) {
    await db.saveProduct({
      id: `p-${i}`,
      name: `منتج رقم ${i} — قميص`,
      sku: `SKU-${String(i).padStart(4, '0')}`,
      category: i % 2 ? 'قمصان وبلوزات' : 'بناطيل',
      description: `وصف تفصيلي للمنتج ${i}`,
      price: 20 + i + 0.1,
      costPrice: 10 + i + 0.2,
      variants: Array.from({ length: VARIANTS }, (_, v) => ({
        size: `S${v}`,
        color: colorFor(v),
        quantity: 1000,
      })),
      image: i === 0 ? 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' : '',
    });
  }

  for (let i = 0; i < SUPPLIERS; i++) {
    await db.saveSupplier({
      id: `sup-${i}`,
      name: `مورد ${i}`,
      phone: `059000000${i}`,
      notes: `ملاحظة المورد ${i}`,
      openingBalance: 100.25 + i,
    });
  }

  for (let i = 0; i < INVOICES; i++) {
    await db.createSupplierInvoice({
      id: `inv-${i}`,
      supplierId: `sup-${i % SUPPLIERS}`,
      invoiceNo: `INV-${i}`,
      date: new Date(Date.UTC(2026, 0, 1 + (i % 27))).toISOString(),
      items: [
        { name: 'قماش', qty: 2, price: 3.33 },
        { name: 'خيط', qty: 1, price: 0.07 },
      ],
      discount: 0.1,
      paid: 1.1,
      note: `ملاحظة الفاتورة ${i}`,
    });
  }

  for (let i = 0; i < PAYMENTS; i++) {
    await db.createSupplierPayment({
      id: `pay-${i}`,
      supplierId: `sup-${i % SUPPLIERS}`,
      amount: 2.22,
      method: 'cash',
      note: '',
    });
  }

  for (let i = 0; i < PURCHASES; i++) {
    const p = i % PRODUCTS;
    const v = i % VARIANTS;
    await db.createPurchase({
      id: `po-${i}`,
      productId: `p-${p}`,
      supplierId: `sup-${i % SUPPLIERS}`,
      supplierName: `مورد ${i % SUPPLIERS}`,
      productName: `منتج رقم ${p} — قميص`,
      lines: [{ size: `S${v}`, color: colorFor(v), qty: 5 }],
      unitCost: 12.5,
      newPrice: null,
    });
  }

  for (let i = 0; i < SALES; i++) {
    const p = i % PRODUCTS;
    const v = i % VARIANTS;
    await db.createSale({
      id: `s-${i}`,
      receiptSeq: (i % 50) + 1,
      items: [{
        productId: `p-${p}`,
        name: `منتج رقم ${p} — قميص`,
        size: `S${v}`,
        color: colorFor(v),
        qty: 1,
        price: 25 + (i % 13) + 0.1,
        costPrice: 10,
      }],
      discountValue: i % 5 === 0 ? 0.05 : 0,
      discountType: 'fixed',
      priceIncrease: i % 17 === 0 ? 0.1 : 0,
      paymentMethod: i % 3 ? 'cash' : 'credit',
      timestamp: new Date(Date.UTC(2026, 2, 1 + (i % 28), i % 24)).toISOString(),
      note: '',
    });
  }

  await db.saveSettings({
    storeName: 'محل ساهر للاختبار',
    ownerName: 'ساهر',
    phone: '0599123456',
    openingBalance: 1500.75,
    currency: 'ILS',
    receiptFooter: 'شكراً لتسوقكم معنا',
    logo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
  });
}

/* ================================================================== *
 * 0 · SHA-256, because the whole file's integrity rests on it
 * ================================================================== */

section('0 · SHA-256, the file\'s integrity check');

{
  const enc = (s) => new TextEncoder().encode(s);

  eq('the empty string hashes to the published value',
    xfer.sha256HexPure(enc('')),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  eq('"abc" hashes to the published value',
    xfer.sha256HexPure(enc('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  eq('the classic pangram hashes to the published value',
    xfer.sha256HexPure(enc('The quick brown fox jumps over the lazy dog')),
    'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592');

  // The pure implementation is used whenever `crypto.subtle` is missing (an
  // APK has a secure context; a copy served over plain http on a shop's LAN
  // does not). If the two ever disagreed, one of them would be reporting a
  // perfect file as corrupt — so they are compared at every padding boundary.
  const subtleAvailable = Boolean(globalThis.crypto?.subtle);
  ok('crypto.subtle is available in this runtime, so both paths are compared', subtleAvailable);
  if (subtleAvailable) {
    for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 1000]) {
      const s = 'a'.repeat(n);
      eq(`both implementations agree at ${n} bytes`, xfer.sha256HexPure(enc(s)), await xfer.sha256Hex(s));
    }
    eq('and agree on Arabic text',
      xfer.sha256HexPure(enc('محل ساهر — ١٥٠٠٫٧٥')),
      await xfer.sha256Hex('محل ساهر — ١٥٠٠٫٧٥'));
  }

  const digest = await xfer.sha256Hex('اختبار');
  ok('a digest is 64 lowercase hex characters', /^[0-9a-f]{64}$/.test(digest), digest);
}

/* ================================================================== *
 * 1 · a large shop, exported
 * ================================================================== */

section('1 · a large, realistic shop exports completely');

await seedShop();

let file;
let fileText;
let liveCounts;
{
  const live = await xfer.readAllStores();
  liveCounts = countsOf(live);

  ok('the shop really is large', (liveCounts.sales || 0) >= 1000, `${liveCounts.sales} sales`);
  ok('with every table populated',
    ['products', 'sales', 'purchases', 'suppliers', 'supplierInvoices', 'supplierPayments', 'stockBatches', 'settings']
      .every((k) => liveCounts[k] > 0),
    JSON.stringify(liveCounts));

  file = await xfer.buildBackupFile({ appVersion: '1.0.0-interim' });
  fileText = JSON.stringify(file, null, 2);

  eq('the file declares format version 2', file.formatVersion, 2);
  eq('and its kind', file.kind, xfer.FORMAT_KIND);
  eq('and the schema it came from', file.schemaVersion, db.DB_VERSION);

  const verdict = await xfer.validateBackupFile(fileText);
  ok('the file passes its own validator', verdict.ok, verdict.error);
  eq('and is read as version 2', verdict.formatVersion, 2);
  eq('the fingerprint verifies', (await xfer.verifyFingerprint(file)).ok, true);

  // Completeness is measured against the LIVE schema, not a restated list. A
  // table added later that the export forgot would show up right here.
  eq('every live table is in the file', Object.keys(countsOf(file.stores)), Object.keys(liveCounts));
  eq('and every table is carried whole', countsOf(file.stores), liveCounts);
  eq('everything in the file matches the live shop, record for record',
    canon(file.stores), canon(live));
  eq('the financial totals were derived from the live shop', file.totals, xfer.computeTotals(live));
  eq('and the counters too', file.counters, xfer.computeCounters(live));

  // Content, not just shape.
  const product = file.stores.products.find((p) => p.id === 'p-0');
  ok('Arabic product names survive', product.name.includes('منتج رقم 0'));
  eq('variant stock survives', product.variants.length, VARIANTS);
  ok('a data-URL image is carried verbatim as text',
    product.image.startsWith('data:image/png;base64,'));
  const sale = file.stores.sales.find((s) => s.id === 's-0');
  ok('a sale carries its line items', Array.isArray(sale.items) && sale.items.length === 1);
  ok('and its FIFO batches consumed', Array.isArray(sale.stockBatchesConsumed));
  const supplier = file.stores.suppliers.find((s) => s.id === 'sup-0');
  eq('a supplier ledger survives', supplier.openingBalance, 100.25);

  // The activation flag must never be in a file: restoring one must not be able
  // to re-lock a device with somebody else's gate.
  ok('the file carries no activation state', file.activation === null);
  ok('and nothing under the interim prefix',
    !fileText.includes('saher.interim.'));
}

/* ================================================================== *
 * 2 · restoring onto an empty device
 * ================================================================== */

section('2 · the file restores onto an empty device, record for record');

{
  await clearAll();
  const empty = await xfer.readAllStores();
  ok('the device really is empty', Object.values(countsOf(empty)).every((n) => n === 0));

  const result = await xfer.importBackupFile(file, file.formatVersion);
  ok('the restore reports success', result.ok === true);

  const after = await xfer.readAllStores();
  eq('every record of every table came back byte-identical', canon(after), canon(file.stores));
  eq('the counts match the file', countsOf(after), countsOf(file.stores));
  eq('the recomputed totals match the file', xfer.computeTotals(after), file.totals);
  eq('the recomputed counters match the file', xfer.computeCounters(after), file.counters);

  const settings = after.settings.find((s) => s.key === 'app');
  eq('the shop identity came back', settings.storeName, 'محل ساهر للاختبار');
  eq('including the opening balance', settings.openingBalance, 1500.75);
}

/* ================================================================== *
 * 3 · files that must be refused — before anything is touched
 * ================================================================== */

section('3 · a wrong file is refused, and the shop is left alone');

{
  const clone = () => JSON.parse(fileText);

  /** Validates `text`, expects refusal, and asserts the database never moved. */
  async function expectRefused(label, text, pattern) {
    const before = await snap();
    const verdict = await xfer.validateBackupFile(text);
    if (verdict.ok) {
      ok(label, false, 'it validated when it should have been refused');
      return;
    }
    ok(label, pattern.test(verdict.error), verdict.error);
    eq(`${label} — data untouched`, await snap(), before);
  }

  // (a) one value changed inside the payload: the fingerprint is the only thing
  //     that can notice, and this is the case the fingerprint exists for.
  {
    const tampered = clone();
    tampered.stores.products[0].price = tampered.stores.products[0].price + 1;
    await expectRefused('a hand-edited product price is refused', JSON.stringify(tampered), /بصمة/);
  }

  // (b) the fingerprint itself rewritten.
  {
    const tampered = clone();
    tampered.fingerprint.value = 'f'.repeat(64);
    await expectRefused('a rewritten fingerprint is refused', JSON.stringify(tampered), /بصمة/);
  }

  // (c) truncated mid-file: the classic half-written download.
  {
    const truncated = fileText.slice(0, Math.floor(fileText.length * 0.6));
    await expectRefused('a truncated file is refused', truncated, /JSON/);
  }

  // (d) not even JSON.
  await expectRefused('a corrupt file is refused', '{ "formatVersion": 2, oops', /JSON/);

  // (e) a file from a NEWER app: guessing at a format you do not know is how a
  //     restore silently drops a column, so it must fail with advice.
  {
    const newer = clone();
    newer.formatVersion = 3;
    await expectRefused('a newer format is refused with advice', JSON.stringify(newer), /أحدث|حدّث/);
  }

  // (f) something that is simply not our file at all.
  await expectRefused('a foreign JSON document is refused', '{"hello":"world"}', /Store Hub/);
  await expectRefused('a JSON array is refused', '[]', /صالح/);

  // (g) a Google Drive backup is a different family with its own restore path;
  //     it is refused here rather than half-understood.
  {
    const drive = { app: 'saher', formatVersion: 2, sections: { products: [] } };
    await expectRefused('a Drive backup is refused here with a pointer', JSON.stringify(drive), /Google Drive/);
  }

  // (h) a v2 file with no fingerprint at all.
  {
    const noFp = clone();
    delete noFp.fingerprint;
    await expectRefused('a file with no fingerprint is refused', JSON.stringify(noFp), /مرفوض|بصمة/);
  }

  // (i) a legacy v1 file with no product list.
  await expectRefused('a legacy file with no products is refused', '{"app":"saher"}', /المنتجات/);

  // (j) a table the file names and this build does not have. The fingerprint is
  //     recomputed over the tampered payload, so validation PASSES and the
  //     refusal has to come from the import itself — before the write.
  {
    const before = await snap();
    const evil = clone();
    evil.stores.__evil__ = [];
    evil.fingerprint.value = await fingerprintOf(evil);

    const verdict = await xfer.validateBackupFile(JSON.stringify(evil));
    ok('an unknown table still validates structurally', verdict.ok, verdict.error);
    const err = await rejects('but the import refuses it', xfer.importBackupFile(verdict.file, verdict.formatVersion));
    ok('with a message naming the table', /__evil__/.test(err?.message || ''), err?.message);
    eq('and the shop is untouched', await snap(), before);
  }
}

/* ================================================================== *
 * 4 · an older file, in a newer build
 * ================================================================== */

section('4 · an older file is still readable, and cannot wipe what it omits');

{
  // A file from the oldest shipped format: the bare `db.exportAll()` shape,
  // which `db.exportAll` still produces today and old devices still hold.
  const legacy = await db.exportAll();
  const legacyText = JSON.stringify(legacy);

  const verdict = await xfer.validateBackupFile(legacyText);
  ok('a legacy exportAll file is accepted', verdict.ok, verdict.error);
  eq('and recognised as version 1', verdict.formatVersion, 1);

  // Prove it actually restores: empty two tables, then bring them back.
  await db.clearStore(db.STORES.products);
  await db.clearStore(db.STORES.sales);
  ok('the tables really were emptied', (await xfer.readAllStores()).products.length === 0);

  const result = await xfer.importBackupFile(verdict.file, verdict.formatVersion);
  ok('the legacy file restores', result.ok === true);
  const after = await xfer.readAllStores();
  eq('products came back', after.products.length, legacy.products.length);
  eq('sales came back', after.sales.length, legacy.sales.length);
  eq('suppliers came back', after.suppliers.length, legacy.suppliers.length);

  // The subtle case: a legacy file that predates a table says NOTHING about it.
  // Absence must mean "leave it alone", never "empty it" — otherwise restoring
  // an old backup would silently destroy stock batches the shop is using.
  {
    const partial = { ...legacy };
    delete partial.stockBatches;
    const batchesBefore = (await xfer.readAllStores()).stockBatches.length;
    ok('there are stock batches to protect', batchesBefore > 0);

    const pv = await xfer.validateBackupFile(JSON.stringify(partial));
    ok('a legacy file that omits a table is still accepted', pv.ok, pv.error);
    const r = await xfer.importBackupFile(pv.file, pv.formatVersion);
    ok('and imports', r.ok === true);
    eq('a table the old file never mentioned is left untouched',
      (await xfer.readAllStores()).stockBatches.length, batchesBefore);
  }

  // And the shop is whole again for the sections that follow.
  await clearAll();
  await xfer.importBackupFile(file, file.formatVersion);
  eq('the large shop is back', countsOf(await xfer.readAllStores()), liveCounts);
}

/* ================================================================== *
 * 5 · money that does not divide evenly
 * ================================================================== */

section('5 · money survives exactly; only the summaries are rounded');

{
  eq('the classic float error is collapsed for display', xfer.round2(0.1 + 0.2), 0.3);

  await clearAll();
  await db.saveProduct({
    id: 'x',
    name: 'منتج غريب',
    price: 0.1 + 0.2, // 0.30000000000000004, not 0.3
    costPrice: 12345678.99,
    variants: [{ size: '', color: '', quantity: 2 }],
  });
  await db.saveProduct({
    id: 'y',
    name: 'منتج ثانٍ',
    price: 0.2,
    costPrice: 0.2,
    variants: [{ size: '', color: '', quantity: 1 }],
  });
  await db.saveProduct({
    id: 'z',
    name: 'منتج ثالث',
    price: 0.1,
    costPrice: 0.1,
    variants: [{ size: '', color: '', quantity: 1 }],
  });

  const f = await xfer.buildBackupFile();
  const stored = f.stores.products.find((p) => p.id === 'x');
  eq('a stored price is carried exactly, not rounded', stored.price, 0.1 + 0.2);
  ok('which is genuinely not 0.3', stored.price !== 0.3);
  eq('the derived inventory value is rounded for the summary', f.totals.inventoryValue,
    xfer.round2(2 * 12345678.99 + 0.2 + 0.1));

  // Round trip the awkward values through a full restore.
  const v = await xfer.validateBackupFile(JSON.stringify(f));
  ok('the file validates despite the awkward numbers', v.ok, v.error);
  await clearAll();
  await xfer.importBackupFile(v.file, v.formatVersion);
  const back = (await xfer.readAllStores()).products.find((p) => p.id === 'x');
  eq('0.30000000000000004 survives the round trip untouched', back.price, 0.1 + 0.2);
  eq('and a large amount survives to the piaster', back.costPrice, 12345678.99);

  // Two sales of 0.1 and 0.2 add up to 0.3 in the summary, not 0.30000000000000004.
  await clearAll();
  // «سعر البيع يتبع الدفعة» (Option A): قطعتان على الرف في دفعتين منفصلتين —
  // القطعة الأولى بسعر 0.1 (سعر المنتج عند أول حفظ) والثانية بسعر 0.2 —
  // فتُسعَّر كل فاتورة من دفعتها هي وتبقى القيم المتوقعة كما هي تمامًا
  // (0.1 و0.2 ومجموع 0.3).
  await db.saveProduct({ id: 'q', name: 'قميص', price: 0.1, costPrice: 0, variants: [{ size: '', color: '', quantity: 2 }] });
  const [firstLot] = (await db.listStockBatches()).filter((b) => b.productId === 'q');
  await db.put(db.STORES.stockBatches, { ...firstLot, quantity: 1, createdAt: '2026-01-01T10:00:00.000Z' });
  await db.put(db.STORES.stockBatches, {
    id: 'q::lots::second', productId: 'q', variantKey: '|', size: '', color: '',
    quantity: 1, costPrice: 0, sellingPrice: 0.2, createdAt: '2026-01-01T10:30:00.000Z',
  });
  await db.createSale({ id: 's-a', items: [{ productId: 'q', name: 'قميص', size: '', color: '', qty: 1, price: 0.1, costPrice: 0 }], timestamp: '2026-01-01T10:00:00.000Z' });
  await db.createSale({ id: 's-b', items: [{ productId: 'q', name: 'قميص', size: '', color: '', qty: 1, price: 0.2, costPrice: 0 }], timestamp: '2026-01-01T11:00:00.000Z' });
  const f2 = await xfer.buildBackupFile();
  eq('sales totals read 0.3, not a float artefact', f2.totals.totalSales, 0.3);
  eq('and both sales are still stored exactly',
    f2.stores.sales.map((s) => s.total).sort(), [0.1, 0.2]);
}

/* ================================================================== *
 * 6 · a restore that fails part-way rolls all the way back
 * ================================================================== */

section('6 · a restore that fails part-way leaves the shop exactly as it was');

{
  await clearAll();
  await db.saveProduct({
    id: 'k1', name: 'منتج أول', price: 30, costPrice: 10,
    variants: [{ size: 'M', color: 'أحمر', quantity: 5 }],
  });
  await db.saveProduct({
    id: 'k2', name: 'منتج ثانٍ', price: 40, costPrice: 15,
    variants: [{ size: 'L', color: 'أزرق', quantity: 7 }],
  });
  await db.saveSupplier({ id: 'ksup', name: 'مورد الاختبار', openingBalance: 50 });
  await db.createSale({
    id: 'ksale',
    items: [{ productId: 'k1', name: 'منتج أول', size: 'M', color: 'أحمر', qty: 2, price: 30, costPrice: 10 }],
    timestamp: '2026-04-01T09:00:00.000Z',
  });
  await db.saveSettings({ storeName: 'متجر الاختبار', openingBalance: 99.5 });

  const good = await xfer.buildBackupFile();
  const goodText = JSON.stringify(good);
  const pristine = await snap();
  const pristineCounts = countsOf(await xfer.readAllStores());

  // (a) the totals do not add up. `totals` is derived data and is NOT inside the
  //     fingerprint, so this file passes validation — and it is exactly the
  //     kind of quiet damage a human edit produces.
  {
    const wrong = JSON.parse(goodText);
    wrong.totals.totalSales = wrong.totals.totalSales + 999;
    const v = await xfer.validateBackupFile(JSON.stringify(wrong));
    ok('a file whose totals lie still validates', v.ok, v.error);

    const err = await rejects('but the restore refuses to keep it',
      xfer.importBackupFile(v.file, v.formatVersion));
    ok('saying it rolled back', /التراجع/.test(err?.message || ''), err?.message);
    eq('and the shop is byte-for-byte what it was', await snap(), pristine);
    eq('with the same counts', countsOf(await xfer.readAllStores()), pristineCounts);
  }

  // (b) a record that cannot be written because it has no primary key. The
  //     write silently drops it, and the post-write verification is the only
  //     thing standing between the shop and a half-restored database.
  {
    const broken = JSON.parse(goodText);
    broken.stores.products.push({ name: 'سجل بلا معرّف', price: 1 });
    broken.fingerprint.value = await fingerprintOf(broken); // so it validates
    const v = await xfer.validateBackupFile(JSON.stringify(broken));
    ok('the file with an unwritable record validates', v.ok, v.error);

    const err = await rejects('the restore fails and rolls back',
      xfer.importBackupFile(v.file, v.formatVersion));
    ok('with a message that says what happened', Boolean(err?.message), err?.message);
    eq('the shop is exactly as it was', await snap(), pristine);
  }

  // (c) a safety snapshot of the pre-restore state was kept, in its own
  //     database, so it cannot be mistaken for shop data.
  {
    const snapFile = await xfer.readSafetySnapshot();
    ok('a safety snapshot was written before the restore', snapFile !== null);
    ok('and it holds the real pre-restore tables', Array.isArray(snapFile?.stores?.products));
    eq('with the products the shop had', snapFile.stores.products.map((p) => p.id).sort(), ['k1', 'k2']);
    ok('in its own database, not the shop database',
      (await readSrc('js/data-transfer.js')).includes('saher_backup_safety'));
  }
}

/* ================================================================== *
 * 7 · the activation record must never travel in a file
 * ================================================================== */

section('7 · the interim gate\'s own record is never backed up or restored');

{
  const activation = JSON.stringify({ v: 1, activatedAt: 1, lastSeenAt: 2 });
  fakeStorage.setItem('saher.interim.activation.v1', activation);
  fakeStorage.setItem('saher.backup.lastExportAt', '2026-01-01T00:00:00.000Z');
  fakeStorage.setItem('saher.shop.customNote', 'ملاحظة المتجر');

  const f = await xfer.buildBackupFile();
  const stored = f.storage.localStorage;
  eq('shop data held in localStorage IS carried', stored['saher.shop.customNote'], 'ملاحظة المتجر');
  ok('the activation record is NOT carried', !('saher.interim.activation.v1' in stored));
  ok('the backup reminder key is NOT carried', !('saher.backup.lastExportAt' in stored));
  ok('and the module knows the prefix is reserved',
    xfer.isReservedStorageKey('saher.interim.activation.v1') === true);
  ok('while ordinary shop keys are not reserved',
    xfer.isReservedStorageKey('saher.shop.customNote') === false);

  // Restoring must overwrite shop keys and leave the gate's record exactly as
  // it found it — a restore can never lock, unlock or shorten the activation.
  const v = await xfer.validateBackupFile(JSON.stringify(f));
  fakeStorage.setItem('saher.shop.customNote', 'مغيّر');
  await xfer.importBackupFile(v.file, v.formatVersion);
  eq('shop data in localStorage is restored', fakeStorage.getItem('saher.shop.customNote'), 'ملاحظة المتجر');
  eq('and the activation record is untouched', fakeStorage.getItem('saher.interim.activation.v1'), activation);
}

/* ================================================================== *
 * 8 · independent of the build mode, and honest about its format
 * ================================================================== */

section('8 · the backup path is independent of the interim build');

{
  const src = await readSrc('js/data-transfer.js');

  ok('it never imports the build-mode flag',
    !/from\s+['"][^'"]*build-config\.js['"]/.test(src));
  ok('and never asks about the mode',
    !/\bisInterim\b|\bMODE_INTERIM\b/.test(src));
  ok('the identity database is named only to be refused',
    /FORBIDDEN_DATABASES\s*=\s*\[[^\]]*storehub_identity/.test(src));

  // The format contract, checked as text because it is a promise to the future.
  ok('the format version is declared', /export const FORMAT_VERSION = 2/.test(src));
  ok('version 1 remains readable forever', xfer.SUPPORTED_FORMAT_VERSIONS.includes(1));
  ok('version 2 is readable', xfer.SUPPORTED_FORMAT_VERSIONS.includes(2));
  ok('and the contract says a shape change needs a version bump',
    /NEVER change the meaning/.test(src));
  ok('the contract forbids shrinking the accepted list',
    /NEVER remove a `formatVersion`/.test(src));
}

/* ================================================================== *
 * 9 · the reminder, and what it is allowed to be
 * ================================================================== */

section('9 · the backup reminder');

{
  eq('three days is the interval', xfer.BACKUP_REMINDER_DAYS, 3);

  fakeStorage.clear();
  eq('with no export on record, a backup is due', xfer.isBackupDue(new Date('2026-01-01T00:00:00Z')), true);

  xfer.markExportedAt(new Date('2026-01-01T00:00:00Z'));
  eq('the moment is remembered', xfer.lastExportAt()?.toISOString(), '2026-01-01T00:00:00.000Z');
  eq('a day later it is not yet due', xfer.isBackupDue(new Date('2026-01-02T00:00:00Z')), false);
  eq('two days later still not', xfer.isBackupDue(new Date('2026-01-03T00:00:00Z')), false);
  eq('three days later it is due again', xfer.isBackupDue(new Date('2026-01-04T00:00:00Z')), true);

  // The wording lives in the UI module (which needs a DOM); the check here is
  // that the reminder is DRIVEN by the same constant, so the two cannot drift.
  const uiSrc = await readSrc('js/data-transfer-ui.js');
  ok('the reminder text uses the shared interval', /BACKUP_REMINDER_DAYS/.test(uiSrc));
  ok('and it is an invitation, not an error',
    /خُذ نسخة/.test(uiSrc) && !/خطأ|فشل/.test(uiSrc.split('backupReminderText')[1]?.slice(0, 400) || ''));
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
