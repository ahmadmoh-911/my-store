/**
 * اختبار FIFO للمرتجع بتكاليف مختلفة.
 *
 * scénario:
 *   دفعة 1 (الأقدم): 3 قطع بتكلفة 40، سعر بيع 100
 *   دفعة 2 (الأحدث): 3 قطع بتكلفة 60، سعر بيع 110
 *   المتغير: 6 قطع (المخزون الفعلي)
 *   بيع 4 قطع → يأخذ 3 من الدفعة 1 (cost 40) + 1 من الدفعة 2 (cost 60)
 *   costTotal = 3×40 + 1×60 = 180
 *   إجمالي البيع = 3×100 + 1×110 = 410
 *   مرتجع 2 قطع من الدفعة 2 (السعر 110، التكلفة 60) → المبلغ 220، التكلفة 120
 *   المخزون: البداية 6 → بعد البيع 2 → بعد الإرجاع 4
 */

import { createFakeIndexedDB } from './fake-indexeddb.mjs';
import { micro } from './reference-accounting.mjs';

const fakeIdb = createFakeIndexedDB();
globalThis.indexedDB = fakeIdb;

const db = await import('../js/db.js');
const analytics = await import('../js/analytics.js');

const base = Date.parse('2026-11-01T10:00:00.000Z');

async function reset() {
  for (const name of Object.values(db.STORES)) await db.clearStore(name);
}

async function seedFifoProduct() {
  // Product with quantity 6 in variant (no auto batches via saveProduct with qty 0)
  await db.saveProduct({
    id: 'p-fifo-refund',
    name: 'منتج FIFO اختبار',
    price: 100,
    costPrice: 50,
    variants: [{ size: 'M', color: 'أحمر', quantity: 6 }],
    createdAt: new Date(base).toISOString(),
  });
  const product = await db.get(db.STORES.products, 'p-fifo-refund');

  // Manually insert two batches with controlled dates into stockBatches
  const now = new Date(base).toISOString();
  await db.put(db.STORES.stockBatches, {
    id: 'batch-fifo-1',
    productId: product.id,
    variantKey: 'M|أحمر',
    size: 'M',
    color: 'أحمر',
    quantity: 3,
    costPrice: 40,
    sellingPrice: 100,
    createdAt: new Date(base - 2 * 86400000).toISOString(), // oldest (2 days ago)
  });
  await db.put(db.STORES.stockBatches, {
    id: 'batch-fifo-2',
    productId: product.id,
    variantKey: 'M|أحمر',
    size: 'M',
    color: 'أحمر',
    quantity: 3,
    costPrice: 60,
    sellingPrice: 110,
    createdAt: new Date(base - 1 * 86400000).toISOString(), // newer (1 day ago)
  });
}

async function variantQty(pid, size, color) {
  return db.get(db.STORES.products, pid).then((p) => {
    const v = p.variants.find((x) => x.size === size && x.color === color);
    return Number(v?.quantity || 0);
  });
}

