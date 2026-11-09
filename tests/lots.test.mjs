/**
 * Store Hub — price lots (دفعات المخزون) tests.
 *
 *   node tests/lots.test.mjs
 *
 * ─────────────────────────────────────────────────────────────────────────
 * What this file is for
 * ─────────────────────────────────────────────────────────────────────────
 * "تجديد الكمية بسعر جديد" files a SEPARATE stock batch with its own cost and
 * selling price. From that moment one product+variant carries more than one
 * selling price on the shelf, and every rule below has to hold without the old
 * lots — or their invoices — being touched:
 *
 *   • a restock at a new price never rewrites an old lot's prices (7ب);
 *   • the cost of a sale comes from the lots ACTUALLY consumed, each piece at
 *     its own lot's cost, and the consumed records carry each lot's own
 *     selling price;
 *   • a line may name its lot (`lotId`): that batch is served first, the
 *     remainder falls back to FIFO, and a foreign lot id is a refusal;
 *   • a full return puts every piece back into ITS OWN lot — the lot map after
 *     the return equals the lot map before the sale;
 *   • editing an invoice recomputes FIFO the way it always has;
 *   • the basket reservation (cart-store) never lets the basket promise more
 *     than the shelf minus what it already holds;
 *   • export → import preserves the lots and the consumed records exactly;
 *   • a chosen-lot sale that fails mid-write leaves the database byte-for-byte
 *     identical (fault injection, same mechanism as tests/atomicity.test.mjs).
 *
 * Everything is measured against the independent reference (FifoBook), which
 * now tracks each lot's selling price too. The random campaign runs on a fixed
 * NEW seed (20261017) so its cases repeat run after run, and after EVERY step
 * it compares the app's lots — per id, not just per variant — with the
 * reference book.
 *
 * Zero dependencies: the project has no node_modules and must not grow one.
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

function eq(label, actual, expected, detail = '') {
  const bi = (_k, v) => (typeof v === 'bigint' ? `${v}n` : v);
  const a = typeof actual === 'bigint' ? `${actual}n` : actual;
  const e = typeof expected === 'bigint' ? `${expected}n` : expected;
  let same = Object.is(a, e);
  try { same = same || JSON.stringify(a, bi) === JSON.stringify(e, bi); } catch { /* fall through */ }
  ok(label, same, detail || `expected ${e}, got ${a}`);
}

