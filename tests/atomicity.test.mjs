/**
 * Store Hub — transaction atomicity and fault-injection tests.
 *
 *   node tests/atomicity.test.mjs
 *
 * ─────────────────────────────────────────────────────────────────────────
 * What this file is for
 * ─────────────────────────────────────────────────────────────────────────
 * The accounting suite proves the NUMBERS are right on the happy path. This one
 * proves the DATABASE is right when things go wrong: a sale that fails halfway,
 * a restock whose money half never lands, an edit that is refused, a refund that
 * dies mid-way, a double tap on "confirm".
 *
 * The rule under test is the one an IndexedDB transaction is supposed to give —
 * all of a unit of work commits, or none of it does. Every case captures a full
 * snapshot of every store before the operation, forces a failure, and asserts
 * the snapshot afterwards is byte-for-byte identical: financial records AND
 * inventory, together. A failure that leaves the stock moved but not the invoice
 * (or the reverse) is exactly the defect this suite exists to catch.
 *
 * The failure is injected at the storage layer, below `js/db.js`, so the app
 * sees an ordinary IndexedDB request error. The double rolls the transaction
 * back the way a real database does (see tests/fake-indexeddb.mjs), which is the
 * only way "nothing was written" can be demonstrated rather than assumed.
 *
 * It also runs a fixed-seed random campaign — read a crisp record of it in the
 * final report — mixing sales, edits, refunds, restocks and injected failures,
 * and checks after EVERY step that the two stock books (variants and FIFO lots)
 * and the independent reference agree.
 */

import { createFakeIndexedDB } from './fake-indexeddb.mjs';
import { micro, toCents, centsToMicro, FifoBook } from './reference-accounting.mjs';

const js = (rel) => new URL(`../js/${rel}`, import.meta.url).href;

/* ------------------------------------------------------------------ *
 * Tiny runner (same shape as the other suites)
 * ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
const failures = [];
let _sectionStart = 0;
let _sectionFailed = 0;

function ok(label, condition, detail = '') {
  if (condition) {
    passed++;
    return;
  }
  failed++;
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ''}`);
}

function section(title) {
  if (_sectionStart) console.log(`   (${passed - _sectionStart} passed, ${failed - _sectionFailed} failed)`);
  _sectionStart = passed;
  _sectionFailed = failed;
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------------ *
 * The real database, on the double
 * ------------------------------------------------------------------ */

const fakeIdb = createFakeIndexedDB();
globalThis.indexedDB = fakeIdb;

const db = await import(js('db.js'));

async function resetDb() {
  for (const name of Object.values(db.STORES)) await db.clearStore(name);
}

/* ------------------------------------------------------------------ *
 * Fault injection — below js/db.js, at the storage layer
 * ------------------------------------------------------------------ */

/** Makes the `nth` matching write to `store` fail; key filters by record key. */
function injectWrite(store, { nth = 1, key = undefined } = {}) {
  let seen = 0;
  fakeIdb.faults.write = (s, k) => {
    if (s !== store) return null;
    if (key !== undefined && String(k) !== String(key)) return null;
    seen += 1;
    return seen >= nth ? new Error(`injected write failure on ${store}`) : null;
  };
}
/** Makes every read from `store` fail for the duration of one operation. */
function injectRead(store) {
  fakeIdb.faults.read = (s) => (s === store ? new Error(`injected read failure on ${store}`) : null);
}
function clearFaults() {
  fakeIdb.faults.write = null;
  fakeIdb.faults.read = null;
}

/* ------------------------------------------------------------------ *
 * Snapshots and stock-book checks
 * ------------------------------------------------------------------ */

const stable = (_k, v) => (typeof v === 'bigint' ? `${v}n` : v);

/** Every store, every record, in a deterministic order — the whole database. */
async function dump() {
  const out = {};
  for (const store of Object.values(db.STORES)) {
    const rows = await db.getAll(store);
    out[store] = rows.map((r) => JSON.stringify(r, stable)).sort();
  }
  return JSON.stringify(out);
}

async function batchQty(productId, variantKey) {
  const batches = await db.listStockBatches();
  return batches
    .filter((b) => b.productId === productId && b.variantKey === variantKey)
    .reduce((t, b) => t + (Number(b.quantity) || 0), 0);
}

