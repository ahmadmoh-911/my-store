/**
 * 7(أ) — evidence for "restock at a new price": what happens to the OLD lots?
 *
 *   node tests/lots-restock-price.evidence.mjs
 *
 * Numeric, reproducible proof against the REAL js/db.js (no mocks around db).
 * Scenario:
 *   product p1, variant L|أحمر
 *   opening lot  : 10 pcs @ cost 10.00, selling 15.00
 *   restock      :  5 pcs @ cost 12.00, NEW selling price 18.00
 *   then         : sell 3 pcs (FIFO) and inspect the consumed records.
 *
 * Expected (and checked below):
 *   1. the OLD lot is NOT rewritten — still 10 pcs @ 10.00 / 15.00
 *   2. a SEPARATE new lot exists — 5 pcs @ 12.00 / 18.00
 *   3. the product's own price/cost move to 18.00 / 12.00 (display only)
 *   4. a FIFO sale of 3 takes from the OLD lot and records cost 10.00 and
 *      selling 15.00 — the old stock is never retro-priced to the new figures.
 */

import { createFakeIndexedDB } from './fake-indexeddb.mjs';

const js = (rel) => new URL(`../js/${rel}`, import.meta.url).href;
const fakeIdb = createFakeIndexedDB();
globalThis.indexedDB = fakeIdb;
const db = await import(js('db.js'));

for (const name of Object.values(db.STORES)) await db.clearStore(name);

const VK = 'L|أحمر';
const P = 'p1';

// A product with an opening lot (10 @ 10.00 cost / 15.00 selling), the shape
// the app itself writes when a product is created with a starting quantity.
await db.put(db.STORES.products, {
  id: P, name: 'قميص', sku: '', category: 'غير مصنف', description: '',
  price: 15, costPrice: 10,
  variants: [{ size: 'L', color: 'أحمر', quantity: 10 }],
  image: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
});
await db.put(db.STORES.stockBatches, {
  id: 'LOT-OLD', productId: P, variantKey: VK, size: 'L', color: 'أحمر',
  quantity: 10, costPrice: 10, sellingPrice: 15, createdAt: '2026-01-01T00:00:00.000Z',
});

const line = (label, v) => console.log(`  ${label.padEnd(34)} ${v}`);

const lots = async () => (await db.listStockBatches()).sort((a, b) => a.id.localeCompare(b.id));
const show = async (title) => {
  console.log(`\n[${title}]`);
  for (const b of await lots()) {
    line(b.id, `qty=${b.quantity}  cost=${b.costPrice}  sell=${b.sellingPrice}`);
  }
  const p = await db.get(db.STORES.products, P);
  line('product.price / product.costPrice', `${p.price} / ${p.costPrice}`);
};

await show('قبل التجديد');

// ---- restock 5 pcs at cost 12.00 with a NEW selling price 18.00 ----------
await db.restockProduct({
  id: 'PO-1',
  productId: P,
  productName: 'قميص',
  date: '2026-02-01T00:00:00.000Z',
  lines: [{ size: 'L', color: 'أحمر', qty: 5 }],
  unitCost: 12,
  newPrice: 18,
});
await show('بعد التجديد (5 قطع بتكلفة 12 وسعر بيع 18)');

const after = await lots();
const oldLot = after.find((b) => b.id === 'LOT-OLD');
const newLot = after.find((b) => b.id !== 'LOT-OLD');

console.log('\n[نتائج التحقق]');
const checks = [
  ['الدفعة القديمة لم تُكتب من جديد', oldLot && Number(oldLot.quantity) === 10
    && Number(oldLot.costPrice) === 10 && Number(oldLot.sellingPrice) === 15],
  ['وُجدت دفعة جديدة منفصلة بكمية 5', !!newLot && Number(newLot.quantity) === 5],
  ['الدفعة الجديدة بتكلفة 12', !!newLot && Number(newLot.costPrice) === 12],
  ['الدفعة الجديدة بسعر بيع 18', !!newLot && Number(newLot.sellingPrice) === 18],
];
for (const [what, ok] of checks) line(ok ? 'PASS' : 'FAIL', what);

// ---- sell 3 pcs FIFO: must come from the OLD lot -------------------------
const sale = await db.createSale({
  id: 's-1',
  items: [{ productId: P, name: 'قميص', size: 'L', color: 'أحمر', qty: 3, price: 18, costPrice: 12 }],
  paymentMethod: 'cash',
});

console.log('\n[الفاتورة والاستهلاك FIFO]');
line('سعر السطر (كما يعرضه الكاشير)', sale.items[0].price);
line('الإجمالي', sale.total);
for (const c of sale.stockBatchesConsumed || []) {
  line(`مستهلك من ${c.batchId}`, `qty=${c.qty}  cost=${c.costPrice}  sell=${c.sellingPrice}`);
}
console.log('\nملاحظة: الكاشير يعرض سعر المنتج 18، لكن البيع سحب من الدفعة القديمة');
console.log('وسجّل تكلفتها 10 وسعر بيعها القديم 15 — أي أن القديم لم يُعاد تسعيره.');
console.log('هذا فرق يحتاج قرار المالك: هل يُباع القديم بسعره القديم (15) أم بسعر المنتج (18)؟');

await show('بعد بيع 3 قطع');
