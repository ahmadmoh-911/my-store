/**
 * Store Hub — accounting verification tests.
 *
 *   node tests/accounting.test.mjs
 *
 * ─────────────────────────────────────────────────────────────────────────
 * What this file is for
 * ─────────────────────────────────────────────────────────────────────────
 * The shop's numbers are going to be trusted with real money. "It looks right"
 * is not evidence. So every figure this suite checks is re-derived by an
 * **independent** calculator (`tests/reference-accounting.mjs`) that shares no
 * code with `js/db.js` and works in exact integer micro-units instead of floats.
 * The app is then driven through its **real** write functions on the IndexedDB
 * double next door, and the two are compared for equality — not "close", equal.
 *
 * ── The rules being verified (confirmed by the owner) ───────────────────
 *   • subtotal = Σ qty × price, no per-line rounding.
 *   • discount: percent → one rounding; fixed → clamped to the subtotal.
 *   • total = subtotal − discount + increase, rounded once, never negative.
 *   • cost of goods comes from the OLDEST lots first (FIFO), never the newest.
 *   • a full return puts back exactly what was taken.
 *   • export → import changes no total.
 *
 * Zero dependencies: the project has no node_modules and must not grow one.
 */

import { createFakeIndexedDB } from './fake-indexeddb.mjs';
import {
  micro,
  toCents,
  centsToMicro,
  roundHalfUp,
  saleTotals,
  FifoBook,
  storeBalance,
  supplierBalance,
} from './reference-accounting.mjs';

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

function serialize(v) {
  return JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? `${val}n` : val));
}

/** Exact equality over BigInt, number, null and container shapes. */
function eq(label, actual, expected, detail = '') {
  const same = typeof actual === 'bigint' && typeof expected === 'bigint'
    ? actual === expected
    : Object.is(actual, expected) || serialize(actual) === serialize(expected);
  ok(label, same, detail || `expected ${expected}, got ${actual}`);
}