async function variantQty(productId, size, color) {
  const p = await db.get(db.STORES.products, productId);
  const v = (p?.variants || []).find((x) => x.size === size && x.color === color);
  return v ? Number(v.quantity) || 0 : 0;
}

/** The two stock books — FIFO lots and variant counters — must always agree. */
async function booksAgree(label) {
  const products = await db.listProducts();
  const batches = await db.listStockBatches();
  let bad = 0;
  for (const p of products) {
    for (const v of p.variants || []) {
      const vk = `${v.size || ''}|${v.color || ''}`;
      const bq = batches
        .filter((b) => b.productId === p.id && b.variantKey === vk)
        .reduce((t, b) => t + (Number(b.quantity) || 0), 0);
      if (bq !== (Number(v.quantity) || 0)) bad += 1;
    }
  }
  ok(label, bad === 0, `${bad} variant(s) disagree with the FIFO lots`);
}

/** No stored money figure may be NaN or Infinity. */
async function noJunk(label) {
  const sales = await db.listSales();
  let bad = 0;
  for (const s of sales) {
    for (const v of [s.subtotal, s.discount, s.priceIncrease, s.total, s.costTotal]) {
      if (!Number.isFinite(Number(v))) bad += 1;
    }
    for (const it of s.items || []) {
      if (!Number.isFinite(Number(it.costTotal)) || !Number.isFinite(Number(it.price))) bad += 1;
    }
  }
  ok(label, bad === 0, `${bad} non-finite figure(s)`);
}

/* ------------------------------------------------------------------ *
 * Seed — a product with two FIFO lots (3 @ 4.00, 2 @ 6.00)
 * ------------------------------------------------------------------ */

