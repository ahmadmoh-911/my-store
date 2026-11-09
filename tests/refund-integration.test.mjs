/**
 * اختبار مستقل لسلوك المرتجعات — قيم صريحة لا تُستخرج من الدوال المختبرة.
 *
 * السيناريو:
 *   منتج به 5 قطع بسعر 100، تكلفة 40 للقطعة (via فواتير FIFO).
 *   بيع 5 قطع → total 500، costTotal 200، الربح 300، المخزون 15.
 *
 * اختبار A — مرتجع كامل:
 *   مبلغ 500، تكلفة مستعادة 200، صافي المبيعات 0، صافي الربح 0، المخزون 20.
 *
 * اختبار B — مرتجع جزئي مستقل لثلاث قطع (من بيع آخر):
 *   مبلغ 300، تكلفة مستعادة 120، صافي المبيعات 200، صافي التكلفة 80، صافي الربح 120، المخزون 18.
 *
 * يُشغل node مباشرة على fake-indexeddb مثل مجموعات الاختبار الحالية.
 */

import { createFakeIndexedDB } from './fake-indexeddb.mjs';
import { micro } from './reference-accounting.mjs';

const fakeIdb = createFakeIndexedDB();
globalThis.indexedDB = fakeIdb;

const db = await import('../js/db.js');
const analytics = await import('../js/analytics.js');

const DAY = 86400000;
const base = Date.parse('2026-11-01T10:00:00.000Z');

async function reset() {
  for (const name of Object.values(db.STORES)) await db.clearStore(name);
}

async function seedProduct() {
  // Product with stock: 5 pieces, cost 40, price 100 — via initial variant quantity.
  await db.saveProduct({
    id: 'p-refund-test',
    name: 'منتج اختبار الاسترجاع',
    price: 100,
    costPrice: 40,
    variants: [{ size: 'M', color: 'أحمر', quantity: 20 }],
    createdAt: new Date(base).toISOString(),
  });
  // Create initial stock batches so FIFO has lots at cost 40.
  await db.createInitialStockBatches(await db.get(db.STORES.products, 'p-refund-test'));
}

async function makeSale(id, qty, ts) {
  return db.createSale({
    id,
    items: [{ productId: 'p-refund-test', name: 'منتج اختبار الاسترجاع', size: 'M', color: 'أحمر', qty, price: 100, costPrice: 40 }],
    paymentMethod: 'cash',
    timestamp: ts || new Date(base + DAY).toISOString(),
  });
}

function variantQty(pid, size, color) {
  return db.get(db.STORES.products, pid).then((p) => {
    const v = p.variants.find((x) => x.size === size && x.color === color);
    return Number(v?.quantity || 0);
  });
}

function batchQty(productId, variantKey) {
  return db.listStockBatches().then((bs) => bs.filter((b) => b.productId === productId && b.variantKey === variantKey));
}

/* ===================================================================== *
 *  TEST A — Full refund
 * ===================================================================== */