async function batchDetails(productId, variantKey) {
  return db.listStockBatches().then((bs) =>
    bs.filter((b) => b.productId === productId && b.variantKey === variantKey).sort(
      (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
    )
  );
}

console.log('=== اختبار FIFO للمرتجع بتكاليف مختلفة ===\n');

await reset();
await seedFifoProduct();

const batchesBefore = await batchDetails('p-fifo-refund', 'M|أحمر');
console.log('الدفعات قبل البيع:');
for (const b of batchesBefore) {
  console.log(`  ${b.id} qty=${b.quantity} cost=${b.costPrice} sell=${b.sellingPrice} date=${b.createdAt}`);
}

const beforeQty = await variantQty('p-fifo-refund', 'M', 'أحمر');
console.log(`\nالمخزون قبل البيع: ${beforeQty}`);

// Sell 4: 3 from batch 1 (cost 40, sell 100) + 1 from batch 2 (cost 60, sell 110)
const sale = await db.createSale({
  id: 's-fifo-refund',
  items: [{ productId: 'p-fifo-refund', name: 'منتج FIFO اختبار', size: 'M', color: 'أحمر', qty: 4, price: 100, costPrice: 50 }],
  paymentMethod: 'cash',
  timestamp: new Date(base).toISOString(),
});

console.log(`\nالبيع: total=${sale.total}, costTotal=${sale.costTotal}`);
console.log('الأصناف المخزنة:');
for (const it of sale.items) {
  console.log(`  qty=${it.qty} price=${it.price} costPrice=${it.costPrice} costTotal=${it.costTotal}`);
}
console.log('stockBatchesConsumed:');
for (const c of sale.stockBatchesConsumed) {
  console.log(`  batch=${(c.batchId || '').slice(0,8)} qty=${c.qty} costPrice=${c.costPrice} sellingPrice=${c.sellingPrice}`);
}

const afterSaleQty = await variantQty('p-fifo-refund', 'M', 'أحمر');
console.log(`\nالمخزون بعد البيع: ${afterSaleQty}`);

const batchesAfterSale = await batchDetails('p-fifo-refund', 'M|أحمر');
console.log('الدفعات بعد البيع:');
for (const b of batchesAfterSale) {
  console.log(`  ${b.id} qty=${b.quantity} cost=${b.costPrice} sell=${b.sellingPrice}`);
}

// Partial refund 2 pieces — from batch 2 (the newer one, selling price 110, cost 60)
const { refund } = await db.refundSale(sale.id, {
  items: [{ productId: 'p-fifo-refund', size: 'M', color: 'أحمر', qty: 2 }],
  idempotencyKey: `refund-fifo-1`,
});

console.log(`\nالمرتجع الجزئي (2 قطعة): totalRefunded=${refund.totalRefunded}, costTotalRefunded=${refund.costTotalRefunded}`);
console.log('أصناف المرتجع:');
for (const it of refund.items) {
  console.log(`  qty=${it.qty} price=${it.price} costPrice=${it.costPrice}`);
}

const afterRefundQty = await variantQty('p-fifo-refund', 'M', 'أحمر');
console.log(`\nالمخزون بعد الاسترجاع الجزئي: ${afterRefundQty}`);

const batchesAfterRefund = await batchDetails('p-fifo-refund', 'M|أحمر');
console.log('الدفعات بعد الاسترجاع:');
for (const b of batchesAfterRefund) {
  console.log(`  ${b.id} qty=${b.quantity} cost=${b.costPrice} sell=${b.sellingPrice}`);
}

const allSales = await db.listSales();
const allRefunds = await db.listRefunds();
const rev = analytics.revenue(allSales);
const refTotal = analytics.refundsTotal(allRefunds);
const prof = analytics.profit(allSales);
const refCost = analytics.refundsCostTotal(allRefunds);

console.log(`\nالتقرير: revenue=${rev}, refundsTotal=${refTotal}, netRevenue=${rev - refTotal}, profit=${prof}, refundedCost=${refCost}, netProfit=${prof - (refTotal - refCost)}`);

// Expected values:
// Sale: 4 items = 3×100 + 1×110 = 410 total, costTotal = 3×40 + 1×60 = 180
// Refund 2 pieces: LIFO — batch 2 had only 1 piece left, so 1×110 + 1×100 = 210
//   cost: 1×60 + 1×40 = 100
// Inventory: started 6, sold 4 → 2, refunded 2 → 4
// Batch 1: 0 + 1 = 1 (not empty, only 1 piece restored)
// Batch 2: 2 + 1 = 3 (restored 1 piece)
// Net revenue = 410 - 210 = 200
// Net profit = (410-180) - (210-100) = 230 - 110 = 120

const failures = [];
function check(label, actual, expected) {
  const ok = Number(actual) === Number(expected);
  if (!ok) failures.push(`${label}: expected ${expected}, got ${actual}`);
  console.log(`${ok ? '✅' : '❌'} ${label}: actual=${actual}, expected=${expected}`);
}

check('إجمالي البيع', sale.total, 410);
check('تكلفة البيع (costTotal)', sale.costTotal, 180);
check('مبلغ المرتجع الجزئي (LIFO: 1×110 + 1×100)', refund.totalRefunded, 210);
check('تكلفة المرتجع الجزئي (LIFO: 1×60 + 1×40)', refund.costTotalRefunded, 100);
check('المخزون قبل البيع', beforeQty, 6);
check('المخزون بعد البيع', afterSaleQty, 2);
check('المخزون بعد الاسترجاع الجزئي', afterRefundQty, 4);
check('صافي المبيعات', rev - refTotal, 200);
check('صافي الربح', prof - (refTotal - refCost), 120);

// Verify batch states
const b1 = batchesAfterRefund.find((b) => b.id === 'batch-fifo-1');
const b2 = batchesAfterRefund.find((b) => b.id === 'batch-fifo-2');
check('الدفعة 1: 0+1=1 (ليست فارغة)', b1 ? b1.quantity : 'missing', 1);
check('الدفعة 2: 2+1=3', b2 ? b2.quantity : 'missing', 3);

if (failures.length) {
  console.log(`\n❌ ${failures.length} فشلاً:`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exitCode = 1;
} else {
  console.log(`\n✅ جميع تحققات FIFO ناجحة`);
}

console.log('\nانتهى اختبار FIFO.');