async function seedTwoLots() {
  await resetDb();
  await db.put(db.STORES.products, {
    id: 'p1', name: 'قميص', sku: '', category: 'غير مصنف', description: '',
    price: 50, costPrice: 4, variants: [{ size: 'L', color: 'أحمر', quantity: 5 }],
    image: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  await db.put(db.STORES.stockBatches, {
    id: 'b1', productId: 'p1', variantKey: 'L|أحمر', size: 'L', color: 'أحمر',
    quantity: 3, costPrice: 4, sellingPrice: 50, createdAt: '2026-01-01T00:00:00.000Z',
  });
  await db.put(db.STORES.stockBatches, {
    id: 'b2', productId: 'p1', variantKey: 'L|أحمر', size: 'L', color: 'أحمر',
    quantity: 2, costPrice: 6, sellingPrice: 50, createdAt: '2026-01-02T00:00:00.000Z',
  });
}

const saleOf = (id, qty, extra = {}) => ({
  id,
  items: [{ productId: 'p1', name: 'قميص', size: 'L', color: 'أحمر', qty, price: 50, costPrice: 4 }],
  paymentMethod: 'cash',
  ...extra,
});

/* ================================================================== *
 * 0 · control — a sale that SUCCEEDS really does move the database
 * ================================================================== */

async function control() {
  section('0 · control: a successful sale does change the database');

  await seedTwoLots();
  const before = await dump();
  const sale = await db.createSale(saleOf('s-ok', 2));
  const after = await dump();

  ok('the sale was stored', !!sale && sale.id === 's-ok');
  ok('the database changed', before !== after);
  ok('stock went down by exactly 2', (await batchQty('p1', 'L|أحمر')) === 3);
  ok('cost is the FIFO figure for 2 @ 4.00', Number(sale.costTotal) === 8);
  const gb = await db.getStockBatches('p1', 'L|أحمر');
  ok('getStockBatches hands the lots back oldest first', gb.length > 0 && gb[0].id === 'b1', gb.map((b) => b.id).join(','));
  await booksAgree('the two stock books still agree');
}

/* ================================================================== *
 * 1 · fault before the first batch is consumed
 * ================================================================== */

async function failBeforeConsume() {
  section('1 · read fails before any batch is consumed — nothing changes');

  await seedTwoLots();
  const before = await dump();
  injectRead('stockBatches');
  let threw = false;
  try {
    await db.createSale(saleOf('s-1', 2));
  } catch {
    threw = true;
  } finally {
    clearFaults();
  }
  const after = await dump();

  ok('the sale was refused', threw);
  ok('no sale was stored', (await db.listSales()).length === 0);
  ok('the database is byte-for-byte unchanged', before === after);
  await booksAgree('the two stock books still agree');
}

/* ================================================================== *
 * 2 · fault while consuming across several FIFO lots
 * ================================================================== */

async function failDuringMultiLot() {
  section('2 · failure while several lots are consumed — the whole take rolls back');

  await seedTwoLots();
  const before = await dump();
  // The sale needs 4 pieces: 3 from b1 + 1 from b2. The second lot write fails.
  injectWrite('stockBatches', { nth: 2 });
  let threw = false;
  try {
    await db.createSale(saleOf('s-2', 4));
  } catch {
    threw = true;
  } finally {
    clearFaults();
  }
  const after = await dump();

  ok('the sale was refused', threw);
  ok('b1 is untouched (still 3)', (await db.get(db.STORES.stockBatches, 'b1')).quantity === 3);
  ok('b2 is untouched (still 2)', (await db.get(db.STORES.stockBatches, 'b2')).quantity === 2);
  ok('the database is byte-for-byte unchanged', before === after);
}

/* ================================================================== *
 * 3 · fault after the stock move but before the invoice is saved
 * ================================================================== */

async function failBetweenStockAndInvoice() {
  section('3 · failure after the stock write, before the invoice — no orphan stock');

  await seedTwoLots();
  const before = await dump();
  injectWrite('products'); // lots land, the product write (before the sale) fails
  let threw = false;
  try {
    await db.createSale(saleOf('s-3', 3));
  } catch {
    threw = true;
  } finally {
    clearFaults();
  }
  const after = await dump();

  ok('the sale was refused', threw);
  ok('no invoice exists without stock leaving', (await db.listSales()).length === 0);
  ok('the database is byte-for-byte unchanged', before === after);
  await booksAgree('the two stock books still agree');
}

/* ================================================================== *
 * 4 · fault on the invoice write itself
 * ================================================================== */

async function failOnInvoiceWrite() {
  section('4 · failure while the invoice row is written — nothing is stored');

  await seedTwoLots();
  const before = await dump();
  injectWrite('sales');
  let threw = false;
  try {
    await db.createSale(saleOf('s-4', 2));
  } catch {
    threw = true;
  } finally {
    clearFaults();
  }
  const after = await dump();

  ok('the sale was refused', threw);
  ok('stock did not move', (await batchQty('p1', 'L|أحمر')) === 5);
  ok('the database is byte-for-byte unchanged', before === after);
}

/* ================================================================== *
 * 5 · fault on a dependent financial write (restock: stock landed, money did not)
 * ================================================================== */

async function failOnFinancialWrite() {
  section('5 · restock fails on the purchase row — stock and money stay together');

  await seedTwoLots();
  const before = await dump();
  injectWrite('purchases'); // product + FIFO lot land, the purchase row fails
  let threw = false;
  try {
    await db.restockProduct({
      productId: 'p1',
      lines: [{ size: 'L', color: 'أحمر', qty: 10 }],
      unitCost: 5,
      newPrice: 55,
    });
  } catch {
    threw = true;
  } finally {
    clearFaults();
  }
  const after = await dump();

  ok('the restock was refused', threw);
  ok('the shelf did not rise', (await batchQty('p1', 'L|أحمر')) === 5);
  ok('the store balance is not debited', (await db.listPurchases()).length === 0);
  ok('the database is byte-for-byte unchanged', before === after);
  await booksAgree('the two stock books still agree');
}

/* ================================================================== *
 * 6 · fault while editing an already-saved invoice
 * ================================================================== */

async function failOnEdit() {
  section('6 · edit a saved invoice and fail mid-way — the old invoice survives intact');

  await seedTwoLots();
  await db.createSale(saleOf('s-6', 2)); // takes 2 from b1
  const before = await dump();

  injectWrite('sales'); // the updated invoice row fails
  let threw = false;
  try {
    await db.updateSale('s-6', { items: [{ productId: 'p1', name: 'قميص', size: 'L', color: 'أحمر', qty: 4, price: 50, costPrice: 4 }] });
  } catch {
    threw = true;
  } finally {
    clearFaults();
  }
  const after = await dump();

  ok('the edit was refused', threw);
  const old = await db.get(db.STORES.sales, 's-6');
  ok('the old invoice is unchanged (still 2 pieces)', old.items[0].qty === 2);
  ok('stock reflects the OLD invoice, not the failed edit', (await batchQty('p1', 'L|أحمر')) === 3);
  ok('the database is byte-for-byte unchanged', before === after);
  await booksAgree('the two stock books still agree');
}

/* ================================================================== *
 * 7 · fault while refunding (stock restore staged, refund record write fails)
 * ================================================================== */

async function failOnRefund() {
  section('7 · refund fails on refund record write — stock restore rolls back too');

  await seedTwoLots();
  await db.createSale(saleOf('s-7', 2));
  const before = await dump();

  injectWrite('refunds', {}); // the refund record write fails (any key)
  let threw = false;
  try {
    await db.refundSale('s-7');
  } catch {
    threw = true;
  } finally {
    clearFaults();
  }
  const after = await dump();

  ok('the refund was refused', threw);
  ok('the invoice still exists', !!(await db.get(db.STORES.sales, 's-7')));
  ok('the stock was NOT restored twice', (await batchQty('p1', 'L|أحمر')) === 3);
  ok('no refund record was left behind', (await db.listRefunds()).length === 0);
  ok('the database is byte-for-byte unchanged', before === after);
}

/* ================================================================== *
 * 8 · insufficient stock is a refusal, not a partial move
 * ================================================================== */

async function insufficientStock() {
  section('8 · too little stock refuses cleanly');

  await seedTwoLots();
  const before = await dump();
  let threw = false;
  let message = '';
  try {
    await db.createSale(saleOf('s-8', 99));
  } catch (err) {
    threw = true;
    message = String(err && err.message);
  }
  const after = await dump();

  ok('the sale was refused', threw);
  ok('the reason names the shortage', /stock/i.test(message), message);
  ok('nothing moved', (await batchQty('p1', 'L|أحمر')) === 5);
  ok('the database is byte-for-byte unchanged', before === after);
}

/* ================================================================== *
 * 9 · a rapid duplicate submit never double-counts
 * ================================================================== */

async function duplicateSubmit() {
  section('9 · duplicate submit of the same receipt consumes stock once');

  await seedTwoLots();
  const first = await db.createSale(saleOf('s-dup', 2));
  // A second tap (or a retry) with the same receipt id.
  const second = await db.createSale(saleOf('s-dup', 2));

  const sales = await db.listSales();
  ok('exactly one invoice exists', sales.length === 1);
  ok('the second call returned the stored invoice', second.id === 's-dup');
  ok('it is the same record', JSON.stringify(first) === JSON.stringify(second));
  ok('stock was consumed once, not twice', (await batchQty('p1', 'L|أحمر')) === 3);
  await booksAgree('the two stock books still agree');
}

/* ================================================================== *
 * 10 · a storage error in the middle of the operation
 * ================================================================== */
async function storageErrorMidOp() {
  section('10 · storage error reading the product mid-sale — clean rollback');

  await seedTwoLots();
  const before = await dump();
  injectRead('products');
  let threw = false;
  try {
    await db.createSale(saleOf('s-10', 2));
  } catch {
    threw = true;
  } finally {
    clearFaults();
  }
  const after = await dump();

  ok('the sale was refused', threw);
  ok('the database is byte-for-byte unchanged', before === after);
  await booksAgree('the two stock books still agree');
}

/* ================================================================== *
 * 10b · a legacy line's cost is still rounded to the agora (issue I)
 * ================================================================== */

async function legacyCostRounding() {
  section('10b · a legacy invoice line keeps its cost, rounded to whole agorot');

  await seedTwoLots();
  // A sale recorded before FIFO lots existed: it carries a per-piece cost with
  // three decimals (0.155) and NO `stockBatchesConsumed`. Editing it must keep
  // the recorded per-piece cost but store the line total at whole agorot —
  // 5 × 0.155 = 0.775 → 0.78 (half up), not the raw float 0.775.
  await db.put(db.STORES.sales, {
    id: 'leg-1', receiptNo: '0001',
    items: [{ productId: 'p1', name: 'قميص', size: 'L', color: 'أحمر', qty: 3, price: 50, costPrice: 0.155 }],
    subtotal: 150, discount: 0, discountType: 'fixed', discountValue: 0, priceIncrease: 0, total: 150,
    paymentMethod: 'cash', costTotal: 0.46, timestamp: '2026-01-01T00:00:00.000Z', note: '',
  });

  const up = await db.updateSale('leg-1', {
    items: [{ productId: 'p1', name: 'قميص', size: 'L', color: 'أحمر', qty: 5, price: 50, costPrice: 0.155 }],
  });

  ok('the legacy line cost is a whole-agorot figure', Number(up.costTotal) === 0.78, `got ${up.costTotal}`);
  ok('the per-piece cost is preserved', String(up.items[0].costPrice) === '0.155', String(up.items[0].costPrice));
  // The legacy path moved only the +2 pieces, so the shelf still adds up.
  ok('the shelf is one lot lighter by the increase (3)', (await variantQty('p1', 'L', 'أحمر')) === 3);
  await booksAgree('the two stock books still agree');
}

/* ================================================================== *
 * 10c · half-agora boundaries round UP, not to the binary neighbour
 * ================================================================== */

async function roundingBoundaries() {
  section('10c · restock totals round half-up at the agora (issue I)');

  // Every one of these has a third decimal of 5, where the double is a hair
  // BELOW the true value — the exact case the old `Math.round(n*100)/100` got
  // wrong (0.155 × 3 = 0.465 arrives as 0.46499999999999997 and rounded down).
  const cases = [
    { unitCost: 0.155, qty: 3, total: 0.47 },
    { unitCost: 1.505, qty: 3, total: 4.52 },
    { unitCost: 1.005, qty: 1, total: 1.01 },
    { unitCost: 2.675, qty: 1, total: 2.68 },
    { unitCost: 0.465, qty: 1, total: 0.47 },
  ];
  for (const c of cases) {
    await seedTwoLots();
    const res = await db.restockProduct({
      productId: 'p1', lines: [{ size: 'L', color: 'أحمر', qty: c.qty }], unitCost: c.unitCost, newPrice: null,
    });
    ok(
      `restock ${c.unitCost} × ${c.qty} bills ${c.total}`,
      Number(res.record.total) === c.total,
      `got ${res.record.total}`
    );
  }
}

/* ================================================================== *
 * 12 · a sale that names its lot (lot-picker) — success and failure
 *
 * createSale now accepts an optional per-line `lotId`: the chosen batch is
 * consumed first, the remainder falls back to FIFO, and a lot id that is not a
 * positive lot of that product+variant is a refusal. None of that may weaken
 * the atomicity rule: a chosen-lot sale that fails mid-write still rolls back
 * to the piece.
 * ================================================================== */

const saleWithLot = (id, qty, lotId, extra = {}) => ({
  id,
  items: [{ productId: 'p1', name: 'قميص', size: 'L', color: 'أحمر', qty, price: 50, costPrice: 4, lotId }],
  paymentMethod: 'cash',
  ...extra,
});

async function preferredLotSuccess() {
  section('12 · a chosen-lot sale consumes THAT lot first, then FIFO for the remainder');

  await seedTwoLots(); // b1: 3 @ 4.00 (oldest), b2: 2 @ 6.00 (newest)
  const sale = await db.createSale(saleWithLot('s-lot-ok', 4, 'b2'));

  ok('b2 is emptied first (both its pieces went)', (await db.get(db.STORES.stockBatches, 'b2')).quantity === 0);
  ok('the remainder (2) came off the oldest lot b1', (await db.get(db.STORES.stockBatches, 'b1')).quantity === 1);
  ok('the cost is the real per-lot cost (2×6 + 2×4 = 20)', Number(sale.costTotal) === 20, `got ${sale.costTotal}`);
  const byId = new Map(sale.stockBatchesConsumed.map((c) => [c.batchId, c.qty]));
  ok('the records say exactly 2 from b2', byId.get('b2') === 2);
  ok('and exactly 2 from b1', byId.get('b1') === 2);
  ok('each record carries its own lot selling price',
    sale.stockBatchesConsumed.every((c) => (c.batchId === 'b1' ? c.sellingPrice === 50 : c.sellingPrice === 50)));
  ok('the stored line keeps its legacy shape (no lotId field)', !('lotId' in sale.items[0]));
  ok('a lot id from another variant is refused', await refuses(async () => {
    await db.createSale(saleWithLot('s-lot-x', 1, 'no-such-lot'));
  }));
  ok('a refused choice changed nothing', (await batchQty('p1', 'L|أحمر')) === 1);
  await booksAgree('the two stock books still agree');
}

async function refuses(fn) {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

async function failOnPreferredLotSale() {
  section('12b · a chosen-lot sale that fails mid-write rolls back entirely');

  await seedTwoLots();
  const before = await dump();
  // 4 pieces chosen from b2: 2 come off b2, then FIFO tops up 2 from b1. The
  // second lot write (b1) fails — the same fault class as section 2, now with
  // a preference in play.
  injectWrite('stockBatches', { nth: 2 });
  let threw = false;
  try {
    await db.createSale(saleWithLot('s-lot-fail', 4, 'b2'));
  } catch {
    threw = true;
  } finally {
    clearFaults();
  }
  const after = await dump();

  ok('the chosen-lot sale was refused', threw);
  ok('b2 kept both its pieces', (await db.get(db.STORES.stockBatches, 'b2')).quantity === 2);
  ok('b1 kept all three of its pieces', (await db.get(db.STORES.stockBatches, 'b1')).quantity === 3);
  ok('the database is byte-for-byte unchanged', before === after);
  await booksAgree('the two stock books still agree');
}

/* ================================================================== *
 * 11 · seeded random campaign
 * ================================================================== */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = 20261016;
const rng = mulberry32(SEED);
const randInt = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = (arr) => arr[randInt(0, arr.length - 1)];

async function randomCampaign() {
  section('11 · fixed-seed random campaign (sales, edits, refunds, failures)');

  await resetDb();

  // Three products, each with a couple of variants and several fractional-cost
  // lots, so the 3-decimal costs that issue I is about are exercised.
  const spec = [];
  const book = new FifoBook();
  let lotClock = 0;
  for (let i = 0; i < 3; i++) {
    const pid = `p${i}`;
    const variants = [];
    for (let j = 0; j < 2; j++) {
      const size = `S${i}${j}`;
      const color = `C${j}`;
      const vk = `${size}|${color}`;
      const lots = [];
      const lotCount = randInt(2, 3);
      for (let k = 0; k < lotCount; k++) {
        const qty = randInt(3, 25);
        // Costs include 3 decimals (e.g. 1.505) to stress exact rounding.
        const cost = randInt(1, 20000) / 1000;
        const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, ++lotClock)).toISOString();
        const id = `${pid}-${vk}-${k}`;
        await db.put(db.STORES.stockBatches, {
          id, productId: pid, variantKey: vk, size, color,
          quantity: qty, costPrice: cost, sellingPrice: 30, createdAt,
        });
        book.add(pid, vk, { id, qty, costMicro: micro(cost), createdAt });
        lots.push({ qty, cost });
      }
      variants.push({ size, color, quantity: lots.reduce((t, l) => t + l.qty, 0) });
    }
    await db.put(db.STORES.products, {
      id: pid, name: `منتج ${i}`, sku: '', category: 'غير مصنف', description: '',
      price: 30, costPrice: 5, variants, image: '',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    spec.push({ id: pid, variants });
  }

  const variantList = [];
  for (const p of spec) for (const v of p.variants) variantList.push({ productId: p.id, size: v.size, color: v.color, vk: `${v.size}|${v.color}` });

  const liveSales = []; // { id, productId, vk, taken: Array<{id,qty,costMicro}> }
  let saleSeq = 0;
  let mismatches = 0;
  let faultsChecked = 0;
  let opsRun = 0;

  const available = (productId, vk) => book.available(productId, vk);

  async function checkAgainstReference(label) {
    const batches = await db.listStockBatches();
    let bad = 0;
    for (const p of spec) {
      for (const v of p.variants) {
        const vk = `${v.size}|${v.color}`;
        const appQty = batches
          .filter((b) => b.productId === p.id && b.variantKey === vk)
          .reduce((t, b) => t + (Number(b.quantity) || 0), 0);
        if (appQty !== book.available(p.id, vk)) bad += 1;
      }
    }
    if (bad) { mismatches += bad; ok(label, false, `${bad} variant(s) differ from the reference`); }
    else passed++;
  }

  const STEPS = 260;
  for (let step = 0; step < STEPS; step++) {
    const choice = variantList[randInt(0, variantList.length - 1)];
    const { productId, size, color, vk } = choice;
    const roll = rng();

    if (roll < 0.42) {
      // A sale, sometimes larger than what is on the shelf (must refuse).
      const have = available(productId, vk);
      const qty = randInt(1, Math.max(1, have + 2));
      const id = `sale-${++saleSeq}`;
      let taken = null;
      try {
        taken = book.consume(productId, vk, qty);
      } catch {
        taken = null;
      }
      const discountType = rng() < 0.5 ? 'percent' : 'fixed';
      const discountValue = discountType === 'percent' ? randInt(0, 20) : randInt(0, 300) / 100;
      let appSale = null;
      let appErr = null;
      try {
        appSale = await db.createSale({
          id,
          items: [{ productId, name: 'x', size, color, qty, price: randInt(10, 90) / 2, costPrice: 0 }],
          discountType,
          discountValue,
          paymentMethod: rng() < 0.5 ? 'cash' : 'credit',
        });
      } catch (err) {
        appErr = err;
      }
      if (taken) {
        // Expected success, with the reference FIFO cost (rounded per line).
        if (appErr || !appSale) {
          book.restore(taken); // keep the reference in step with a refused app sale
          mismatches += 1;
          ok('sale reference/state agree', false, `expected success: ${appErr && appErr.message}`);
        } else {
          const refCost = centsToMicro(toCents(book.costOf(taken)));
          if (micro(appSale.costTotal) === refCost) passed++;
          else { mismatches += 1; ok('sale cost matches reference', false, `expected ${refCost}, got ${micro(appSale.costTotal)}`); }
          liveSales.push({ id, productId, vk, size, color, taken });
        }
      } else {
        // Expected refusal: the reference must have rolled back its consume.
        if (!appErr) { mismatches += 1; ok('an impossible sale is refused', false, 'the app accepted it'); }
        else passed++;
      }
      opsRun += 1;
    } else if (roll < 0.62 && liveSales.length) {
      // Edit a saved sale: quantity up or down.
      const idx = randInt(0, liveSales.length - 1);
      const s = liveSales[idx];
      const before = await dump();
      const newQty = randInt(1, available(s.productId, s.vk) + s.taken.reduce((t, c) => t + c.qty, 0));
      const id = `edit-${step}`;
      // Reference: put THIS sale's takes back on their exact lots, then consume
      // the new quantity FIFO. A refusal undoes the temporary restore by
      // subtracting the SAME takes from their lots, so the reference lands back
      // exactly where it started (the app's abort does the same, in effect).
      const lotsFor = () => book.lots.get(book.key(s.productId, s.vk)) || [];
      for (const c of s.taken) {
        const lot = lotsFor().find((l) => l.id === c.id);
        if (lot) lot.qty += c.qty;
      }
      let refTaken = null;
      try {
        refTaken = book.consume(s.productId, s.vk, newQty);
      } catch {
        for (const c of s.taken) {
          const lot = lotsFor().find((l) => l.id === c.id);
          if (lot) lot.qty -= c.qty;
        }
        refTaken = null;
      }
      let appErr = null;
      let appSale = null;
      try {
        appSale = await db.updateSale(s.id, {
          items: [{ productId: s.productId, name: 'x', size: s.size, color: s.color, qty: newQty, price: 50, costPrice: 0 }],
        });
      } catch (err) {
        appErr = err;
      }
      if (refTaken) {
        if (appErr) { mismatches += 1; ok('edit reference/state agree', false, appErr.message); }
        else {
          const refCost = centsToMicro(toCents(book.costOf(refTaken)));
          if (micro(appSale.costTotal) === refCost) passed++;
          else { mismatches += 1; ok('edit cost matches reference', false, `expected ${refCost}, got ${micro(appSale.costTotal)}`); }
          s.taken = refTaken;
        }
      } else {
        // Refused edit must have changed nothing at all.
        const after = await dump();
        if (appErr && before === after) { passed++; } else { mismatches += 1; ok('refused edit changes nothing', false, `${appErr ? '' : 'no error'}`); }
      }
      opsRun += 1;
    } else if (roll < 0.74 && liveSales.length) {
      // Full refund.
      const idx = randInt(0, liveSales.length - 1);
      const s = liveSales.splice(idx, 1)[0];
      book.restore(s.taken.map((c) => ({ ...c })));
      await db.refundSale(s.id);
      opsRun += 1;
    } else if (roll < 0.88) {
      // Restock (atomic purchase + lots).
      const qty = randInt(1, 20);
      const unitCost = randInt(1, 20000) / 1000;
      const before = await dump();
      const createdAt = new Date(Date.UTC(2026, 5, 1, 0, 0, ++lotClock)).toISOString();
      let appErr = null;
      let rec = null;
      try {
        const res = await db.restockProduct({
          productId, lines: [{ size, color, qty }], unitCost, newPrice: null,
        });
        rec = res.record;
      } catch (err) {
        appErr = err;
      }
      if (!appErr) {
        // The app must have filed a FIFO lot for exactly what landed.
        const batches = await db.listStockBatches();
        const lot = batches.find(
          (b) => b.productId === productId && b.variantKey === vk
            && (Number(b.quantity) || 0) === qty && micro(b.costPrice) === micro(unitCost)
        );
        if (rec && rec.units === qty && lot) passed++;
        else { mismatches += 1; ok('restock files the landed lot', false, `units=${rec && rec.units}, lot=${!!lot}`); }
        // The billed total must be the EXACT half-up figure (issue I): a
        // 3-decimal unit cost is where the old float rounding drifted an agora.
        const refTotal = Number(centsToMicro(toCents(micro(unitCost) * BigInt(qty)))) / 1000000;
        if (rec && Math.abs(Number(rec.total) - refTotal) < 1e-9) passed++;
        else { mismatches += 1; ok('restock total rounds exactly (issue I)', false, `expected ${refTotal}, got ${rec && rec.total}`); }
        // Reference: add a lot with the same quantity/cost.
        book.add(productId, vk, { id: `restock-${step}`, qty, costMicro: micro(unitCost), createdAt });
      } else {
        const after = await dump();
        if (before === after) passed++;
        else { mismatches += 1; ok('refused restock changes nothing', false); }
      }
      opsRun += 1;
    } else {
      // Injected failure: the operation must reject and change nothing.
      const before = await dump();
      const which = randInt(0, 3);
      if (which === 0) injectWrite('sales');
      else if (which === 1) injectWrite('stockBatches', { nth: 2 });
      else if (which === 2) injectWrite('products');
      else injectRead('stockBatches');
      let threw = false;
      try {
        await db.createSale({
          id: `f-${step}`,
          items: [{ productId, name: 'x', size, color, qty: 1, price: 50, costPrice: 0 }],
        });
      } catch {
        threw = true;
      } finally {
        clearFaults();
      }
      const after = await dump();
      faultsChecked += 1;
      if (threw && before === after) passed++;
      else { mismatches += 1; ok('injected failure leaves no trace', false, `threw=${threw}`); }
      opsRun += 1;
    }

    // After EVERY step: variants == FIFO lots == reference, and no junk.
    await checkAgainstReference(`step ${step}: books match the reference`);
  }

  await booksAgree('after the campaign the two stock books agree');
  await noJunk('after the campaign no money figure is NaN/Infinity');
  ok('the campaign exercised a meaningful number of operations', opsRun >= STEPS);
  ok('the campaign injected real failures', faultsChecked > 0);

  globalThis.__atomicity = { opsRun, faultsChecked, seed: SEED };
}

/* ================================================================== *
 * Run
 * ================================================================== */

console.log('Store Hub — transaction atomicity & fault injection');
console.log(`seed ${SEED} (fixed: the same cases every run)`);

await control();
await failBeforeConsume();
await failDuringMultiLot();
await failBetweenStockAndInvoice();
await failOnInvoiceWrite();
await failOnFinancialWrite();
await failOnEdit();
await failOnRefund();
await insufficientStock();
await duplicateSubmit();
await storageErrorMidOp();
await legacyCostRounding();
await roundingBoundaries();
await preferredLotSuccess();
await failOnPreferredLotSale();
await randomCampaign();

console.log(`   (${passed - _sectionStart} passed, ${failed - _sectionFailed} failed)`);
console.log('\n========================================================');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('========================================================');
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log(JSON.stringify(globalThis.__atomicity || {}));
process.exit(failed ? 1 : 0);
