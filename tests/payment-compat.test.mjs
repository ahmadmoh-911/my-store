/**
 * Payment-method compatibility and the extra amount ("إضافة مبلغ للبيع").
 *
 * The payment picker is gone from the interface — the source and the account
 * are one — but the invoice RECORD keeps its paymentMethod field, because old
 * invoices, old backups and the reports must read exactly as they always did.
 * This file pins that promise:
 *
 *   1. a new invoice is saved with the default 'cash';
 *   2. an old invoice stored with another method is read back UNCHANGED;
 *   3. a backup file carries the field verbatim, both ways;
 *   4. "priceIncrease" enters the total with the exact money.js rounding —
 *      once, at whole agorot, into revenue — and the stored invoice agrees;
 *   5. the cart keeps one default method and one increase field, so the
 *      checkout path that reads them keeps working;
 *   6. the cart bar's source no longer offers (or sets) a payment method.
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

/* ------------------------------------------------------------------ *
 * The world the modules run in
 * ------------------------------------------------------------------ */

globalThis.indexedDB = createFakeIndexedDB();
const fakeStorage = createFakeLocalStorage();
globalThis.localStorage = fakeStorage;

const db = await import(js('db.js'));
const xfer = await import(js('data-transfer.js'));
const money = await import(js('money.js'));
const cartStore = await import(js('cart-store.js'));

const LINE = { productId: 'q', name: 'قميص', size: '', color: '', qty: 1, price: 10, costPrice: 5 };

async function seedProduct() {
  await db.saveProduct({
    id: 'q',
    name: 'قميص الاختبار',
    price: 10,
    costPrice: 5,
    variants: [{ size: '', color: '', quantity: 50 }],
  });
}

async function saleById(id) {
  return (await db.listSales()).find((s) => s.id === id) || null;
}

/* ================================================================== *
 * 1 · a new invoice is saved as 'cash' by default
 * ================================================================== */

section('1 · a new invoice saves with the default paymentMethod \'cash\'');

{
  await seedProduct();
  const sale = await db.createSale({
    id: 's-new',
    items: [{ ...LINE }],
    timestamp: '2026-10-17T10:00:00.000Z',
  });
  ok('the invoice was written', sale !== null);
  eq('its paymentMethod is the default cash', sale.paymentMethod, 'cash');
  eq('and the total is the plain basket total', sale.total, 10);

  // The default lives in the data layer, not in whatever the UI happened to
  // have selected — so removing the picker cannot change what is stored.
  const src = await readSrc('js/db.js');
  ok('db.js defaults the field itself', /paymentMethod:\s*sale\.paymentMethod\s*\|\|\s*'cash'/.test(src));
}

/* ================================================================== *
 * 2 · an old invoice keeps whatever method it was stored with
 * ================================================================== */

section('2 · an old invoice with a different paymentMethod is read back unchanged');

{
  const t = await db.createSale({
    id: 's-old-transfer',
    items: [{ ...LINE }],
    paymentMethod: 'transfer',
    timestamp: '2026-10-16T10:00:00.000Z',
  });
  const c = await db.createSale({
    id: 's-old-card',
    items: [{ ...LINE }],
    paymentMethod: 'card',
    timestamp: '2026-10-15T10:00:00.000Z',
  });
  eq('a transfer invoice still reads transfer', t.paymentMethod, 'transfer');
  eq('a card invoice still reads card', c.paymentMethod, 'card');
  eq('and the money on it is untouched', t.total, 10);

  // Reading twice must not rewrite history either.
  const again = await saleById('s-old-transfer');
  eq('a re-read is still transfer', again.paymentMethod, 'transfer');
}

/* ================================================================== *
 * 3 · the backup file carries paymentMethod verbatim, both ways
 * ================================================================== */

section('3 · the backup passes paymentMethod through as-is');

{
  const file = await xfer.buildBackupFile({ appVersion: 'test' });
  const inFile = Object.fromEntries(file.stores.sales.map((s) => [s.id, s.paymentMethod]));
  eq('the cash invoice is carried as cash', inFile['s-new'], 'cash');
  eq('the transfer invoice is carried as transfer', inFile['s-old-transfer'], 'transfer');
  eq('the card invoice is carried as card', inFile['s-old-card'], 'card');

  // And restoring puts them back exactly.
  for (const name of Object.values(db.STORES)) await db.clearStore(name);
  const verdict = await xfer.validateBackupFile(JSON.stringify(file));
  ok('the file validates', verdict.ok, verdict.error);
  const result = await xfer.importBackupFile(verdict.file, verdict.formatVersion);
  ok('the restore succeeds', result.ok === true);

  eq('transfer survives the round trip', (await saleById('s-old-transfer'))?.paymentMethod, 'transfer');
  eq('card survives the round trip', (await saleById('s-old-card'))?.paymentMethod, 'card');
  eq('cash survives the round trip', (await saleById('s-new'))?.paymentMethod, 'cash');
}

/* ================================================================== *
 * 4 · the extra amount enters the total with the exact money.js rounding
 * ================================================================== */

section('4 · priceIncrease is revenue: same rule, same single rounding');