function section(title) {
  if (_sectionStart) console.log(`   (${passed - _sectionStart} passed, ${failed - _sectionFailed} failed)`);
  _sectionStart = passed;
  _sectionFailed = failed;
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------------ *
 * Fixed-seed randomness — a re-run produces the same thousands of cases.
 * ------------------------------------------------------------------ */

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
let rng = mulberry32(SEED);
const reseed = (s) => { rng = mulberry32(s); };
const randInt = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = (arr) => arr[randInt(0, arr.length - 1)];

/* ------------------------------------------------------------------ *
 * The real database, on the double
 * ------------------------------------------------------------------ */

const fakeIdb = createFakeIndexedDB();
globalThis.indexedDB = fakeIdb;

const db = await import(js('db.js'));

async function resetDb() {
  for (const name of Object.values(db.STORES)) await db.clearStore(name);
}

/**
 * Lays down products, their variants and their FIFO lots exactly as the app
 * would hold them, returning the matching reference book.
 */
async function seedShop(spec) {
  const book = new FifoBook();
  const now = new Date('2026-01-01T00:00:00.000Z').getTime();
  let clock = 0;
  for (const p of spec) {
    const variants = p.variants.map((v) => ({
      size: v.size || '',
      color: v.color || '',
      quantity: v.lots.reduce((t, l) => t + l.qty, 0),
    }));
    await db.put(db.STORES.products, {
      id: p.id, name: p.name, sku: '', category: 'غير مصنف', description: '',
      price: p.price, costPrice: p.costPrice, variants, image: '',
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    });
    for (const v of p.variants) {
      const variantKey = `${v.size || ''}|${v.color || ''}`;
      for (const l of v.lots) {
        const createdAt = l.createdAt || new Date(now + ++clock * 1000).toISOString();
        const lot = {
          id: `${p.id}::${variantKey}::${createdAt}`,
          productId: p.id, variantKey, size: v.size || '', color: v.color || '',
          quantity: l.qty, costPrice: l.cost, sellingPrice: p.price, createdAt,
        };
        await db.put(db.STORES.stockBatches, lot);
        book.add(p.id, variantKey, { id: lot.id, qty: l.qty, costMicro: micro(l.cost), createdAt });
      }
    }
  }
  return book;
}

async function appBatchQty(productId, variantKey) {
  const batches = await db.listStockBatches();
  return batches
    .filter((b) => b.productId === productId && b.variantKey === variantKey)
    .reduce((t, b) => t + (Number(b.quantity) || 0), 0);
}

async function appBatchValueMicro() {
  const batches = await db.listStockBatches();
  return batches.reduce((t, b) => t + BigInt(Number(b.quantity) || 0) * micro(b.costPrice), 0n);
}

async function appVariantQty(productId, size, color) {
  const p = await db.get(db.STORES.products, productId);
  const v = (p?.variants || []).find((x) => x.size === size && x.color === color);
  return v ? Number(v.quantity) || 0 : 0;
}

async function appLotQty(batchId) {
  const b = await db.get(db.STORES.stockBatches, batchId);
  return b ? Number(b.quantity) || 0 : 0;
}

/** Every lot of one product, as sortable strings — for before/after compares. */
async function batchSnapshot(productId) {
  const all = await db.listStockBatches();
  return all
    .filter((b) => b.productId === productId)
    .map((b) => `${b.id}:${Number(b.quantity) || 0}`)
    .sort();
}

/** The two stock books — variants and FIFO lots — must always agree. */
async function assertBooksAgree(label, productId, variantKey) {
  const [size, color] = variantKey.split('|');
  eq(label, await appBatchQty(productId, variantKey), await appVariantQty(productId, size, color));
}

/* ------------------------------------------------------------------ *
 * «السعر يتبع الدفعة» (الخيار A) — تجهيز البيانات قبل الاختبار
 *
 * createSale/updateSale تتجاهلان `price` الممرَّرة في سطر البيع وتسعّران من
 * دفعة المخزون (FIFO أو lotId)، ويُفصَّل السطر عند تعدّد أسعار الدفعات. أي
 * اختبار يزرع منتجًا بسعر X ثم يرسل سطرًا بسعر Y ≠ سعر دفعته كان سيفشل قبل
 * هذه القاعدة. المساعدات أدناه تُصلح «التجهيز» — لا القيمة المتوقعة: تضبط
 * دفعات المقاس قبل البيع بحيث يخدم كل سطرٍ دفعةٌ بسعر هذا السطر بالضبط، مع
 * الحفاظ على تسلسل تكلفة القطع الأقدم أولًا — فتبقى المرجعية FIFO مطابقة
 * والأرقام المتوقعة كما هي.
 * ------------------------------------------------------------------ */

/**
 * Re-files each variant's lots so every sent line is served at ITS sent
 * price: one lot (or more, split at cost boundaries) per line, in line order,
 * plus a final lot for whatever stock the sale will not touch — every piece
 * keeping its original FIFO cost.
 */
async function prepLotsForCartPrices(items, tag) {
  const groups = new Map();
  for (const it of items || []) {
    const k = [it.productId, it.size || '', it.color || ''].join('\u0000');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  let clock = 0;
  for (const [k, lines] of groups) {
    const [productId, size, color] = k.split('\u0000');
    const variantKey = `${size}|${color}`;
    const old = (await db.listStockBatches())
      .filter((b) => b.productId === productId && b.variantKey === variantKey)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    // القطع كما ستخرجها الفيفو: تكلفة القطعة الأولى ثم الثانية… الأقدم أولًا.
    const pieceCosts = [];
    for (const l of old) {
      for (let i = 0; i < (Number(l.quantity) || 0); i++) pieceCosts.push(l.costPrice);
    }
    // دفعة لكل مقطع تكلفة متساوية داخل السطر، بسعر بيع هذا السطر.
    const fileRuns = async (from, to, sellingPrice) => {
      let i = from;
      while (i < to) {
        const cost = pieceCosts[i];
        let e = i + 1;
        while (e < to && pieceCosts[e] === cost) e++;
        await db.put(db.STORES.stockBatches, {
          id: `${productId}::${variantKey}::prep-${tag}-${++clock}`,
          productId, variantKey, size, color,
          quantity: e - i, costPrice: cost, sellingPrice,
          createdAt: new Date(Date.UTC(2026, 0, 2) + clock * 1000).toISOString(),
        });
        i = e;
      }
      return i;
    };
    let idx = 0;
    for (const it of lines) idx = await fileRuns(idx, idx + (Math.round(Number(it.qty)) || 0), it.price);
    await fileRuns(idx, pieceCosts.length, 0); // ما لا يُباع الآن: تكلفته محفوظة
    for (const l of old) await db.del(db.STORES.stockBatches, l.id);
  }
}

/** «السعر يتبع الدفعة»: one selling price on every existing lot of a variant. */
async function setVariantSellPrice(productId, size, color, sellingPrice) {
  const variantKey = `${size || ''}|${color || ''}`;
  const lots = (await db.listStockBatches())
    .filter((b) => b.productId === productId && b.variantKey === variantKey);
  for (const l of lots) await db.put(db.STORES.stockBatches, { ...l, sellingPrice });
}

/* ================================================================== *
 * 1 · sale totals vs the reference — thousands of random carts
 * ================================================================== */

const overview = { mismatchedFields: 0, badSum: 0, example: null };

async function saleTotalsProperty() {
  section('1 · totals of a sale (percent/fixed discount, increase, fractional price)');

  reseed(SEED + 1);
  await resetDb();

  const spec = [];
  for (let i = 0; i < 12; i++) {
    const variants = [];
    for (let j = 0; j < 2; j++) {
      const lots = [];
      for (let k = 0; k < 2; k++) lots.push({ qty: randInt(5, 60), cost: randInt(1, 4000) / 100 });
      variants.push({ size: `S${i}-${j}`, color: `C${j}`, lots });
    }
    spec.push({
      id: `p-${i}`, name: `منتج ${i}`,
      price: randInt(100, 20000) / 100,
      costPrice: randInt(50, 10000) / 100,
      variants,
    });
  }
  const book = await seedShop(spec);

  const flatVariants = [];
  for (const p of spec) {
    for (const v of p.variants) {
      flatVariants.push({ productId: p.id, name: p.name, size: v.size, color: v.color });
    }
  }

  const N = 3000;
  let fieldMismatch = 0;
  let negativeTotal = 0;
  let discountOver = 0;
  let badSum = 0;
  let costMismatch = 0;
  let example = null;

  for (let n = 0; n < N; n++) {
    const lineCount = randInt(1, 4);
    const appItems = [];
    const refLines = [];
    const reserved = new Map();

    for (let l = 0; l < lineCount; l++) {
      const fv = pick(flatVariants);
      const key = `${fv.productId}|${fv.size}|${fv.color}`;
      const avail = book.available(fv.productId, `${fv.size || ''}|${fv.color || ''}`) - (reserved.get(key) || 0);
      if (avail <= 0) continue;
      const qty = randInt(1, Math.min(5, avail));
      reserved.set(key, (reserved.get(key) || 0) + qty);
      // Mostly two decimals; sometimes a third, which the owner allows.
      const price = rng() < 0.15 ? randInt(100, 20000) / 1000 : randInt(0, 20000) / 100;
      appItems.push({ productId: fv.productId, name: fv.name, size: fv.size, color: fv.color, qty, price, costPrice: 1 });
      refLines.push({ qty, priceMicro: micro(price) });
    }
    if (!appItems.length) continue;

    const discountType = 'fixed'; // المهمة 2: الفواتير الجديدة بخصم مبلغ ثابت فقط — النسبة للفواتير القديمة وحدها
    const subtotalMicro = refLines.reduce((t, l) => t + BigInt(l.qty) * l.priceMicro, 0n);
    const discountValue = randInt(0, Number(toCents(subtotalMicro)) + 500) / 100;
    const increase = rng() < 0.25 ? randInt(0, 5000) / 100 : 0;

    const ref = saleTotals(refLines, discountType, micro(discountValue), micro(increase));

    // «السعر يتبع الدفعة» (الخيار A): createSale تجاهل سعر السطر المُرسل
    // وتسعر من دفعة المخزون، فتُجهَّز دفعات كل مقاس بسعر السطر المُرسل
    // (مع حفظ تسلسل التكلفة الأقدم أولًا) حتى تبقى الأرقام المتوقعة كما هي.
    await prepLotsForCartPrices(appItems, `s1-${n}`);

    const sale = await db.createSale({
      items: appItems, discountType, discountValue, priceIncrease: increase, paymentMethod: 'cash',
    });

    const gotSub = micro(sale.subtotal);
    const gotDisc = micro(sale.discount);
    const gotInc = micro(sale.priceIncrease);
    const gotTotal = micro(sale.total);

    if (gotSub !== centsToMicro(ref.subtotalCents) || gotDisc !== ref.discountMicro || gotTotal !== centsToMicro(ref.totalCents)) {
      fieldMismatch++;
      if (!example) example = { n, appItems, discountType, discountValue, increase, got: [gotSub, gotDisc, gotTotal], ref: [centsToMicro(ref.subtotalCents), ref.discountMicro, centsToMicro(ref.totalCents)] };
    }

    // Cost must equal the reference FIFO consumption, line by line.
    let refCost = 0n;
    for (const it of appItems) {
      const taken = book.consume(it.productId, `${it.size || ''}|${it.color || ''}`, it.qty);
      refCost += book.costOf(taken);
    }
    if (micro(sale.costTotal) !== refCost) costMismatch++;

    if (gotTotal < 0n) negativeTotal++;
    if (gotDisc > gotSub && gotSub > 0n) discountOver++;
    // What a customer sees on the receipt must add up, cent for cent.
    if (gotSub - gotDisc + gotInc !== gotTotal) {
      badSum++;
      if (!overview.example) overview.example = { kind: 'badSum', n, appItems, discountType, discountValue, increase, got: [gotSub, gotDisc, gotInc, gotTotal] };
    }
  }

  overview.mismatchedFields = fieldMismatch;
  overview.badSum = badSum;

  eq('every sale subtotal, discount and total matched the reference', fieldMismatch, 0,
    `${fieldMismatch} of ${N} carts differed${example ? ` — first: ${serialize(example)}` : ''}`);
  eq('every sale cost of goods matched the FIFO reference', costMismatch, 0, `${costMismatch} cost mismatches`);
  eq('no sale was ever written with a negative total', negativeTotal, 0);
  eq('no discount ever exceeded the subtotal', discountOver, 0);
  eq('stored subtotal − discount + increase = stored total, always (DEFECT-1)', badSum, 0, `${badSum} receipts did not add up`);
}

/* ================================================================== *
 * 2 · FIFO ordering and remaining lots
 * ================================================================== */

async function fifoProperty() {
  section('2 · FIFO: oldest lots go first, remaining lots stay exact');

  reseed(SEED + 2);
  await resetDb();

  const spec = [{
    id: 'p-fifo', name: 'منتج FIFO', price: 10, costPrice: 4,
    variants: [{
      size: 'L', color: 'أحمر',
      lots: [
        { qty: 3, cost: 4, createdAt: '2026-01-01T00:00:01.000Z' },
        { qty: 5, cost: 6, createdAt: '2026-01-01T00:00:02.000Z' },
        { qty: 4, cost: 9, createdAt: '2026-01-01T00:00:03.000Z' },
      ],
    }],
  }];
  const book = await seedShop(spec);

  const sale = await db.createSale({
    items: [{ productId: 'p-fifo', name: 'منتج FIFO', size: 'L', color: 'أحمر', qty: 4, price: 10, costPrice: 0 }],
    paymentMethod: 'cash',
  });
  const taken = book.consume('p-fifo', 'L|أحمر', 4);
  eq('cost of a 4-piece sale matches the reference FIFO take', micro(sale.costTotal), book.costOf(taken));
  eq('and that cost is 18.00 (3×4 + 1×6)', micro(sale.costTotal), 18000000n);
  eq('the OLDEST lot is emptied first', (await db.listStockBatches()).find((b) => b.costPrice === 4).quantity, 0);
  eq('the second lot keeps 4', (await db.listStockBatches()).find((b) => b.costPrice === 6).quantity, 4);
  eq('the newest lot is untouched', (await db.listStockBatches()).find((b) => b.costPrice === 9).quantity, 4);

  eq('remaining batch value equals the reference', await appBatchValueMicro(), book.totalValue());
  eq('remaining variant quantity equals the reference', await appVariantQty('p-fifo', 'L', 'أحمر'), book.available('p-fifo', 'L|أحمر'));

  const sale2 = await db.createSale({
    items: [{ productId: 'p-fifo', name: 'منتج FIFO', size: 'L', color: 'أحمر', qty: 8, price: 10, costPrice: 0 }],
    paymentMethod: 'cash',
  });
  const taken2 = book.consume('p-fifo', 'L|أحمر', 8);
  eq('second sale cost matches FIFO (4×6 + 4×9 = 60.00)', micro(sale2.costTotal), book.costOf(taken2));
  eq('and the reference says 60000000 micro', micro(sale2.costTotal), 60000000n);
  eq('the book is empty afterwards', book.available('p-fifo', 'L|أحمر'), 0);

  // Selling from an empty shelf must be refused, and must not half-consume.
  const stockBefore = await appBatchQty('p-fifo', 'L|أحمر');
  let threw = false;
  try {
    await db.createSale({
      items: [{ productId: 'p-fifo', name: 'منتج FIFO', size: 'L', color: 'أحمر', qty: 1, price: 10, costPrice: 0 }],
      paymentMethod: 'cash',
    });
  } catch { threw = true; }
  ok('selling from an empty shelf throws', threw);
  eq('and it consumed nothing', await appBatchQty('p-fifo', 'L|أحمر'), stockBefore);
}

/* ================================================================== *
 * 3 · store ledger and supplier balances vs the reference
 * ================================================================== */

async function ledgerProperty() {
  section('3 · store balance and supplier balances vs the reference');

  reseed(SEED + 3);
  await resetDb();

  await seedShop([{
    id: 'p-led', name: 'منتج الرصيد', price: 30, costPrice: 10,
    variants: [{ size: 'M', color: 'أزرق', lots: [{ qty: 100, cost: 10, createdAt: '2026-01-01T00:00:01.000Z' }] }],
  }]);

  const opening = randInt(0, 100000) / 100;
  await db.saveSettings({ openingBalance: opening });

  const saleTotalsRef = [];
  const purchaseTotalsRef = [];

  for (let n = 0; n < 30; n++) {
    const qty = randInt(1, 3);
    const discountType = 'fixed'; // المهمة 2: فواتير جديدة بخصم ثابت فقط
    const price = randInt(0, 8000) / 100;
    const discountValue = randInt(0, 3000) / 100;
    const ref = saleTotals([{ qty, priceMicro: micro(price) }], discountType, micro(discountValue), 0n);
    const items = [{ productId: 'p-led', name: 'منتج الرصيد', size: 'M', color: 'أزرق', qty, price, costPrice: 0 }];
    // «السعر يتبع الدفعة»: بيع السطر بسعره المُرسل يتطلب دفعةً بهذا السعر.
    await prepLotsForCartPrices(items, `s3-${n}`);
    const sale = await db.createSale({
      items, discountType, discountValue, paymentMethod: 'cash',
    });
    eq(`sale ${n} total matches reference`, micro(sale.total), centsToMicro(ref.totalCents));
    saleTotalsRef.push(toCents(centsToMicro(ref.totalCents)));
  }

  for (let n = 0; n < 10; n++) {
    const units = randInt(1, 20);
    const unitCost = randInt(0, 5000) / 100;
    const rec = await db.createPurchase({
      productId: 'p-led', productName: 'منتج الرصيد', unitCost, lines: [{ size: 'M', color: 'أزرق', qty: units }],
    });
    const refTotal = toCents(micro(unitCost) * BigInt(units));
    eq(`purchase ${n} total matches reference`, micro(rec.record.total), centsToMicro(refTotal));
    purchaseTotalsRef.push(refTotal);
  }

  const sales = await db.listSales();
  const purchases = await db.listPurchases();
  const settings = await db.getSettings();
  const ledger = db.storeLedger(sales, purchases, settings);

  eq('store balance equals opening + sales − purchases', micro(ledger.balance), storeBalance(micro(opening), saleTotalsRef, purchaseTotalsRef));
  eq('salesTotal matches the reference', micro(ledger.salesTotal), centsToMicro(saleTotalsRef.reduce((t, v) => t + v, 0n)));
  eq('purchasesTotal matches the reference', micro(ledger.purchasesTotal), centsToMicro(purchaseTotalsRef.reduce((t, v) => t + v, 0n)));
  eq('convenience storeBalance() agrees', micro(await db.storeBalance()), micro(ledger.balance));

  // Supplier ledger — createSupplierInvoice/Payment resolve to the record's
  // key (they are built on `put`), so the stored rows are read back here.
  const supOpening = randInt(0, 50000) / 100;
  await db.saveSupplier({ id: 'sup-1', name: 'مورد', openingBalance: supOpening });
  const invTotalsRef = [];
  for (let n = 0; n < 8; n++) {
    const qty = randInt(1, 10);
    const price = randInt(0, 3000) / 100;
    const discount = randInt(0, 2000) / 100;
    await db.createSupplierInvoice({
      supplierId: 'sup-1', invoiceNo: `INV-${n}`,
      items: [{ name: 'بند', qty, price }], discount, payStatus: 'carried',
    });
    const sub = micro(price) * BigInt(qty);
    const discRaw = micro(discount) > sub ? sub : micro(discount);
    invTotalsRef.push(sub - discRaw);
  }
  const storedInvoices = (await db.listSupplierInvoices()).sort((a, b) => String(a.invoiceNo).localeCompare(String(b.invoiceNo)));
  ok('all supplier invoices were stored', storedInvoices.length === 8, `got ${storedInvoices.length}`);
  for (let n = 0; n < storedInvoices.length; n++) {
    eq(`supplier invoice ${n} total matches reference`, micro(storedInvoices[n].total), invTotalsRef[n]);
  }

  const payRef = [];
  for (let n = 0; n < 5; n++) {
    const amount = randInt(1, 5000) / 100;
    await db.createSupplierPayment({ supplierId: 'sup-1', amount });
    payRef.push(micro(amount));
  }
  const storedPayments = await db.listSupplierPayments();
  ok('all supplier payments were stored', storedPayments.length === 5, `got ${storedPayments.length}`);
  for (let n = 0; n < storedPayments.length; n++) {
    eq(`supplier payment ${n} matches reference`, micro(storedPayments[n].amount), payRef[n]);
  }

  const suppliers = await db.listSuppliers();
  const invoices = await db.listSupplierInvoices();
  const payments = await db.listSupplierPayments();
  const bal = db.supplierBalance(suppliers[0], invoices, payments);
  const refBal = supplierBalance(micro(supOpening), invTotalsRef, payRef);
  eq('supplier billed matches reference', micro(bal.billed), refBal.billed);
  eq('supplier paid matches reference', micro(bal.paid), refBal.paid);
  eq('supplier remaining matches reference', micro(bal.remaining), refBal.remaining);
  eq('supplier owed/credit split matches reference', [Math.round(Number(micro(bal.owed))), Math.round(Number(micro(bal.credit)))], [Number(refBal.owed), Number(refBal.credit)]);
}

/* ================================================================== *
 * 4 · a sale that is fully returned puts everything back
 * ================================================================== */

async function fullReturnProperty() {
  section('4 · sell then fully return restores stock and cash');

  await resetDb();
  await seedShop([{
    id: 'p-ret', name: 'منتج مرتجع', price: 25, costPrice: 8,
    variants: [{ size: 'L', color: 'أخضر', lots: [
      { qty: 4, cost: 8, createdAt: '2026-01-01T00:00:01.000Z' },
      { qty: 6, cost: 12, createdAt: '2026-01-01T00:00:02.000Z' },
    ] }],
  }]);

  const variantsBefore = (await db.get(db.STORES.products, 'p-ret')).variants[0].quantity;
  const batchesBefore = (await db.listStockBatches()).map((b) => ({ id: b.id, q: b.quantity }));
  const valueBefore = await appBatchValueMicro();

  const sale = await db.createSale({
    items: [{ productId: 'p-ret', name: 'منتج مرتجع', size: 'L', color: 'أخضر', qty: 5, price: 25, costPrice: 0 }],
    paymentMethod: 'cash',
  });
  eq('the sale took 5 pieces of stock', await appVariantQty('p-ret', 'L', 'أخضر'), variantsBefore - 5);

  await db.refundSale(sale.id);

  eq('the variant quantity is restored', await appVariantQty('p-ret', 'L', 'أخضر'), variantsBefore);
  const batchesAfter = await db.listStockBatches();
  for (const b of batchesBefore) {
    const now = batchesAfter.find((x) => x.id === b.id);
    eq(`batch ${b.id} is restored to ${b.q} (DEFECT-A)`, now ? now.quantity : null, b.q);
  }
  eq('the FIFO lot value is fully restored (DEFECT-A)', await appBatchValueMicro(), valueBefore);
  eq('the refunded sale STAYS in the ledger (audit trail)', (await db.listSales()).length, 1);
  const refunds = await db.listRefunds();
  eq('a refund record was created', refunds.length, 1);
  eq('refund amount matches sale total', micro(refunds[0].totalRefunded), micro(25 * 5));
  eq('the store balance is back to zero (refund subtracted)', micro(await db.storeBalance()), 0n);
}

/* ================================================================== *
 * 5 · export → import changes no total
 * ================================================================== */

async function roundTripProperty() {
  section('5 · export then import preserves every total');

  reseed(SEED + 5);
  await resetDb();
  await seedShop([{
    id: 'p-rt', name: 'منتج النسخة', price: 40, costPrice: 15,
    variants: [{ size: 'M', color: 'بني', lots: [{ qty: 20, cost: 15, createdAt: '2026-01-01T00:00:01.000Z' }] }],
  }]);

  await db.createSale({
    items: [{ productId: 'p-rt', name: 'منتج النسخة', size: 'M', color: 'بني', qty: 3, price: 40, costPrice: 0 }],
    discountType: 'percent', discountValue: 10, paymentMethod: 'cash',
  });
  // «السعر يتبع الدفعة» (الخيار A): هذا السطر بسعر 33.33 ≠ سعر دفعة المنتج
  // (40)، فنضع الدفعة على السعر المكتوب قبل البيع — وإلا بيع بسعر 40 وفقد
  // الاختبار نيّته (كسرة عشرية في الفاتورة) دون أن يفشل. (النسبة 10% هنا
  // عن قصد: الفاتورة تمثّل فاتورة قديمة بنسبة في نسخة احتياطية، وما زالت
  // تُقرأ وتُعدَّل وتُصدَّر كما كانت.)
  await prepLotsForCartPrices(
    [{ productId: 'p-rt', name: 'منتج النسخة', size: 'M', color: 'بني', qty: 2, price: 33.33, costPrice: 0 }],
    's5b',
  );
  await db.createSale({
    items: [{ productId: 'p-rt', name: 'منتج النسخة', size: 'M', color: 'بني', qty: 2, price: 33.33, costPrice: 0 }],
    discountType: 'fixed', discountValue: 5, priceIncrease: 7.5, paymentMethod: 'cash',
  });

  const before = await db.exportAll();

  await resetDb();
  await db.importAll(before);

  const after = await db.exportAll();

  eq('stored subtotal/discount/total survive the round trip (DEFECT-D)',
    after.sales.map((s) => [micro(s.subtotal), micro(s.discount), micro(s.total)]),
    before.sales.map((s) => [micro(s.subtotal), micro(s.discount), micro(s.total)]),
    serialize({ before: before.sales.map((s) => [micro(s.subtotal), micro(s.discount), micro(s.total)]), after: after.sales.map((s) => [micro(s.subtotal), micro(s.discount), micro(s.total)]) }));
  eq('the sale count survives', after.sales.length, before.sales.length);
  eq('the cost of goods survives', after.sales.map((s) => micro(s.costTotal)), before.sales.map((s) => micro(s.costTotal)));
  eq('the stock batches survive (DEFECT-C)', after.stockBatches.length, before.stockBatches.length);
  eq('the inventory value survives (DEFECT-C)', await appBatchValueMicro(),
    before.stockBatches.reduce((t, b) => t + BigInt(Number(b.quantity)) * micro(b.costPrice), 0n));
}

/* ================================================================== *
 * 6 · three hand-checkable scenarios
 * ================================================================== */

async function manualScenarios() {
  section('6 · three scenarios you can check by hand in the app');

  // ── A: خصم مبلغ ثابت على فاتورة من سطرين (المهمة 2: لا نسبة في فاتورة جديدة) ──
  //   الخطوة بخطوة:
  //     المجموع الفرعي = 2 × 19.99 + 1 × 0.05 = 39.98 + 0.05 = 40.03
  //     الخصم          = 6.00 مبلغ ثابت (FIXED — لا 15%)
  //     الإجمالي       = 40.03 − 6.00 = 34.03
  //
  //   قبل المهمة 2 كان الخصم نسبة 15%: 15% من 40.03 = 6.0045 → 6.00 — أي أن
  //   الأرقام الثلاثة قبل/بعد متغيّرة في النوع فقط (percent ← fixed) لا في
  //   قيمتها: الخصم 6.00 والإجمالي 34.03 كما كانا. (النسبة مدعومة الآن في
  //   money.js للفواتير القديمة فقط.)
  //
  //   «السعر يتبع الدفعة» (الخيار A): السطران من مقاس واحد بسعرين مختلفين،
  //   فتُجهَّز دفعتان قبل البيع — دفعة بسعر 19.99 للسطر الأول ودفعة بسعر
  //   0.05 للثاني — حتى يخرج كل سطر بسعره المكتوب. (بدون ذلك كان البيع
  //   يسعّر القطع الثلاث كلها من دفعة واحدة بسعر 19.99 → فرعي 59.97.)
  await resetDb();
  await seedShop([{
    id: 'p-a', name: 'أ', price: 19.99, costPrice: 8,
    variants: [{ size: 'S', color: 'X', lots: [{ qty: 10, cost: 8, createdAt: '2026-01-01T00:00:01.000Z' }] }],
  }]);
  const itemsA = [
    { productId: 'p-a', name: 'أ', size: 'S', color: 'X', qty: 2, price: 19.99, costPrice: 0 },
    { productId: 'p-a', name: 'أ', size: 'S', color: 'X', qty: 1, price: 0.05, costPrice: 0 },
  ];
  await prepLotsForCartPrices(itemsA, 's6a');
  const saleA = await db.createSale({
    items: itemsA,
    discountType: 'fixed', discountValue: 6, paymentMethod: 'cash',
  });
  eq('A subtotal = 40.03 (المجموع الفرعي)', micro(saleA.subtotal), 40030000n);
  eq('A discount = 6.00 (مبلغ ثابت)', micro(saleA.discount), 6000000n);
  eq('A total = 34.03 (40.03 − 6.00)', micro(saleA.total), 34030000n);

  // ── B: fixed discount larger than the cart ─────────────────────────
  await resetDb();
  await seedShop([{
    id: 'p-b', name: 'ب', price: 10, costPrice: 4,
    variants: [{ size: 'S', color: 'X', lots: [{ qty: 10, cost: 4, createdAt: '2026-01-01T00:00:01.000Z' }] }],
  }]);
  const saleB = await db.createSale({
    items: [{ productId: 'p-b', name: 'ب', size: 'S', color: 'X', qty: 2, price: 10, costPrice: 0 }],
    discountType: 'fixed', discountValue: 25, paymentMethod: 'cash',
  });
  eq('B subtotal = 20.00', micro(saleB.subtotal), 20000000n);
  eq('B discount is clamped to 20.00', micro(saleB.discount), 20000000n);
  eq('B total = 0.00, never negative', micro(saleB.total), 0n);

  // ── C: FIFO across two lots, plus a price increase ─────────────────
  //   lot1: 3 × 4.00, lot2: 2 × 6.00. Sell 4 @ 10.00
  //   cost = 3×4 + 1×6 = 18.00 ; subtotal 40.00 ; +2.50 → 42.50
  //   profit = 42.50 − 18.00 = 24.50
  await resetDb();
  await seedShop([{
    id: 'p-c', name: 'ج', price: 10, costPrice: 4,
    variants: [{ size: 'S', color: 'X', lots: [
      { qty: 3, cost: 4, createdAt: '2026-01-01T00:00:01.000Z' },
      { qty: 2, cost: 6, createdAt: '2026-01-01T00:00:02.000Z' },
    ] }],
  }]);
  const saleC = await db.createSale({
    items: [{ productId: 'p-c', name: 'ج', size: 'S', color: 'X', qty: 4, price: 10, costPrice: 0 }],
    priceIncrease: 2.5, paymentMethod: 'cash',
  });
  eq('C subtotal = 40.00', micro(saleC.subtotal), 40000000n);
  eq('C total = 42.50', micro(saleC.total), 42500000n);
  eq('C cost of goods = 18.00 (FIFO)', micro(saleC.costTotal), 18000000n);
  eq('C profit = 24.50', micro(saleC.total) - micro(saleC.costTotal), 24500000n);
}

/* ================================================================== *
 * 7 · rounding edges the shop will actually meet
 * ================================================================== */

async function roundingEdges() {
  section('7 · rounding edges');

  eq('6.0045 → 6.00', roundHalfUp(60045n, 10000n), 6n);
  eq('2.5 → 3 (halves away from zero)', roundHalfUp(5n, 2n), 3n);
  eq('6.005 to the nearest whole is 6', roundHalfUp(6005n, 1000n), 6n);
  eq('33% of 9.99 = 999×33/100 = 329.67 → 330', roundHalfUp(999n * 33n, 100n), 330n);
  eq('micro("19.995") = 19995000', micro('19.995'), 19995000n);
  eq('micro("0.05") = 50000', micro('0.05'), 50000n);
  eq('micro(19.99) = 19990000', micro(19.99), 19990000n);

  // 50% of 1 agora is half an agora, which rounds UP to a whole agora.
  const t = saleTotals([{ qty: 1, priceMicro: 10000n }], 'percent', 50n, 0n);
  eq('half an agora rounds up to one, not to zero', t.discountMicro, 10000n);
}

/* ================================================================== *
 * 8 · editing a saved sale — FIFO recompute, refusals, legacy sales
 * ================================================================== */

async function editSaleProperty() {
  section('8 · editing a saved sale (FIFO recompute, refusal safety, legacy sales)');

  const LOT_A = 'p-ed::M|أحمر::2026-01-01T00:00:01.000Z';
  const LOT_B = 'p-ed::M|أحمر::2026-01-01T00:00:02.000Z';
  const line = (qty, price = 20) => [
    { productId: 'p-ed', name: 'منتج التعديل', size: 'M', color: 'أحمر', qty, price, costPrice: 0 },
  ];
  const seed = () => seedShop([{
    id: 'p-ed', name: 'منتج التعديل', price: 20, costPrice: 5,
    variants: [{ size: 'M', color: 'أحمر', lots: [
      { qty: 10, cost: 5, createdAt: '2026-01-01T00:00:01.000Z' },
      { qty: 10, cost: 8, createdAt: '2026-01-01T00:00:02.000Z' },
    ] }],
  }]);

  reseed(SEED + 8);
  await resetDb();
  await seed();

  const sale = await db.createSale({ items: line(4), paymentMethod: 'cash' });
  eq('the sale took 4 from the oldest lot', await appLotQty(LOT_A), 6);
  eq('and left the newer lot alone', await appLotQty(LOT_B), 10);
  eq('its cost is the oldest lot: 4×5', micro(sale.costTotal), 20000000n);

  // ── edit up, still inside the first lot ───────────────────────────
  const up1 = await db.updateSale(sale.id, { items: line(7) });
  eq('edit up: variants follow the new quantity', await appVariantQty('p-ed', 'M', 'أحمر'), 13);
  eq('edit up: the oldest lot now gives 7 in total', await appLotQty(LOT_A), 3);
  eq('edit up: cost is recomputed from the lots (7×5)', micro(up1.costTotal), 35000000n);
  eq('edit up: the per-piece cost is the FIFO figure', micro(up1.items[0].costPrice), 5000000n);
  eq('edit up: the rewritten records cover exactly the new quantity',
    up1.stockBatchesConsumed.reduce((t, c) => t + c.qty, 0), 7);
  await assertBooksAgree('edit up: lots and variants agree', 'p-ed', 'M|أحمر');

  // ── edit up across lots: FIFO order, not the stored average ────────
  const up2 = await db.updateSale(sale.id, { items: line(13) });
  eq('edit across lots: variants', await appVariantQty('p-ed', 'M', 'أحمر'), 7);
  eq('edit across lots: the oldest lot is emptied', await appLotQty(LOT_A), 0);
  eq('edit across lots: the newer lot keeps 7', await appLotQty(LOT_B), 7);
  // 10×5 + 3×8 = 74. The old stored weighted average (5) would have said 65.
  eq('edit across lots: cost is 74, the FIFO figure (a stored average would say 65)',
    micro(up2.costTotal), 74000000n);
  await assertBooksAgree('edit across lots: lots and variants agree', 'p-ed', 'M|أحمر');

  // ── an edit the shelf cannot supply changes nothing ────────────────
  const beforeSale = serialize(await db.get(db.STORES.sales, sale.id));
  const beforeBatches = serialize(await batchSnapshot('p-ed'));
  const beforeVariant = await appVariantQty('p-ed', 'M', 'أحمر');
  let refused = false;
  try {
    await db.updateSale(sale.id, { items: line(21) }); // 13 come back, 7 are on the shelf: 20 is the ceiling
  } catch { refused = true; }
  ok('an edit the shelf cannot supply is refused', refused);
  eq('the refused edit left the sale untouched', serialize(await db.get(db.STORES.sales, sale.id)), beforeSale);
  eq('the refused edit left the lots untouched (the restore was rolled back)',
    serialize(await batchSnapshot('p-ed')), beforeBatches);
  eq('the refused edit left the variants untouched', await appVariantQty('p-ed', 'M', 'أحمر'), beforeVariant);

  // ── an edit's totals are exact, like a new sale's ──────────────────
  // «السعر يتبع الدفعة» (الخيار A): التعديل يعيد التسعير من الدفعات، فقبل
  // التعديل بسعر 1.505 نضع سعر البيع 1.505 على دفعات المقاس — وإلا خرج
  // السطر بسعر الدفعة القديم (20) وصار الفرعي 60.00 بدل 4.52.
  await setVariantSellPrice('p-ed', 'M', 'أحمر', 1.505);
  const refT = saleTotals([{ qty: 3, priceMicro: micro(1.505) }], 'percent', 15n, micro(3.33));
  const editTot = await db.updateSale(sale.id, {
    items: line(3, 1.505), discountType: 'percent', discountValue: 15, priceIncrease: 3.33,
  });
  eq('an edit stores the exact subtotal', micro(editTot.subtotal), centsToMicro(refT.subtotalCents));
  eq('an edit stores the exact discount', micro(editTot.discount), refT.discountMicro);
  eq('an edit stores the exact increase', micro(editTot.priceIncrease), centsToMicro(toCents(micro(3.33))));
  eq('an edit stores the exact total', micro(editTot.total), centsToMicro(refT.totalCents));
  eq('the edited receipt adds up',
    micro(editTot.subtotal) - micro(editTot.discount) + micro(editTot.priceIncrease), micro(editTot.total));
  await assertBooksAgree('after an edited invoice, lots and variants agree', 'p-ed', 'M|أحمر');

  // ── a legacy sale (no lot records): edit, then refund ──────────────
  reseed(SEED + 9);
  await resetDb();
  await seed();
  const legacy = await db.createSale({ items: line(4), paymentMethod: 'cash' });
  // Strip the records: this is a sale made before batches existed. The lots
  // already exclude its stock (v5 seeded them from the post-sale variants),
  // so only the difference may move now.
  await db.put(db.STORES.sales, { ...(await db.get(db.STORES.sales, legacy.id)), stockBatchesConsumed: [] });
  // The invoice editor patches the SALE'S OWN lines (cost included) — a qty
  // change, not a fresh line. This mirrors that: keep the stored cost.
  const restated = async (qty) =>
    (await db.get(db.STORES.sales, legacy.id)).items.map((it) => ({ ...it, qty }));

  const lUp = await db.updateSale(legacy.id, { items: await restated(6) });
  eq('legacy edit up: variants', await appVariantQty('p-ed', 'M', 'أحمر'), 14);
  eq('legacy edit up: only the increase (2) leaves the lots', await appLotQty(LOT_A), 4);
  eq('legacy edit up: no lot records are invented', (lUp.stockBatchesConsumed || []).length, 0);
  eq('legacy edit keeps the line cost it was given', micro(lUp.items[0].costPrice), 5000000n);
  await assertBooksAgree('legacy edit up: lots and variants agree', 'p-ed', 'M|أحمر');

  await db.updateSale(legacy.id, { items: await restated(2) });
  eq('legacy edit down: variants', await appVariantQty('p-ed', 'M', 'أحمر'), 18);
  const freshLot = (await db.listStockBatches())
    .find((b) => b.productId === 'p-ed' && b.id !== LOT_A && b.id !== LOT_B);
  ok('legacy edit down files the surplus as a fresh lot of 4',
    !!freshLot && Number(freshLot.quantity) === 4);
  eq('the fresh lot carries the line cost', freshLot ? micro(freshLot.costPrice) : -1n, 5000000n);
  await assertBooksAgree('legacy edit down: lots and variants agree', 'p-ed', 'M|أحمر');

  await db.refundSale(legacy.id);
  eq('refunding a legacy sale restores the variants', await appVariantQty('p-ed', 'M', 'أحمر'), 20);
  eq('refunding a legacy sale restores every lot in full', await appBatchQty('p-ed', 'M|أحمر'), 20);
  await assertBooksAgree('legacy refund: lots and variants agree', 'p-ed', 'M|أحمر');
}

/* ================================================================== *
 * 9 · the cart shows exactly what the receipt will store
 * ================================================================== */

async function cartDisplayProperty() {
  section('9 · the cart total equals what the receipt will store');

  const cartStore = await import(js('cart-store.js'));
  const ref = (type, value) => saleTotals([{ qty: 3, priceMicro: micro(1.505) }], type, value, 0n);

  cartStore.clearCart();
  cartStore.addLine({
    key: 'a', productId: 'p-display', name: 'منتج العرض', size: 'M', color: 'أحمر',
    price: 1.505, costPrice: 1, max: 10,
  });
  cartStore.setQty('a', 3); // 3 × 1.505 = 4.515 — exactly half an agora: 4.52, not 4.51

  const r1 = ref('fixed', 0n);
  eq('the cart subtotal is the exact rounded one (4.52, not 4.51)',
    micro(cartStore.subtotal()), centsToMicro(r1.subtotalCents));
  eq('the cart grand total equals the receipt total',
    micro(cartStore.grandTotal()), centsToMicro(r1.totalCents));

  // المهمة 2: الخصم في السلة مبلغ ثابت فقط — التوقيع الجديد `setDiscount(50)`.
  // التوقيع القديم setDiscount('percent', 50) كان يستقبل نوعًا ونسبة؛ القيمة
  // الجديدة تُقرأ كرقم فتصير NaN → صفر (ولذلك كان الخصم يظهر 0.00).
  //   قبل (نسبة 50%): خصم 2.26 على 4.52 → إجمالي 2.26
  //   بعد (مبلغ ثابت 50): الخصم يُقصّ إلى المجموع الفرعي → خصم 4.52 → إجمالي 0.00
  cartStore.setDiscount(50);
  const r2 = ref('fixed', micro(50)); // المبلغ الثابت يُمرَّر بوحدة micro مثل فرعيات الأسعار
  eq('the cart discount equals the receipt discount (fixed, clamped to the bill)',
    micro(cartStore.discountAmount()), r2.discountMicro);
  eq('the cart grand total matches after a fixed discount (0.00, never negative)',
    micro(cartStore.grandTotal()), centsToMicro(r2.totalCents));

  cartStore.clearCart();
  eq('an emptied cart totals zero', micro(cartStore.subtotal()), 0n);
}

/* ================================================================== *
 * 10 · opening lots for a product saved by the form
 * ================================================================== */

async function productFormLotsProperty() {
  section('10 · a new product saved with a form-minted id gets its opening lots');

  reseed(SEED + 10);
  await resetDb();

  const productLots = async () =>
    (await db.listStockBatches()).filter((b) => b.productId === 'p-form');

  // The product form mints the id before the first save (`hydrate` in
  // product-form.js: `id: p?.id || uid()`), so "this product is new" has to be
  // read from the store, not from a missing id. Judged by the id that is always
  // present, the app filed no opening lots at all — and the first sale of any
  // freshly added product threw "Insufficient stock". This is that path.
  await db.saveProduct({
    id: 'p-form', name: 'منتج النموذج', price: 30, costPrice: 12,
    variants: [{ size: 'L', color: 'أحمر', quantity: 7 }],
  });
  const lots = await productLots();
  eq('a product saved with an id still files one opening lot', lots.length, 1);
  eq('holding the opening quantity', Number(lots[0]?.quantity), 7);
  eq('at the product cost price', micro(lots[0]?.costPrice), micro(12));

  // A second save is an edit, and an edit must not file the opening lot again
  // (DEFECT-E): that would silently double the shelf.
  await db.saveProduct({
    id: 'p-form', name: 'منتج النموذج', price: 30, costPrice: 12,
    variants: [{ size: 'L', color: 'أحمر', quantity: 7 }],
  });
  eq('a second save (an edit) files no extra lot', (await productLots()).length, 1);
  eq('so the shelf still holds the same quantity', await appBatchQty('p-form', 'L|أحمر'), 7);

  // And the whole point of the opening lot: the first sale works, at FIFO cost.
  // The failure this guards against is createSale throwing "Insufficient stock"
  // on a product that visibly has stock, so the check is a clean assertion
  // rather than an uncaught throw that would abort the rest of the suite.
  let sale = null;
  let saleError = null;
  try {
    sale = await db.createSale({
      items: [{ productId: 'p-form', name: 'منتج النموذج', size: 'L', color: 'أحمر', qty: 3, price: 30, costPrice: 12 }],
    });
  } catch (err) {
    saleError = err;
  }
  ok('the opening stock can be sold (no "Insufficient stock")', !!sale, saleError?.message);
  if (sale) {
    eq('at the product cost (3×12)', micro(sale.costTotal), micro(36));
    eq('leaving the rest on the shelf', await appBatchQty('p-form', 'L|أحمر'), 4);
    eq('with the variant kept in step', await appVariantQty('p-form', 'L', 'أحمر'), 4);
    await assertBooksAgree('opening-lot sale: lots and variants agree', 'p-form', 'L|أحمر');
  }
}

/* ================================================================== *
 * 11 · restock at a NEW price — the old lots keep their own prices
 *
 * The owner's rule (7ب): every restock at a new price files a SEPARATE lot
 * (quantity + cost + selling price) and never touches the old lots or their
 * invoices. The product-level cost/price becomes the "last price" — a display
 * figure only. Selling an OLD piece after the restock must cost the OLD lot's
 * cost and record the OLD lot's selling price, even though the product now
 * displays the new ones.
 * ================================================================== */

async function restockNewPriceProperty() {
  section('11 · restock at a new price files a separate lot; old lots keep their own prices');

  reseed(SEED + 11);
  await resetDb();
  await seedShop([{
    id: 'p-rs', name: 'منتج التجديد', price: 15, costPrice: 10,
    variants: [{ size: 'M', color: 'أسود', lots: [{ qty: 10, cost: 10, createdAt: '2026-01-01T00:00:01.000Z' }] }],
  }]);

  const oldLotId = (await db.listStockBatches()).find((b) => b.productId === 'p-rs').id;

  // تجديد 5 قطع بتكلفة شراء 12 وسعر بيع جديد 18
  const res = await db.restockProduct({
    productId: 'p-rs', productName: 'منتج التجديد',
    lines: [{ size: 'M', color: 'أسود', qty: 5 }], unitCost: 12, newPrice: 18,
  });
  eq('the purchase row bills exactly 5 × 12', micro(res.record.total), micro(60));

  const lots = (await db.listStockBatches()).filter((b) => b.productId === 'p-rs');
  eq('the restock filed exactly ONE new lot', lots.length, 2);
  const newLot = lots.find((b) => b.id !== oldLotId);
  eq('the new lot holds only the new pieces (5)', Number(newLot.quantity), 5);
  eq('the new lot carries the NEW cost (12)', micro(newLot.costPrice), micro(12));
  eq('the new lot carries the NEW selling price (18)', micro(newLot.sellingPrice), micro(18));

  const oldLot = await db.get(db.STORES.stockBatches, oldLotId);
  eq('the OLD lot keeps its quantity (10)', Number(oldLot.quantity), 10);
  eq('the OLD lot keeps its OWN cost (10) — untouched', micro(oldLot.costPrice), micro(10));
  eq('the OLD lot keeps its OWN selling price (15) — untouched', micro(oldLot.sellingPrice), micro(15));

  const p = await db.get(db.STORES.products, 'p-rs');
  eq('the product shows the LAST cost (12) — display only', micro(p.costPrice), micro(12));
  eq('the product shows the LAST price (18) — display only', micro(p.price), micro(18));

  // بيع قطعتين قديمتين (FIFO) بعد التجديد: التكلفة من الدفعة القديمة دائمًا.
  const sale = await db.createSale({
    items: [{ productId: 'p-rs', name: 'منتج التجديد', size: 'M', color: 'أسود', qty: 2, price: 18, costPrice: 0 }],
    paymentMethod: 'cash',
  });
  eq('selling OLD stock after the restock costs the OLD lot (2×10 = 20)', micro(sale.costTotal), micro(20));
  eq('the consumed record names the OLD lot', sale.stockBatchesConsumed[0].batchId, oldLotId);
  eq('the consumed record carries the OLD lot selling price (15)', micro(sale.stockBatchesConsumed[0].sellingPrice), micro(15));
  eq('the old lot is now 8, the new lot still 5', await appBatchQty('p-rs', 'M|أسود'), 13);
  await assertBooksAgree('after the restock + old-stock sale, lots and variants agree', 'p-rs', 'M|أسود');
}

/* ================================================================== *
 * Run
 * ================================================================== */

console.log('Store Hub — accounting verification');
console.log(`seed ${SEED} (fixed: the same cases every run)`);

await saleTotalsProperty();
await fifoProperty();
await ledgerProperty();
await fullReturnProperty();
await roundTripProperty();
await manualScenarios();
await roundingEdges();
await editSaleProperty();
await cartDisplayProperty();
await productFormLotsProperty();
await restockNewPriceProperty();

console.log(`\n${'='.repeat(56)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log('='.repeat(56));

process.exitCode = failed === 0 ? 0 : 1;