function section(title) {
  if (_sectionStart) console.log(`   (${passed - _sectionStart} passed, ${failed - _sectionFailed} failed)`);
  _sectionStart = passed;
  _sectionFailed = failed;
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------------ *
 * Fixed-seed randomness — the lots campaign (seed 20261017)
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

const SEED = 20261017; // the lots campaign's own fixed seed (distinct from 20261016)
let rng = mulberry32(SEED);
const reseed = (s) => { rng = mulberry32(s); };
const randInt = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

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
 * Fault injection — the same mechanism tests/atomicity.test.mjs uses
 * ------------------------------------------------------------------ */

function injectWrite(store, { nth = 1, key = undefined } = {}) {
  let seen = 0;
  fakeIdb.faults.write = (s, k) => {
    if (s !== store) return null;
    if (key !== undefined && String(k) !== String(key)) return null;
    seen += 1;
    return seen >= nth ? new Error(`injected write failure on ${store}`) : null;
  };
}
function clearFaults() {
  fakeIdb.faults.write = null;
  fakeIdb.faults.read = null;
}

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

/* ------------------------------------------------------------------ *
 * App-side readers
 * ------------------------------------------------------------------ */

async function appLots(productId, variantKey) {
  const batches = await db.listStockBatches();
  return batches
    .filter((b) => b.productId === productId && b.variantKey === variantKey)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

async function appLotQty(batchId) {
  const b = await db.get(db.STORES.stockBatches, batchId);
  return b ? Number(b.quantity) || 0 : 0;
}

async function appVariantQty(productId, size, color) {
  const p = await db.get(db.STORES.products, productId);
  const v = (p?.variants || []).find((x) => x.size === size && x.color === color);
  return v ? Number(v.quantity) || 0 : 0;
}

async function booksAgree(label, productId, variantKey) {
  const [size, color] = variantKey.split('|');
  const lots = await appLots(productId, variantKey);
  eq(label, lots.reduce((t, b) => t + (Number(b.quantity) || 0), 0), await appVariantQty(productId, size, color));
}

/** The app's lot map (id → quantity) for one variant — the shape a return must reproduce. */
async function lotMap(productId, variantKey) {
  const lots = await appLots(productId, variantKey);
  return lots.map((b) => `${b.id}:${Number(b.quantity) || 0}:${micro(b.costPrice)}:${micro(b.sellingPrice)}`).sort();
}

/**
 * The reference cost of a set of takes under the owner's Option A rule
 * («سعر البيع يتبع الدفعة»): every take is priced by ITS OWN lot's selling
 * price, the takes are grouped by that price — the same partition
 * js/lot-pricing.js `groupTakesByPrice` makes, one stored line per price —
 * each group's cost is rounded to whole agorot EXACTLY ONCE, and the rounded
 * groups are summed.
 *
 * Rounding the whole sale once (what this reference did before) lands a
 * different agora whenever a sale spans lots whose sub-agora dust rounds in
 * opposite directions — the ±0.01 gaps the random campaign used to report.
 * js/db.js `createSale`/`updateSale` store one `costTotal` per split line, so
 * the yardstick has to round per price group to be the same rule.
 *
 * Grouping is keyed on the exact `sellMicro`; `groupTakesByPrice` uses a
 * 1e-9-shekel tolerance, but every price in this file differs by at least
 * 0.01, so both produce the identical partition.
 */
function refSaleCost(taken) {
  const byPrice = new Map();
  for (const c of taken) {
    byPrice.set(c.sellMicro, (byPrice.get(c.sellMicro) || 0n) + BigInt(c.qty) * c.costMicro);
  }
  let sum = 0n;
  for (const groupCost of byPrice.values()) sum += centsToMicro(toCents(groupCost));
  return sum;
}

/* ================================================================== *
 * 1 · the task's own numeric example, end to end
 *
 *   قديم: 10 قطع، تكلفة 10، سعر بيع 15
 *   تجديد: 5 قطع، تكلفة 12، سعر بيع جديد 18
 *   ⇒ دفعة جديدة منفصلة، الدفعة القديمة كما هي، سعر المنتج "آخر سعر".
 * ================================================================== */

const P = 'p-lots';
const VK = 'M|أسود';
const LOT_OLD = 'p-lots::M|أسود::old';
const lotOld = () => db.get(db.STORES.stockBatches, LOT_OLD);
const lotNew = (batches) => batches.find((b) => b.id !== LOT_OLD);

async function seedOldProduct() {
  await resetDb();
  await db.put(db.STORES.products, {
    id: P, name: 'منتج الدفعات', sku: '', category: 'غير مصنف', description: '',
    price: 15, costPrice: 10,
    variants: [{ size: 'M', color: 'أسود', quantity: 10 }],
    image: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  await db.put(db.STORES.stockBatches, {
    id: LOT_OLD, productId: P, variantKey: VK, size: 'M', color: 'أسود',
    quantity: 10, costPrice: 10, sellingPrice: 15, createdAt: '2026-01-01T00:00:01.000Z',
  });
}

async function restockExample() {
  section('1 · تجديد 5 قطع (تكلفة 12، سعر بيع 18) فوق 10 قطع قديمة (تكلفة 10، سعر 15)');

  await seedOldProduct();
  const res = await db.restockProduct({
    productId: P, productName: 'منتج الدفعات',
    lines: [{ size: 'M', color: 'أسود', qty: 5 }], unitCost: 12, newPrice: 18,
  });

  eq('الفاتورة المحاسبية للتجديد بالضبط 5×12 = 60', micro(res.record.total), micro(60));

  const lots = await appLots(P, VK);
  eq('الدفعة الجديدة سُجلت كدفعة منفصلة (دفتان الآن)', lots.length, 2);
  const nl = lotNew(lots);
  eq('الدفعة الجديدة تحمل 5 قطع فقط', Number(nl.quantity), 5);
  eq('تكلفة الدفعة الجديدة 12', micro(nl.costPrice), micro(12));
  eq('سعر بيع الدفعة الجديدة 18', micro(nl.sellingPrice), micro(18));

  const ol = await lotOld();
  eq('الدفعة القديمة على كميتها (10)', Number(ol.quantity), 10);
  eq('تكلفة القطع القديمة ما زالت 10 — لم تُمَس', micro(ol.costPrice), micro(10));
  eq('سعر بيع القطع القديمة ما زال 15 — لم يُمَس', micro(ol.sellingPrice), micro(15));

  const p = await db.get(db.STORES.products, P);
  eq('سعر المنتج المعروض صار 18 (آخر سعر — للعرض فقط)', micro(p.price), micro(18));
  eq('تكلفة المنتج المعروضة صارت 12 (للعرض فقط)', micro(p.costPrice), micro(12));

  // بيع قطعتين قديمتين بعد التجديد (FIFO الافتراضي، سعر السطر كما يمرره
  // المستدعي — 18 هو آخر سعر):
  const sale = await db.createSale({
    items: [{ productId: P, name: 'منتج الدفعات', size: 'M', color: 'أسود', qty: 2, price: 18, costPrice: 0 }],
    paymentMethod: 'cash',
  });
  eq('تكلفة القطعتين القديمتين من دفعتنهما: 2×10 = 20', micro(sale.costTotal), micro(20));
  eq('سجل الاستهلاك يسمّي الدفعة القديمة', sale.stockBatchesConsumed[0].batchId, LOT_OLD);
  eq('وسجل سعر بيع الدفعة القديمة (15) لا الجديد', micro(sale.stockBatchesConsumed[0].sellingPrice), micro(15));
  eq('بقيت من القديمة 8', await appLotQty(LOT_OLD), 8);
  eq('والجديدة ما زالت 5', Number((await lotNew(await appLots(P, VK))).quantity), 5);
  await booksAgree('دفعتا المخزون متفقتان بعد البيع', P, VK);
}

/* ================================================================== *
 * 2 · FIFO from the oldest lot — cost AND recorded selling price
 * ================================================================== */

async function fifoOldestSale() {
  section('2 · بيع من الدفعة الأقدم (FIFO): التكلفة وسعر البيع المسجل من الدفعة القديمة');

  await seedOldProduct();
  await db.restockProduct({
    productId: P, lines: [{ size: 'M', color: 'أسود', qty: 5 }], unitCost: 12, newPrice: 18,
  });

  const book = new FifoBook();
  book.add(P, VK, { id: LOT_OLD, qty: 10, costMicro: micro(10), sellMicro: micro(15), createdAt: '2026-01-01T00:00:01.000Z' });
  const nl = lotNew(await appLots(P, VK));
  book.add(P, VK, { id: nl.id, qty: 5, costMicro: micro(12), sellMicro: micro(18), createdAt: nl.createdAt });

  // بيع 12 قطعة: كل القديمة (10) + 2 من الجديدة
  const sale = await db.createSale({
    items: [{ productId: P, name: 'منتج الدفعات', size: 'M', color: 'أسود', qty: 12, price: 18, costPrice: 0 }],
    paymentMethod: 'cash',
  });
  const refTaken = book.consume(P, VK, 12);

  eq('التكلفة تطابق المرجع (10×10 + 2×12 = 124)', micro(sale.costTotal), refSaleCost(refTaken));
  eq('والقيمة المرجعية بالضبط 124', book.costOf(refTaken), micro(124));
  const refById = new Map(refTaken.map((c) => [c.id, c.qty]));
  const appById = new Map(sale.stockBatchesConsumed.map((c) => [c.batchId, c.qty]));
  eq('الكميات المسجلة تطابق المرجع قطعة قطعة',
    [...appById.entries()].sort(), [...refById.entries()].sort());
  eq('كل سجل استهلاك يحمل سعر بيع دفعته هو',
    sale.stockBatchesConsumed.every((c) => micro(c.sellingPrice) === (c.batchId === LOT_OLD ? micro(15) : micro(18))),
    true);
  eq('بقية الرف: 3 قطع من الجديدة', Number(lotNew(await appLots(P, VK)).quantity), 3);
  await booksAgree('دفعتا المخزون متفقتان', P, VK);
}

/* ================================================================== *
 * 3 · selling from the NEW lot (lotId), and from both
 * ================================================================== */

async function preferredLotSales() {
  section('3 · بيع من الدفعة الجديدة (lotId) ومن الاثنتين، ورفض معرّف دفعة غريب');

  await seedOldProduct();
  await db.restockProduct({
    productId: P, lines: [{ size: 'M', color: 'أسود', qty: 5 }], unitCost: 12, newPrice: 18,
  });
  const nl = lotNew(await appLots(P, VK));

  // (أ) بيع من الجديدة فقط
  const saleNew = await db.createSale({
    items: [{ productId: P, name: 'منتج الدفعات', size: 'M', color: 'أسود', qty: 2, price: 18, costPrice: 0, lotId: nl.id }],
    paymentMethod: 'cash',
  });
  eq('الجديدة أعطت القطعتين (بقيت 3)', Number(lotNew(await appLots(P, VK)).quantity), 3);
  eq('والقديمة لم تُمَس (10)', await appLotQty(LOT_OLD), 10);
  eq('تكلفة القطعتين الجديدتين 2×12 = 24', micro(saleNew.costTotal), micro(24));
  eq('وسجل الاستهلاك قطعتان من الدفعة الجديدة فقط', saleNew.stockBatchesConsumed.length, 1);
  eq('بسعر بيع الدفعة الجديدة (18)', micro(saleNew.stockBatchesConsumed[0].sellingPrice), micro(18));
  ok('سطر الفاتورة المخزّن يحمل شكله القديم تمامًا (بلا حقل lotId)', !('lotId' in saleNew.items[0]));

  // (ب) بيع 7 من الجديدة: تغطي 3 ثم يُكمل FIFO من القديمة
  const saleMix = await db.createSale({
    items: [{ productId: P, name: 'منتج الدفعات', size: 'M', color: 'أسود', qty: 7, price: 18, costPrice: 0, lotId: nl.id }],
    paymentMethod: 'cash',
  });
  eq('الجديدة نفدت (0)', Number(lotNew(await appLots(P, VK)).quantity), 0);
  eq('الناقص (4) أُخذ من القديمة (بقيت 6)', await appLotQty(LOT_OLD), 6);
  eq('التكلفة 3×12 + 4×10 = 76', micro(saleMix.costTotal), micro(76));
  const mixById = new Map(saleMix.stockBatchesConsumed.map((c) => [c.batchId, c.qty]));
  eq('السجلات: 3 من الجديدة و4 من القديمة',
    `${mixById.get(nl.id)}+${mixById.get(LOT_OLD)}`, '3+4');

  // (ج) معرّف دفعة لا يعود لهذا المنتج/المقاس = رفض نظيف لا يحرك شيئًا
  await db.put(db.STORES.products, {
    id: 'p-other', name: 'منتج آخر', sku: '', category: 'غير مصنف', description: '',
    price: 9, costPrice: 4, variants: [{ size: 'S', color: 'أحمر', quantity: 2 }],
    image: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  await db.put(db.STORES.stockBatches, {
    id: 'p-other::S|أحمر::x', productId: 'p-other', variantKey: 'S|أحمر', size: 'S', color: 'أحمر',
    quantity: 2, costPrice: 4, sellingPrice: 9, createdAt: '2026-01-01T00:00:02.000Z',
  });
  const before = await dump();
  let threw = false;
  try {
    await db.createSale({
      items: [{ productId: P, name: 'منتج الدفعات', size: 'M', color: 'أسود', qty: 1, price: 18, costPrice: 0, lotId: 'p-other::S|أحمر::x' }],
      paymentMethod: 'cash',
    });
  } catch {
    threw = true;
  }
  ok('دفعة من صنف آخر تُرفض', threw);
  ok('والرفض لم يحرك شيئًا على الإطلاق', (await dump()) === before);

  // (د) بيع أكثر مما في الرف كله يُرفض حتى مع دفعة مختارة
  let shortThrew = false;
  try {
    await db.createSale({
      items: [{ productId: P, name: 'منتج الدفعات', size: 'M', color: 'أسود', qty: 99, price: 18, costPrice: 0, lotId: LOT_OLD }],
      paymentMethod: 'cash',
    });
  } catch {
    shortThrew = true;
  }
  ok('بيع أكثر من المتاح يُرفض حتى مع دفعة محددة', shortThrew);
  ok('ولم يتغير شيء', (await dump()) === before);
  await booksAgree('دفعتا المخزون متفقتان', P, VK);
}

/* ================================================================== *
 * 4 · a full return puts every piece back into ITS OWN lot
 * ================================================================== */

async function fullReturnRestoresExactLots() {
  section('4 · مرتجع كامل يعيد الكميات إلى الدفعات الصحيحة نفسها');

  await seedOldProduct();
  await db.restockProduct({
    productId: P, lines: [{ size: 'M', color: 'أسود', qty: 5 }], unitCost: 12, newPrice: 18,
  });
  const nl = lotNew(await appLots(P, VK));

  const beforeMap = await lotMap(P, VK);
  const sale = await db.createSale({
    items: [{ productId: P, name: 'منتج الدفعات', size: 'M', color: 'أسود', qty: 6, price: 18, costPrice: 0, lotId: nl.id }],
    paymentMethod: 'cash',
  });
  eq('البيع أخذ 6 (الجديدة كلها + 2 قديمة)', sale.stockBatchesConsumed.reduce((t, c) => t + c.qty, 0), 6);
  const duringMap = await lotMap(P, VK);
  ok('خلال البيع خُفضت الدفعتان فعلاً', JSON.stringify(duringMap) !== JSON.stringify(beforeMap));

  await db.refundSale(sale.id);
  eq('بعد الإرجاع: خريطة الدفعات (كمية+تكلفة+سعر) مطابقة تمامًا لما قبل البيع',
    await lotMap(P, VK), beforeMap);
  await booksAgree('دفعتا المخزون متفقتان بعد الإرجاع', P, VK);

  // مرتجع كامل لبيع FIFO خالص (بلا دفعة مختارة) — نفس الضمانة
  const sale2 = await db.createSale({
    items: [{ productId: P, name: 'منتج الدفعات', size: 'M', color: 'أسود', qty: 4, price: 18, costPrice: 0 }],
    paymentMethod: 'cash',
  });
  await db.refundSale(sale2.id);
  eq('مرتجع بيع FIFO يعيد الدفعات كما كانت أيضًا', await lotMap(P, VK), beforeMap);
}

/* ================================================================== *
 * 5 · editing an invoice recomputes FIFO as before
 * ================================================================== */

async function editInvoice() {
  section('5 · تعديل فاتورة يعيد الحساب FIFO كما هو (سواء اختيرت دفعة أم لا)');

  await seedOldProduct();
  await db.restockProduct({
    productId: P, lines: [{ size: 'M', color: 'أسود', qty: 5 }], unitCost: 12, newPrice: 18,
  });
  const nl = lotNew(await appLots(P, VK));

  const sale = await db.createSale({
    items: [{ productId: P, name: 'منتج الدفعات', size: 'M', color: 'أسود', qty: 2, price: 18, costPrice: 0, lotId: nl.id }],
    paymentMethod: 'cash',
  });
  eq('قبل التعديل: الجديدة 3، القديمة 10', [Number(lotNew(await appLots(P, VK)).quantity), await appLotQty(LOT_OLD)], [3, 10]);

  const up = await db.updateSale(sale.id, {
    items: [{ productId: P, name: 'منتج الدفعات', size: 'M', color: 'أسود', qty: 4, price: 18, costPrice: 0 }],
  });
  // المرجع: أعد ما أخذته (3 من الجديدة تصير 5)، ثم خذ 4 FIFO (الأقدم أولًا: 4 من القديمة).
  eq('بعد الترقية: القديمة 6 والجديدة 5', [await appLotQty(LOT_OLD), Number(lotNew(await appLots(P, VK)).quantity)], [6, 5]);
  eq('التكلفة أعيد حسابها FIFO: 4×10 = 40', micro(up.costTotal), micro(40));
  const byId = new Map(up.stockBatchesConsumed.map((c) => [c.batchId, c.qty]));
  eq('السجلات الجديدة تغطي 4 من القديمة', byId.get(LOT_OLD), 4);
  await booksAgree('دفعتا المخزون متفقتان بعد التعديل', P, VK);
}

/* ================================================================== *
 * 6 · basket reservation (cart-store) — numbers move with every change
 * ================================================================== */

async function cartReservation() {
  section('6 · حجز السلة: المتاح = المخزون − ما في السلة، وما زاد يُرفض');

  reseed(SEED + 1);
  await resetDb();
  await db.put(db.STORES.products, {
    id: 'p-cart', name: 'منتج السلة', sku: '', category: 'غير مصنف', description: '',
    price: 10, costPrice: 5,
    variants: [
      { size: 'M', color: 'أحمر', quantity: 5 },
      { size: 'M', color: 'أزرق', quantity: 3 },
    ],
    image: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });

  const cartStore = await import(js('cart-store.js'));
  cartStore.clearCart();

  const line = (color, max, key) => ({
    key: key || `p-cart|M|${color}`,
    productId: 'p-cart', name: 'منتج السلة', size: 'M', color,
    qty: 1, price: 10, costPrice: 5, max,
  });

  eq('addLine الأولى تُضاف', cartStore.addLine(line('أحمر', 5)), 'added');
  eq('inCartQty يرى القطعة', cartStore.inCartQty('p-cart', 'M|أحمر'), 1);
  eq('المتاح مع السلة 4', await cartStore.availableWithCart('p-cart', 'M|أحمر'), 4);

  cartStore.setQty('p-cart|M|أحمر', 5); // سقف السطر هو رف الدفعة كله (5)
  eq('رفع الكمية إلى سقف الرف مسموح', cartStore.cart.find((l) => l.key === 'p-cart|M|أحمر').qty, 5);
  eq('المتاح مع السلة صار 0', await cartStore.availableWithCart('p-cart', 'M|أحمر'), 0);
  eq('إضافة قطعة سادسة تُرفض (full)', cartStore.addLine(line('أحمر', 5)), 'full');
  eq('والسلة ما زالت 5', cartStore.inCartQty('p-cart', 'M|أحمر'), 5);

  cartStore.removeLine('p-cart|M|أحمر');
  eq('بعد الحذف يعود المتاح 5 فورًا', await cartStore.availableWithCart('p-cart', 'M|أحمر'), 5);
  eq('و inCartQty صفر', cartStore.inCartQty('p-cart', 'M|أحمر'), 0);

  // المقاس/اللون الآخر لا يتأثر بحجز أخيه
  eq('اللون الآخر يُضاف', cartStore.addLine(line('أزرق', 3)), 'added');
  eq('حجز الأحمر لا يخصم من الأزرق', await cartStore.availableWithCart('p-cart', 'M|أزرق'), 2);
  eq('وحجز الأزرق لا يخصم من الأحمر', await cartStore.availableWithCart('p-cart', 'M|أحمر'), 5);

  // المنتج نفسه بمفتاح مختلف (نفس الصنف) يُحسب في inCartQty حسب مفتاح المقاس
  eq('إضافة بلون آخر مرة أخرى', cartStore.addLine(line('أزرق', 3)), 'bumped');
  eq('inCartQty جمع سطري الأزرق', cartStore.inCartQty('p-cart', 'M|أزرق'), 2);

  // سقف 0 لا يولّد سطرًا وهميًا أبدًا
  eq('addLine بنافد (max 0) يُرفض', cartStore.addLine({ key: 'x', productId: 'p-none', name: 'x', size: '', color: '', qty: 1, price: 1, costPrice: 0, max: 0 }), 'full');
  eq('ولم يُخزَّن سطر بلا كمية', cartStore.cart.some((l) => l.key === 'x'), false);

  cartStore.clearCart();
  eq('سلة فارغة: المتاح يعود كاملًا', await cartStore.availableWithCart('p-cart', 'M|أحمر'), 5);
}

/* ================================================================== *
 * 7 · export → import preserves the lots and the consumed records
 * ================================================================== */

async function roundTripLots() {
  section('7 · تصدير واستيراد يحافظ على الدفعات وسجلات الاستهلاك كما هي');

  await seedOldProduct();
  await db.restockProduct({
    productId: P, lines: [{ size: 'M', color: 'أسود', qty: 5 }], unitCost: 12, newPrice: 18,
  });
  const nl = lotNew(await appLots(P, VK));
  await db.createSale({
    items: [{ productId: P, name: 'منتج الدفعات', size: 'M', color: 'أسود', qty: 6, price: 18, costPrice: 0, lotId: nl.id }],
    paymentMethod: 'cash',
  });

  const before = await db.exportAll();
  await resetDb();
  await db.importAll(before);
  const after = db.validateBackup(before) === null ? await db.exportAll() : null;

  eq('عدد الدفعات كما هو', after.stockBatches.length, before.stockBatches.length);
  eq('الدفعات (كمية/تكلفة/سعر بيع) طالت رحلتها بلا تغيير',
    after.stockBatches.map((b) => [b.id, b.quantity, b.costPrice, b.sellingPrice]).sort(),
    before.stockBatches.map((b) => [b.id, b.quantity, b.costPrice, b.sellingPrice]).sort());
  eq('سجلات استهلاك الفاتورة طالت رحلتها بلا تغيير',
    after.sales.map((s) => s.stockBatchesConsumed),
    before.sales.map((s) => s.stockBatchesConsumed));
  eq('وتكلفة الفاتورة كما هي', after.sales.map((s) => micro(s.costTotal)), before.sales.map((s) => micro(s.costTotal)));
  eq('وكمية المتغير كما هي',
    after.products.map((p) => p.variants.map((v) => v.quantity)),
    before.products.map((p) => p.variants.map((v) => v.quantity)));
}

/* ================================================================== *
 * 8 · fault injection — a chosen-lot sale that fails mid-write
 * ================================================================== */

async function faultChosenLot() {
  section('8 · بيع دفعة محددة فاشل يتراجع كليًا (حقن فشل)');

  await seedOldProduct();
  await db.restockProduct({
    productId: P, lines: [{ size: 'M', color: 'أسود', qty: 5 }], unitCost: 12, newPrice: 18,
  });
  const nl = lotNew(await appLots(P, VK));

  // 6 قطع من الجديدة: 5 منها ثم يكمل FIFO من القديمة — كتابة الدفعة الثانية تفشل.
  const before = await dump();
  injectWrite('stockBatches', { nth: 2 });
  let threw = false;
  try {
    await db.createSale({
      id: 's-fault',
      items: [{ productId: P, name: 'منتج الدفعات', size: 'M', color: 'أسود', qty: 6, price: 18, costPrice: 0, lotId: nl.id }],
      paymentMethod: 'cash',
    });
  } catch {
    threw = true;
  } finally {
    clearFaults();
  }
  const after = await dump();

  ok('البيع مُنكر', threw);
  ok('ولا فاتورة بلا حركة مخزون', (await db.listSales()).length === 0);
  ok('قاعدة البيانات حرفيًا كما كانت', before === after);

  // وفشل القراءة قبل أي استهلاك يتراجع كذلك
  const before2 = await dump();
  fakeIdb.faults.read = (s) => (s === 'stockBatches' ? new Error('injected read failure') : null);
  let readThrew = false;
  try {
    await db.createSale({
      id: 's-fault2',
      items: [{ productId: P, name: 'منتج الدفعات', size: 'M', color: 'أسود', qty: 1, price: 18, costPrice: 0, lotId: LOT_OLD }],
      paymentMethod: 'cash',
    });
  } catch {
    readThrew = true;
  } finally {
    clearFaults();
  }
  ok('فشل القراءة قبل الاستهلاك يُنكر البيع', readThrew);
  ok('وقاعدة البيانات سليمة', (await dump()) === before2);
}

/* ================================================================== *
 * 9 · fixed-seed random campaign (seed 20261017)
 *
 * Restocks at varying prices, FIFO sales, chosen-lot sales, full returns,
 * edits and injected failures — and after EVERY step the app's lots are
 * compared with the reference PER LOT ID, plus the total lot value.
 * ================================================================== */

async function lotsCampaign() {
  section(`9 · حملة عشوائية ببذرة ثابتة ${SEED} (توريد بأسعار مختلفة، بيع، مرتجع، تعديل، فشل)`);

  reseed(SEED);
  await resetDb();

  // منتجان × صنفان، كل صنف بثلاث دفعات أولية بأسعار مختلفة عمدًا.
  const spec = [];
  const book = new FifoBook();
  const priceByPid = new Map(); // سعر المنتج على مستوى المنتج (يستخدمه التوريد بلا سعر جديد)
  let lotClock = 0;
  for (let i = 0; i < 2; i++) {
    const pid = `cp${i}`;
    const variants = [];
    for (let j = 0; j < 2; j++) {
      const size = `S${i}${j}`;
      const color = `C${j}`;
      const vk = `${size}|${color}`;
      let price = randInt(1500, 6000) / 100;
      for (let k = 0; k < 3; k++) {
        const qty = randInt(2, 14);
        const cost = randInt(500, 20000) / 1000; // three decimals, like the shop types
        const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, ++lotClock)).toISOString();
        const id = `${pid}::${vk}::${k}`;
        await db.put(db.STORES.stockBatches, {
          id, productId: pid, variantKey: vk, size, color,
          quantity: qty, costPrice: cost, sellingPrice: price, createdAt,
        });
        book.add(pid, vk, { id, qty, costMicro: micro(cost), sellMicro: micro(price), createdAt });
      }
      const lotsOfVk = (book.lots.get(book.key(pid, vk)) || []).reduce((t, l) => t + l.qty, 0);
      variants.push({ size, color, quantity: lotsOfVk });
      spec.push({ pid, size, color, vk, price });
    }
    await db.put(db.STORES.products, {
      id: pid, name: `منتج ${i}`, sku: '', category: 'غير مصنف', description: '',
      price: 30, costPrice: 5, variants, image: '',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    priceByPid.set(pid, 30);
  }

  const liveSales = []; // { id, pid, vk, taken: Array<{id, qty, costMicro, sellMicro}> }
  let saleSeq = 0;
  let mismatches = 0;
  let opsRun = 0;
  let preferredRun = 0;
  let faultsRun = 0;

  async function appValueMicro() {
    const batches = await db.listStockBatches();
    return batches.reduce((t, b) => t + BigInt(Number(b.quantity) || 0) * micro(b.costPrice), 0n);
  }

  /** Per-lot-id comparison — stronger than per-variant totals. */
  async function checkAgainstReference(label) {
    const batches = await db.listStockBatches();
    let bad = 0;
    for (const s of spec) {
      const appById = new Map(
        batches
          .filter((b) => b.productId === s.pid && b.variantKey === s.vk)
          .map((b) => [b.id, Number(b.quantity) || 0])
      );
      const refById = new Map(book.snapshot(s.pid, s.vk).map((l) => [l.id, l.qty]));
      if (appById.size !== refById.size) bad += 1;
      else {
        for (const [id, q] of refById) {
          if ((appById.get(id) || 0) !== q) { bad += 1; break; }
        }
      }
    }
    if (bad) { mismatches += bad; ok(label, false, `${bad} variant(s) differ from the reference per lot id`); }
    else passed++;
  }

  const STEPS = 160;
  for (let step = 0; step < STEPS; step++) {
    const s = spec[randInt(0, spec.length - 1)];
    const roll = rng();

    if (roll < 0.30) {
      // ── توريد بأسعار مختلفة (أحيانًا بسعر بيع جديد) ──────────────────
      const qty = randInt(1, 15);
      const unitCost = randInt(500, 20000) / 1000;
      const newPrice = rng() < 0.4 ? randInt(1000, 8000) / 100 : null;
      const idsBefore = new Set((await db.listStockBatches()).map((b) => b.id));
      const before = await dump();
      let rec = null;
      let appErr = null;
      try {
        rec = (await db.restockProduct({
          productId: s.pid, lines: [{ size: s.size, color: s.color, qty }], unitCost, newPrice,
        })).record;
      } catch (err) {
        appErr = err;
      }
      if (appErr) {
        ok('refused restock changes nothing', (await dump()) === before, appErr.message);
      } else {
        const refTotal = Number(centsToMicro(toCents(micro(unitCost) * BigInt(qty)))) / 1000000;
        if (Math.abs(Number(rec.total) - refTotal) < 1e-9) passed++;
        else { mismatches++; ok('restock total exact', false, `expected ${refTotal}, got ${rec.total}`); }
        // اكتشاف الدفعة الجديدة ومزامنة المرجع بها (بنفس المعرف والتاريخ).
        const fresh = (await db.listStockBatches()).filter((b) => !idsBefore.has(b.id));
        if (fresh.length !== 1) { mismatches++; ok('restock filed exactly one lot', false, `got ${fresh.length}`); }
        else {
          const lot = fresh[0];
          if (Number(lot.quantity) === qty && micro(lot.costPrice) === micro(unitCost)) passed++;
          else { mismatches++; ok('the new lot holds the landed pieces at the landed cost', false, JSON.stringify(lot)); }
          const effSell = newPrice !== null ? newPrice : priceByPid.get(s.pid);
          if (micro(lot.sellingPrice) === micro(effSell)) passed++;
          else { mismatches++; ok('the new lot carries the effective selling price', false, `${lot.sellingPrice} vs ${effSell}`); }
          if (newPrice !== null) {
            const p = await db.get(db.STORES.products, s.pid);
            if (micro(p.price) === micro(newPrice)) passed++;
            else { mismatches++; ok('the product shows the last price', false, `${p.price} vs ${newPrice}`); }
            priceByPid.set(s.pid, newPrice);
          }
          book.add(s.pid, s.vk, { id: lot.id, qty, costMicro: micro(unitCost), sellMicro: micro(effSell), createdAt: lot.createdAt });
        }
      }
      opsRun++;
    } else if (roll < 0.58) {
      // ── بيع: أحيانًا FIFO، وأحيانًا من دفعة محددة ─────────────────────
      const have = book.available(s.pid, s.vk);
      const qty = randInt(1, Math.max(1, have + 2));
      const positives = book.ordered(s.pid, s.vk);
      const prefer = positives.length && rng() < 0.5 ? positives[randInt(0, positives.length - 1)].id : null;
      const id = `ls-${++saleSeq}`;
      let refTaken = null;
      try {
        refTaken = prefer
          ? book.consume(s.pid, s.vk, qty, prefer)
          : book.consume(s.pid, s.vk, qty);
      } catch {
        refTaken = null;
      }
      let appSale = null;
      let appErr = null;
      try {
        appSale = await db.createSale({
          id,
          items: [{ productId: s.pid, name: 'x', size: s.size, color: s.color, qty, price: 50, costPrice: 0, ...(prefer ? { lotId: prefer } : {}) }],
          paymentMethod: 'cash',
        });
      } catch (err) {
        appErr = err;
      }
      if (refTaken) {
        if (appErr || !appSale) {
          book.restore(refTaken);
          mismatches++;
          ok('sale reference/state agree', false, `expected success: ${appErr && appErr.message}`);
        } else {
          const refCost = refSaleCost(refTaken);
          if (micro(appSale.costTotal) === refCost) passed++;
          else { mismatches++; ok('sale cost matches reference', false, `expected ${refCost}, got ${micro(appSale.costTotal)}`); }
          // سجلات الاستهلاك: نفس الدفعات، نفس الكميات، وسعر بيع كل دفعة هو دفعتها.
          const refById = new Map(refTaken.map((c) => [c.id, c.qty]));
          const appRecs = appSale.stockBatchesConsumed || [];
          const appById = new Map(appRecs.map((c) => [c.batchId, c.qty]));
          let recsOk = refById.size === appById.size;
          for (const [bid, q] of refById) {
            if (appById.get(bid) !== q) recsOk = false;
            const rec = appRecs.find((c) => c.batchId === bid);
            const lot = (book.lots.get(book.key(s.pid, s.vk)) || []).find((l) => l.id === bid);
            if (!rec || !lot || micro(rec.sellingPrice) !== lot.sellMicro) recsOk = false;
          }
          if (recsOk) passed++;
          else { mismatches++; ok('consumed records match the reference (qty + selling price per lot)', false); }
          liveSales.push({ id, pid: s.pid, vk: s.vk, size: s.size, color: s.color, taken: refTaken });
          if (prefer) preferredRun++;
        }
      } else {
        if (!appErr) { mismatches++; ok('an impossible sale is refused', false, 'the app accepted it'); }
        else passed++;
      }
      opsRun++;
    } else if (roll < 0.72 && liveSales.length) {
      // ── مرتجع كامل: يعيد كل قطعة إلى دفعتها ──────────────────────────
      const idx = randInt(0, liveSales.length - 1);
      const sale = liveSales.splice(idx, 1)[0];
      // قبل الإرجاع: خريطة التطبيق لكل دفعة. بعد الإرجاع يجب أن تساوي
      // الخريطة نفسها + ما أعادته الفاتورة (نفس الدفعة قطعة قطعة)،
      // وأن تطابق المرجع الذي أعاد نفس الدفعات.
      const appBefore = new Map(
        (await db.listStockBatches())
          .filter((b) => b.productId === sale.pid && b.variantKey === sale.vk)
          .map((b) => [b.id, Number(b.quantity) || 0])
      );
      book.restore(sale.taken.map((c) => ({ ...c })));
      await db.refundSale(sale.id);
      const expected = new Map(appBefore);
      for (const c of sale.taken) expected.set(c.id, (expected.get(c.id) || 0) + c.qty);
      const afterMap = new Map(
        (await db.listStockBatches())
          .filter((b) => b.productId === sale.pid && b.variantKey === sale.vk)
          .map((b) => [b.id, Number(b.quantity) || 0])
      );
      const refAfter = new Map(book.snapshot(sale.pid, sale.vk).map((l) => [l.id, l.qty]));
      let refundOk = afterMap.size === expected.size && afterMap.size === refAfter.size;
      if (refundOk) {
        for (const [id, q] of expected) {
          if (afterMap.get(id) !== q || refAfter.get(id) !== q) { refundOk = false; break; }
        }
      }
      if (refundOk) {
        passed++;
      } else {
        mismatches++;
        ok('refund restores per-lot exactly (back to the pre-sale map)', false,
          `app=${JSON.stringify([...afterMap])} expected=${JSON.stringify([...expected])} ref=${JSON.stringify([...refAfter])}`);
      }
      opsRun++;
    } else if (roll < 0.86 && liveSales.length) {
      // ── تعديل فاتورة: أعد ما أخذته ثم خذ الجديد FIFO ─────────────────
      const idx = randInt(0, liveSales.length - 1);
      const sale = liveSales[idx];
      const before = await dump();
      const totalTaken = sale.taken.reduce((t, c) => t + c.qty, 0);
      const newQty = randInt(1, book.available(sale.pid, sale.vk) + totalTaken);
      const lotsFor = () => book.lots.get(book.key(sale.pid, sale.vk)) || [];
      for (const c of sale.taken) {
        const lot = lotsFor().find((l) => l.id === c.id);
        if (lot) lot.qty += c.qty;
      }
      let refTaken = null;
      try {
        refTaken = book.consume(sale.pid, sale.vk, newQty);
      } catch {
        for (const c of sale.taken) {
          const lot = lotsFor().find((l) => l.id === c.id);
          if (lot) lot.qty -= c.qty;
        }
        refTaken = null;
      }
      let appErr = null;
      let appSale = null;
      try {
        appSale = await db.updateSale(sale.id, {
          items: [{ productId: sale.pid, name: 'x', size: sale.size, color: sale.color, qty: newQty, price: 50, costPrice: 0 }],
        });
      } catch (err) {
        appErr = err;
      }
      if (refTaken) {
        if (appErr) { mismatches++; ok('edit reference/state agree', false, appErr.message); }
        else {
          const refCost = refSaleCost(refTaken);
          if (micro(appSale.costTotal) === refCost) passed++;
          else { mismatches++; ok('edit cost matches reference', false, `expected ${refCost}, got ${micro(appSale.costTotal)}`); }
          sale.taken = refTaken;
        }
      } else {
        const after = await dump();
        if (appErr && before === after) passed++;
        else { mismatches++; ok('refused edit changes nothing', false, appErr ? '' : 'no error'); }
      }
      opsRun++;
    } else {
      // ── فشل محقون على بيع (أحيانًا بدفعة محددة) ──────────────────────
      const before = await dump();
      const prefer = rng() < 0.5;
      const positives = book.ordered(s.pid, s.vk);
      const lotId = prefer && positives.length ? positives[positives.length - 1].id : null;
      const which = randInt(0, 2);
      if (which === 0) injectWrite('sales');
      else if (which === 1) injectWrite('stockBatches', { nth: 2 });
      else injectWrite('products');
      let threw = false;
      try {
        await db.createSale({
          id: `lf-${step}`,
          items: [{ productId: s.pid, name: 'x', size: s.size, color: s.color, qty: 1, price: 50, costPrice: 0, ...(lotId ? { lotId } : {}) }],
          paymentMethod: 'cash',
        });
      } catch {
        threw = true;
      } finally {
        clearFaults();
      }
      const after = await dump();
      faultsRun++;
      if (threw && before === after) passed++;
      else { mismatches++; ok('injected failure leaves no trace', false, `threw=${threw}`); }
      opsRun++;
    }

    // بعد كل خطوة: الدفعات مطابقة للمرجع معرفًا بمعرف.
    await checkAgainstReference(`step ${step}: lots match the reference per id`);
  }

  // القيمة الإجمالية للمخزون تطابق المرجع، والكتب متفقان.
  let valueOk = true;
  for (const s of spec) {
    const batches = await db.listStockBatches();
    const appV = batches
      .filter((b) => b.productId === s.pid && b.variantKey === s.vk)
      .reduce((t, b) => t + BigInt(Number(b.quantity) || 0) * micro(b.costPrice), 0n);
    const refV = book.snapshot(s.pid, s.vk).reduce((t, l) => t + BigInt(l.qty) * l.costMicro, 0n);
    if (appV !== refV) valueOk = false;
  }
  ok('lot VALUES match the reference at the end', valueOk);
  await checkAgainstReference('final: lots match the reference per id');
  ok('the campaign exercised a meaningful number of operations', opsRun >= STEPS);
  ok('the campaign sold from chosen lots', preferredRun > 0);
  ok('the campaign injected real failures', faultsRun > 0);

  globalThis.__lots = { opsRun, preferredRun, faultsRun, seed: SEED };
}

/* ================================================================== *
 * Run
 * ================================================================== */

console.log('Store Hub — price lots (دفعات المخزون)');
console.log(`lots campaign seed ${SEED} (fixed: the same cases every run)`);

await restockExample();
await fifoOldestSale();
await preferredLotSales();
await fullReturnRestoresExactLots();
await editInvoice();
await cartReservation();
await roundTripLots();
await faultChosenLot();
await lotsCampaign();

console.log(`   (${passed - _sectionStart} passed, ${failed - _sectionFailed} failed)`);
console.log('\n========================================================');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('========================================================');
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log(JSON.stringify(globalThis.__lots || {}));
process.exit(failed ? 1 : 0);