{
  await reset();
  await seedProduct();

  const beforeQty = await variantQty('p-refund-test', 'M', 'أحمر');
  console.log(`[A] المخزون قبل البيع: ${beforeQty}`);

  const sale = await makeSale('s-refund-full', 5);
  console.log(`[A] البيع: total=${sale.total}, costTotal=${sale.costTotal}, items=${sale.items.length}`);
  console.log(`[A] stockBatchesConsumed:`, JSON.stringify(sale.stockBatchesConsumed));

  const afterSaleQty = await variantQty('p-refund-test', 'M', 'أحمر');
  console.log(`[A] المخزون بعد البيع: ${afterSaleQty}`);

  const { refund, sale: refundedSale } = await db.refundSale(sale.id, {
    idempotencyKey: `refund-${sale.id}-full-1`,
  });

  console.log(`[A] سجل المرتجع: id=${refund.id}, totalRefunded=${refund.totalRefunded}, costTotalRefunded=${refund.costTotalRefunded}, items=${refund.items.length}`);
  console.log(`[A] الفاتورة الأصلية ما زالت موجودة: id=${refundedSale.id}, total=${refundedSale.total}`);

  const afterRefundQty = await variantQty('p-refund-test', 'M', 'أحمر');
  console.log(`[A] المخزون بعد الاسترجاع الكامل: ${afterRefundQty}`);

  const allSales = await db.listSales();
  const allRefunds = await db.listRefunds();
  const rev = analytics.revenue(allSales);
  const refTotal = analytics.refundsTotal(allRefunds);
  const prof = analytics.profit(allSales);
  const refCost = analytics.refundsCostTotal(allRefunds);

  console.log(`[A] تقرير: revenue=${rev}, refundsTotal=${refTotal}, netRevenue=${rev - refTotal}, profit=${prof}, refundedCost=${refCost}, netProfit=${prof - (refTotal - refCost)}`);

  // Explicit assertions with hard-coded expected values.
  const failures = [];
  function check(label, actual, expected) {
    const ok = Number(actual) === Number(expected);
    if (!ok) failures.push(`${label}: expected ${expected}, got ${actual}`);
    console.log(`${ok ? '✅' : '❌'} ${label}: actual=${actual}, expected=${expected}`);
  }

  check('الفاتورة الأصلية ما زالت موجودة', allSales.length, 1);
  check('سجل المرتجع موجود', allRefunds.length, 1);
  check('مبلغ المرتجع الكامل', refund.totalRefunded, 500);
  check('تكلفة المرتجع الكاملة', refund.costTotalRefunded, 200);
  check('المخزون بعد البيع', afterSaleQty, 15);
  check('المخزون بعد الاسترجاع الكامل', afterRefundQty, 20);
  check('صافي المبيعات ( full )', rev - refTotal, 0);
  check('صافي الربح ( full )', prof - (refTotal - refCost), 0);

  if (failures.length) {
    console.log(`\n[A] ❌ ${failures.length} فشلاً:`);
    for (const f of failures) console.log(`   - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`\n[A] ✅ جميع التحققات ناجحة`);
  }
}

/* ===================================================================== *
 *  TEST B — Independent partial refund of 3 pieces
 * ===================================================================== */

{
  await reset();
  await seedProduct();

  const sale = await makeSale('s-refund-partial', 5);
  const beforeQty = await variantQty('p-refund-test', 'M', 'أحمر');
  console.log(`[B] المخزون بعد البيع: ${beforeQty}`);

  const { refund } = await db.refundSale(sale.id, {
    items: [{ productId: 'p-refund-test', size: 'M', color: 'أحمر', qty: 3 }],
    idempotencyKey: `refund-${sale.id}-partial-1`,
  });

  console.log(`[B] سجل المرتجع الجزئي: totalRefunded=${refund.totalRefunded}, costTotalRefunded=${refund.costTotalRefunded}, items=${refund.items.length}`);
  console.log(`[B] أصناف المرتجع:`, JSON.stringify(refund.items));

  const afterQty = await variantQty('p-refund-test', 'M', 'أحمر');
  console.log(`[B] المخزون بعد الاسترجاع الجزئي: ${afterQty}`);

  const allSales = await db.listSales();
  const allRefunds = await db.listRefunds();
  const rev = analytics.revenue(allSales);
  const refTotal = analytics.refundsTotal(allRefunds);
  const prof = analytics.profit(allSales);
  const refCost = analytics.refundsCostTotal(allRefunds);

  console.log(`[B] تقرير: revenue=${rev}, refundsTotal=${refTotal}, netRevenue=${rev - refTotal}, profit=${prof}, refundedCost=${refCost}, netProfit=${prof - (refTotal - refCost)}`);

  const failures = [];
  function check(label, actual, expected) {
    const ok = Number(actual) === Number(expected);
    if (!ok) failures.push(`${label}: expected ${expected}, got ${actual}`);
    console.log(`${ok ? '✅' : '❌'} ${label}: actual=${actual}, expected=${expected}`);
  }

  check('الفاتورة الأصلية ما زالت موجودة', allSales.length, 1);
  check('سجل المرتجع موجود', allRefunds.length, 1);
  check('مبلغ المرتجع الجزئي (3 × 100)', refund.totalRefunded, 300);
  check('تكلفة المرتجع الجزئي (3 × 40)', refund.costTotalRefunded, 120);
  check('المخزون بعد البيع (20 - 5)', beforeQty, 15);
  check('المخزون بعد الاسترجاع الجزئي (15 + 3)', afterQty, 18);
  check('صافي المبيعات (500 - 300)', rev - refTotal, 200);
  check('صافي الربح (300 - (300 - 120))', prof - (refTotal - refCost), 120);

  if (failures.length) {
    console.log(`\n[B] ❌ ${failures.length} فشلاً:`);
    for (const f of failures) console.log(`   - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`\n[B] ✅ جميع التحققات ناجحة`);
  }
}

console.log('\nانتهت اختبارات الاسترجاع المستقلة.');
