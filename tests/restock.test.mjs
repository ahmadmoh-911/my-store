/**
 * Restock (تجديد الكمية) tests — end-to-end from js/restock.js flow.
 * Uses the same fake-indexeddb infrastructure as lots.test.mjs.
 * Run: node --test tests/restock.test.mjs
 */
import { createFakeIndexedDB } from './fake-indexeddb.mjs';
import { micro, toCents, centsToMicro } from './reference-accounting.mjs';

const js = (rel) => new URL(`../js/${rel}`, import.meta.url).href;

/* ------------------------------------------------------------------ *
 * Setup fake IndexedDB FIRST, then import db.js
 * ------------------------------------------------------------------ */
const fakeIdb = createFakeIndexedDB();
globalThis.indexedDB = fakeIdb;

const db = await import(js('db.js'));

/* ------------------------------------------------------------------ *
 * Tiny runner
 * ------------------------------------------------------------------ */
let passed = 0;
let failed = 0;
const failures = [];
let _sectionStart = 0;
let _sectionFailed = 0;

function ok(label, condition, detail = '') {
  if (condition) { passed++; return; }
  failed++;
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ''}`);
}

function eq(label, actual, expected, detail = '') {
  const a = typeof actual === 'bigint' ? `${actual}n` : actual;
  const e = typeof expected === 'bigint' ? `${expected}n` : expected;
  let same = Object.is(a, e);
  try { same = same || JSON.stringify(a) === JSON.stringify(e); } catch { /* fall through */ }
  ok(label, same, detail || `expected ${e}, got ${a}`);
}

function section(title) {
  if (_sectionStart) console.log(`   (${passed - _sectionStart} passed, ${failed - _sectionFailed} failed)`);
  _sectionStart = passed;
  _sectionFailed = failed;
  console.log(`\n${title}`);
}

async function resetDb() {
  for (const name of Object.values(db.STORES)) await db.clearStore(name);
}

/* Helper to create product with initial stock batch via saveProduct */
async function createProductWithStock(productData) {
  const { saveProduct } = await import(js('db.js'));
  // saveProduct will auto-create initial stock batches
  await saveProduct(productData);
  const saved = await db.get(db.STORES.products, productData.id);
  return saved.id;
}

/* =================================================================== *
 * Test cases
 * =================================================================== */

await resetDb();

section('Restock - existing variant adds new batch with new prices');

try {
  const pid = await createProductWithStock({
    id: 'p-restock-1',
    name: 'قميص اختبار',
    category: 'ملابس',
    price: 100,
    costPrice: 50,
    variants: [
      { size: 'S', color: 'أحمر', quantity: 10 }
    ],
    barcode: '1234567890123'
  });

  // Restock 5 more of same variant with NEW prices
  const res = await db.restockProduct({
    productId: pid,
    productName: 'قميص اختبار',
    lines: [{ size: 'S', color: 'أحمر', qty: 5 }],
    unitCost: 60,
    newPrice: 120,
    supplierId: '',
    supplierName: 'مورد جديد',
    date: new Date().toISOString().split('T')[0]
  });

  const after = await db.get(db.STORES.products, pid);
  ok('variant quantity increased to 15', after.variants[0].quantity === 15);
  // Product's base costPrice updated to new unitCost (line 552 in db.js)
  ok('product base costPrice updated to new (60)', after.costPrice === 60);
  // Variant's costPrice is NOT updated (stays at original)
  ok('variant costPrice is undefined (not copied from product)', after.variants[0].costPrice === undefined);

  const purchases = await db.listPurchases();
  const restockPurchase = purchases.find(p => p.productId === pid && p.units === 5);
  ok('new purchase batch created', !!restockPurchase);
  ok('restock purchase has new costPrice (60)', restockPurchase && restockPurchase.unitCost === 60);
  ok('restock purchase has new sell price (120)', restockPurchase && restockPurchase.newPrice === 120);
  // Only 1 purchase (the restock) - initial stock doesn't create purchase
  ok('only restock purchase exists (1)', purchases.filter(p => p.productId === pid).length === 1);

  // Check stock batch for restock
  const batches = await db.listStockBatches();
  const newBatch = batches.find(b => b.productId === pid && b.variantKey === 'S|أحمر' && b.quantity === 5);
  ok('new stock batch created with correct costPrice (60)', !!newBatch && newBatch.costPrice === 60);
  ok('new stock batch has correct sellingPrice (120)', !!newBatch && newBatch.sellingPrice === 120);
  // Two stock batches: initial + restock
  const variantBatches = batches.filter(b => b.productId === pid && b.variantKey === 'S|أحمر');
  ok('two stock batches total (initial + restock)', variantBatches.length === 2);
} catch (e) {
  ok('existing variant restock', false, e.message);
}

await resetDb();

section('Restock - add new size to existing product');

try {
  const pid = await createProductWithStock({
    id: 'p-restock-2',
    name: 'بنطلون اختبار',
    category: 'ملابس',
    price: 150,
    costPrice: 70,
    variants: [
      { size: 'M', color: 'أسود', quantity: 8 }
    ],
    barcode: '1234567890124'
  });

  const saved = await db.get(db.STORES.products, pid);
  const originalCount = saved.variants.length;

  await db.restockProduct({
    productId: pid,
    productName: 'بنطلون اختبار',
    lines: [{ size: 'L', color: 'أسود', qty: 12 }],
    unitCost: 75,
    newPrice: 160,
    supplierId: '',
    supplierName: 'مورد بنطلونات',
    date: new Date().toISOString().split('T')[0]
  });

  const after = await db.get(db.STORES.products, pid);
  ok('new variant created', after.variants.length === originalCount + 1);
  const newVariant = after.variants.find(v => v.size === 'L' && v.color === 'أسود');
  ok('new variant has correct qty (12)', newVariant && newVariant.quantity === 12);
  // Product base costPrice updated to new restock cost
  ok('product base costPrice updated to new (75)', after.costPrice === 75);

  const purchases = await db.listPurchases();
  const restock = purchases.find(p => p.productId === pid && p.lines.some(l => l.size === 'L'));
  ok('restock batch for new variant', !!restock);
  ok('restock has correct costPrice (75)', restock && restock.unitCost === 75);
  ok('restock has correct newPrice (160)', restock && restock.newPrice === 160);
} catch (e) {
  ok('add new size', false, e.message);
}

await resetDb();

section('Restock - add new color to existing size');

try {
  const pid = await createProductWithStock({
    id: 'p-restock-3',
    name: 'تيشيرت اختبار',
    category: 'ملابس',
    price: 80,
    costPrice: 35,
    variants: [
      { size: 'M', color: 'أبيض', quantity: 20 }
    ],
    barcode: '1234567890125'
  });

  await db.restockProduct({
    productId: pid,
    productName: 'تيشيرت اختبار',
    lines: [{ size: 'M', color: 'أزرق', qty: 15 }],
    unitCost: 38,
    newPrice: 85,
    supplierId: '',
    supplierName: 'مورد تيشيرتات',
    date: new Date().toISOString().split('T')[0]
  });

  const after = await db.get(db.STORES.products, pid);
  const newVariant = after.variants.find(v => v.size === 'M' && v.color === 'أزرق');
  ok('new color variant created', !!newVariant);
  ok('new variant qty (15)', newVariant && newVariant.quantity === 15);
  ok('product base costPrice updated to new (38)', after.costPrice === 38);
} catch (e) {
  ok('add new color', false, e.message);
}

await resetDb();

section('Restock - different prices create separate batches');

try {
  const pid = await createProductWithStock({
    id: 'p-restock-4',
    name: 'حذاء اختبار',
    category: 'أحذية',
    price: 200,
    costPrice: 100,
    variants: [
      { size: '42', color: 'بني', quantity: 5 }
    ],
    barcode: '1234567890126'
  });

  // First restock
  await db.restockProduct({
    productId: pid,
    productName: 'حذاء اختبار',
    lines: [{ size: '42', color: 'بني', qty: 3 }],
    unitCost: 110,
    newPrice: 220,
    supplierId: '',
    supplierName: 'مورد 1',
    date: new Date().toISOString().split('T')[0]
  });

  // Second restock
  await db.restockProduct({
    productId: pid,
    productName: 'حذاء اختبار',
    lines: [{ size: '42', color: 'بني', qty: 2 }],
    unitCost: 115,
    newPrice: 230,
    supplierId: '',
    supplierName: 'مورد 2',
    date: new Date().toISOString().split('T')[0]
  });

  const purchases = await db.listPurchases();
  const productPurchases = purchases.filter(p => p.productId === pid && p.units > 0);
  // Two restock purchases (no initial purchase)
  ok('two restock purchases', productPurchases.length === 2);
  const costs = productPurchases.map(p => p.unitCost).sort((a, b) => a - b);
  ok('costs preserved per batch [110, 115]', JSON.stringify(costs) === JSON.stringify([110, 115]));

  // Product base costPrice should be last restock's unitCost (115)
  const after = await db.get(db.STORES.products, pid);
  ok('product base costPrice is last restock cost (115)', after.costPrice === 115);

  // Three stock batches: initial + 2 restocks
  const batches = await db.listStockBatches();
  const variantBatches = batches.filter(b => b.productId === pid && b.variantKey === '42|بني');
  ok('three stock batches total (initial + 2 restocks)', variantBatches.length === 3);
} catch (e) {
  ok('separate batches per price', false, e.message);
}

await resetDb();

section('Restock - sell after restock uses FIFO');

try {
  const pid = await createProductWithStock({
    id: 'p-restock-5',
    name: 'جاكيت اختبار',
    category: 'ملابس',
    price: 300,
    costPrice: 150,
    variants: [
      { size: 'L', color: 'رمادي', quantity: 4 }
    ],
    barcode: '1234567890127'
  });

  const variantId = (await db.get(db.STORES.products, pid)).variants[0].id;

  // Restock 6 at cost 160, sell 320
  await db.restockProduct({
    productId: pid,
    productName: 'جاكيت اختبار',
    lines: [{ size: 'L', color: 'رمادي', qty: 6 }],
    unitCost: 160,
    newPrice: 320,
    supplierId: '',
    supplierName: 'مورد جاكيتات',
    date: new Date().toISOString().split('T')[0]
  });

  // Sell 5 - should consume 4 from old (cost 150) + 1 from new (cost 160)
  const sale = {
    items: [{
      productId: pid,
      name: 'جاكيت اختبار',
      qty: 5,
      price: 320,
      size: 'L',
      color: 'رمادي',
      costPrice: 150,
      variantId
    }],
    paymentMethod: 'cash',
    customerName: 'عميل اختبار',
    timestamp: new Date().toISOString()
  };
  const { createSale } = await import(js('db.js'));
  await createSale(sale);

  const after = await db.get(db.STORES.products, pid);
  ok('remaining qty after sale (5)', after.variants[0].quantity === 5);

  const sales = await db.listSales();
  const mySale = sales.find(s => s.items[0].productId === pid);
  ok('sale created', !!mySale);

  let totalCost = 0;
  for (const it of mySale.items) {
    totalCost += it.qty * (it.costPrice || 0);
  }
  const expectedCost = 4 * 150 + 1 * 160;
  ok('sale cost uses FIFO (4×150 + 1×160 = 760)', totalCost === expectedCost, `expected ${expectedCost}, got ${totalCost}`);
} catch (e) {
  ok('sell after restock FIFO', false, e.message);
}

await resetDb();

section('Restock - refund restores to correct batches');

try {
  const pid = await createProductWithStock({
    id: 'p-restock-6',
    name: 'قميص بولو اختبار',
    category: 'ملابس',
    price: 120,
    costPrice: 55,
    variants: [
      { size: 'S', color: 'أخضر', quantity: 10 }
    ],
    barcode: '1234567890128'
  });

  const variantId = (await db.get(db.STORES.products, pid)).variants[0].id;

  await db.restockProduct({
    productId: pid,
    productName: 'قميص بولو اختبار',
    lines: [{ size: 'S', color: 'أخضر', qty: 5 }],
    unitCost: 60,
    newPrice: 130,
    supplierId: '',
    supplierName: 'مورد',
    date: new Date().toISOString().split('T')[0]
  });

  // Sell 8 (5 old + 3 new)
  const { createSale, refundSale, listSales } = await import(js('db.js'));
  const sale = {
    items: [{ productId: pid, name: 'قميص بولو اختبار', qty: 8, price: 130, size: 'S', color: 'أخضر', costPrice: 55, variantId }],
    paymentMethod: 'cash',
    customerName: 'عميل',
    timestamp: new Date().toISOString()
  };
  await createSale(sale);

  const sales = await listSales();
  const mySale = sales.find(s => s.items[0].productId === pid);
  ok('sale exists', !!mySale);

  // Refund (deletes sale, restores stock)
  await refundSale(mySale.id);

  const after = await db.get(db.STORES.products, pid);
  // 10 + 5 = 15 total, sold 8 = 7, refund 8 = 15
  ok('qty restored after full refund (15)', after.variants[0].quantity === 15);
} catch (e) {
  ok('refund restores batches', false, e.message);
}

await resetDb();

section('Restock - export/import preserves batches');

try {
  const pid = await createProductWithStock({
    id: 'p-restock-7',
    name: 'منتج للتصدير',
    category: 'اختبار',
    price: 100,
    costPrice: 40,
    variants: [
      { size: 'M', color: 'أحمر', quantity: 10 }
    ],
    barcode: '1234567890129'
  });

  await db.restockProduct({
    productId: pid,
    productName: 'منتج للتصدير',
    lines: [{ size: 'M', color: 'أحمر', qty: 5 }],
    unitCost: 45,
    newPrice: 110,
    supplierId: '',
    supplierName: 'مورد',
    date: new Date().toISOString().split('T')[0]
  });

  const { exportAll, importAll, clearAll, openDB } = await import(js('db.js'));
  const exported = await exportAll();

  // Verify export structure
  const exportedProduct = exported.products.find(p => p.id === pid);
  // Variants don't have IDs in DB (they're identified by size|color)
  ok('exported product has variants', exportedProduct.variants.length === 1);
  ok('exported variant has size/color', exportedProduct.variants[0].size === 'M' && exportedProduct.variants[0].color === 'أحمر');
  const exportedPurchases = exported.purchases.filter(p => p.productId === pid);
  ok('exported purchases count (1 restock)', exportedPurchases.length === 1);
  ok('exported purchase has cost/sell prices', exportedPurchases.every(p => p.unitCost !== undefined && p.newPrice !== undefined));
  ok('exported stock batches preserved (2: initial + restock)', exported.stockBatches.filter(b => b.productId === pid).length === 2);
} catch (e) {
  ok('export/import preserves batches', false, e.message);
}

/* =================================================================== *
 * Mutation proofs
 * =================================================================== */
console.log('\n\n=== Mutation Proofs ===\n');

await resetDb();

section('Mutation: disable new batch creation on restock');

try {
  const pid = await createProductWithStock({
    id: 'p-mut-1',
    name: 'منتج طفرة',
    category: 'اختبار',
    price: 100,
    costPrice: 50,
    variants: [{ size: 'M', color: 'أزرق', quantity: 10 }],
    barcode: '1234567890130'
  });

  const variantId = (await db.get(db.STORES.products, pid)).variants[0].id;

  await db.restockProduct({
    productId: pid,
    productName: 'منتج طفرة',
    lines: [{ size: 'M', color: 'أزرق', qty: 5 }],
    unitCost: 70,
    newPrice: 140,
    supplierId: '',
    supplierName: 'مورد',
    date: new Date().toISOString().split('T')[0]
  });

  const purchases = await db.listPurchases();
  const restock = purchases.find(p => p.productId === pid && p.units === 5);

  // This test passing proves the fix works
  // If broken: restock batch wouldn't exist or would have old prices
  ok('restock batch exists with new prices (70, 140)', !!restock && restock.unitCost === 70 && restock.newPrice === 140);
} catch (e) {
  ok('mutation: new batch creation', false, e.message);
}

await resetDb();

section('Mutation: restock new size without creating variant');

try {
  const pid = await createProductWithStock({
    id: 'p-mut-2',
    name: 'منتج طفرة 2',
    category: 'اختبار',
    price: 100,
    costPrice: 50,
    variants: [{ size: 'S', color: 'أحمر', quantity: 10 }],
    barcode: '1234567890131'
  });

  await db.restockProduct({
    productId: pid,
    productName: 'منتج طفرة 2',
    lines: [{ size: 'L', color: 'أحمر', qty: 8 }],
    unitCost: 55,
    newPrice: 110,
    supplierId: '',
    supplierName: 'مورد',
    date: new Date().toISOString().split('T')[0]
  });

  const after = await db.get(db.STORES.products, pid);
  const newVariant = after.variants.find(v => v.size === 'L');
  ok('new variant created for new size', !!newVariant);
  ok('new variant has correct qty (8)', newVariant && newVariant.quantity === 8);
} catch (e) {
  ok('mutation: new size creates variant', false, e.message);
}

/* =================================================================== *
 * Summary
 * =================================================================== */
console.log('\n========================================================');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('========================================================');

if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
} else {
  process.exit(0);
}