{
  // The owner's classic half-agora basket: 3 × 185.94 + 3 × 1.505 = 562.335,
  // which a float would round DOWN. The extra 2.005 rounds half-up to 2.01.
  const t = money.saleTotals(
    [{ qty: 3, price: 185.94 }, { qty: 3, price: 1.505 }],
    'fixed', 0, 2.005,
  );
  eq('the subtotal rounds half-up once', t.subtotal, 562.34);
  eq('the increase rounds half-up to whole agorot', t.priceIncrease, 2.01);
  eq('the increase is ADDED to the total (revenue, not a discount)', t.total, 564.35);
  ok('and the receipt arithmetic closes exactly',
    Math.round((t.subtotal - t.discount + t.priceIncrease) * 100) === Math.round(t.total * 100));

  // Half an agora of increase still rounds up, never down.
  const half = money.saleTotals([{ qty: 1, price: 0.335 }], 'fixed', 0, 0.005);
  eq('half an agora of increase rounds up', half.priceIncrease, 0.01);
  eq('and lands on the total', half.total, 0.35);

  // A negative increase is refused at the WRITERS (cart-store/checkout clamp it
  // to zero — section 5 below). The pure arithmetic is honest about what it is
  // handed: a negative would reduce the total, which is exactly why every
  // writer clamps before calling.
  eq('the pure function passes a negative through (the writers clamp it)',
    money.saleTotals([{ qty: 1, price: 10 }], 'fixed', 0, -5).priceIncrease, -5);

  // The stored invoice agrees with the money.js figure to the agora.
  // «سعر البيع يتبع الدفعة» (Option A): the invoice is priced from the batches
  // its lines actually draw from — so file those batches first (three pieces
  // at 185.94, three at 1.505) and name each on its line. The basket is the
  // one above, unchanged, so 564.35 stays the figure the money.js half-agora
  // example produced.
  await seedProduct();
  await db.put(db.STORES.stockBatches, {
    id: 'q::inc::18594', productId: 'q', variantKey: '|', size: '', color: '',
    quantity: 3, costPrice: 5, sellingPrice: 185.94, createdAt: '2026-10-01T10:00:00.000Z',
  });
  await db.put(db.STORES.stockBatches, {
    id: 'q::inc::1505', productId: 'q', variantKey: '|', size: '', color: '',
    quantity: 3, costPrice: 5, sellingPrice: 1.505, createdAt: '2026-10-01T10:01:00.000Z',
  });
  const sale = await db.createSale({
    id: 's-inc',
    items: [
      { ...LINE, qty: 3, price: 185.94, lotId: 'q::inc::18594' },
      { ...LINE, qty: 3, price: 1.505, costPrice: 0, lotId: 'q::inc::1505' },
    ],
    priceIncrease: 2.005,
    timestamp: '2026-10-17T11:00:00.000Z',
  });
  eq('the stored invoice carries the increase', sale.priceIncrease, 2.01);
  eq('and the stored total includes it', sale.total, 564.35);
}

/* ================================================================== *
 * 5 · the cart keeps one default method and one increase field
 * ================================================================== */

section('5 · the cart store: default method, increase in the grand total');

{
  eq('the cart\'s payment method starts at cash', cartStore.getPaymentMethod(), 'cash');

  // The setter stays for compatibility with whatever still writes it; it only
  // accepts known methods, and the default it returns to is cash.
  cartStore.setPaymentMethod('transfer');
  eq('the field is still writable (old records compat)', cartStore.getPaymentMethod(), 'transfer');
  cartStore.setPaymentMethod('cash');
  eq('and resets to cash', cartStore.getPaymentMethod(), 'cash');

  // The increase the inline input writes is the same figure grandTotal adds.
  cartStore.setPriceIncrease(7.5);
  eq('an empty basket with an increase totals the increase', cartStore.grandTotal(), 7.5);
  eq('the subtotal is still zero', cartStore.subtotal(), 0);
  cartStore.setPriceIncrease(-3);
  eq('a negative increase never enters the cart', cartStore.grandTotal(), 0);
  cartStore.setPriceIncrease(0);
  eq('reset to zero', cartStore.grandTotal(), 0);
}

/* ================================================================== *
 * 6 · the cart bar no longer offers (or sets) a payment method
 * ================================================================== */

section('6 · the payment picker is gone from the cart bar, and the extra amount is in');

{
  const src = await readSrc('js/cart-bar.js');

  ok('it does not import PAYMENT_METHODS', !/PAYMENT_METHODS/.test(src));
  ok('it does not call setPaymentMethod', !/setPaymentMethod/.test(src));
  ok('it does not read getPaymentMethod', !/getPaymentMethod/.test(src));
  ok('the payment selector row is gone', !/paymentRow|pay-method/.test(src));

  ok('the inline extra-amount input exists', /cb-increase/.test(src));
  ok('behind a small plus toggle', /cb-inc-toggle/.test(src));
  ok('it writes the same cart-store field', /setPriceIncrease/.test(src));
  ok('and the totals show the extra line when it bites', /cb-tot--inc/.test(src));
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
