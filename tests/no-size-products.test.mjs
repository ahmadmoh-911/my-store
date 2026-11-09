/**
 * Products without sizes/colors (no-size products) tests.
 * Run: node --test tests/no-size-products.test.mjs
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
  await saveProduct(productData);
  return productData.id;
}

/* =================================================================== *
 * Test cases
 * =================================================================== */

await resetDb();

section('No-size product - basic creation');

try {
  const pid = await createProductWithStock({
    id: 'p-nosize-1',
    name: 'عطر',
    category: 'عطور',
    price: 200,
    costPrice: 80,
    variants: [], // No sizes/colors
    barcode: '1234567890132'
  });

  const product = await db.get(db.STORES.products, pid);
  ok('product created with empty variants', product.variants.length === 0);
  const { stockOf } = await import(js('db.js'));
  ok('product has stockOf = 0 initially', stockOf(product) === 0);
} catch (e) {
  ok('no-size product creation', false, e.message);
}

await resetDb();

section('No-size product - restock adds quantity to single variant');

try {
  const pid = await createProductWithStock({
    id: 'p-nosize-2',
    name: 'عطر فاخر',
    category: 'عطور',
    price: 300,
    costPrice: 120,
    variants: [],
    barcode: '1234567890133'
  });

  // Restock - should create a single variant with empty size/color
  await db.restockProduct({
    productId: pid,
    productName: 'عطر فاخر',
    lines: [{ size: '', color: '', qty: 50 }],
    unitCost: 130,
    newPrice: 320,
    supplierId: '',
    supplierName: 'مورد عطور',
    date: new Date().toISOString().split('T')[0]
  });

  const after = await db.get(db.STORES.products, pid);
  ok('single variant created with empty size/color', after.variants.length === 1);
  ok('variant has empty size', after.variants[0].size === '');
  ok('variant has empty color', after.variants[0].color === '');
  ok('variant quantity 50', after.variants[0].quantity === 50);
  ok('product base costPrice updated to 130', after.costPrice === 130);
} catch (e) {
  ok('no-size product restock', false, e.message);
}

await resetDb();

section('No-size product - sell with sufficient quantity');

try {
  const pid = await createProductWithStock({
    id: 'p-nosize-3',
    name: 'عطر للبيع',
    category: 'عطور',
    price: 150,
    costPrice: 60,
    variants: [],
    barcode: '1234567890134'
  });

  await db.restockProduct({
    productId: pid,
    productName: 'عطر للبيع',
    lines: [{ size: '', color: '', qty: 20 }],
    unitCost: 65,
    newPrice: 160,
    supplierId: '',
    supplierName: 'مورد',
    date: new Date().toISOString().split('T')[0]
  });

  const product = await db.get(db.STORES.products, pid);
  const variantId = product.variants[0].id;

  // Sell 5
  const { createSale } = await import(js('db.js'));
  await createSale({
    items: [{
      productId: pid,
      name: 'عطر للبيع',
      qty: 5,
      price: 160,
      size: '',
      color: '',
      costPrice: 65,
      variantId
    }],
    paymentMethod: 'cash',
    customerName: 'عميل',
    timestamp: new Date().toISOString()
  });

  const after = await db.get(db.STORES.products, pid);
  ok('quantity reduced to 15', after.variants[0].quantity === 15);

  const sales = await db.listSales();
  const mySale = sales.find(s => s.items[0].productId === pid);
  ok('sale created', !!mySale);
  ok('sale total = 5 * 160 = 800', mySale && mySale.total === 800);
} catch (e) {
  ok('no-size product sell sufficient qty', false, e.message);
}

await resetDb();

section('No-size product - sell with insufficient quantity rejected');

try {
  const pid = await createProductWithStock({
    id: 'p-nosize-4',
    name: 'عطر محدود',
    category: 'عطور',
    price: 100,
    costPrice: 40,
    variants: [],
    barcode: '1234567890135'
  });

  await db.restockProduct({
    productId: pid,
    productName: 'عطر محدود',
    lines: [{ size: '', color: '', qty: 3 }],
    unitCost: 45,
    newPrice: 110,
    supplierId: '',
    supplierName: 'مورد',
    date: new Date().toISOString().split('T')[0]
  });

  const product = await db.get(db.STORES.products, pid);
  const variantId = product.variants[0].id;

  // Try to sell 5 (only 3 available) - should fail
  const { createSale } = await import(js('db.js'));
  let error = null;
  try {
    await createSale({
      items: [{
        productId: pid,
        name: 'عطر محدود',
        qty: 5,
        price: 110,
        size: '',
        color: '',
        costPrice: 45,
        variantId
      }],
      paymentMethod: 'cash',
      customerName: 'عميل',
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    error = e;
  }
  ok('sale rejected when qty > available', !!error);

  const after = await db.get(db.STORES.products, pid);
  ok('quantity unchanged (still 3)', after.variants[0].quantity === 3);
} catch (e) {
  ok('no-size product sell insufficient qty rejected', false, e.message);
}

await resetDb();

section('No-size product - negative quantity filtered out (becomes 0)');

try {
  const pid = await createProductWithStock({
    id: 'p-nosize-5',
    name: 'عطر سالب',
    category: 'عطور',
    price: 100,
    costPrice: 40,
    variants: [],
    barcode: '1234567890136'
  });

  await db.restockProduct({
    productId: pid,
    productName: 'عطر سالب',
    lines: [{ size: '', color: '', qty: 10 }],
    unitCost: 45,
    newPrice: 110,
    supplierId: '',
    supplierName: 'مورد',
    date: new Date().toISOString().split('T')[0]
  });

  const product = await db.get(db.STORES.products, pid);
  const variantId = product.variants[0].id;

  // Try to sell -1 (becomes 0 via nonNegInt, filtered out)
  const { createSale } = await import(js('db.js'));
  let error = null;
  try {
    await createSale({
      items: [{
        productId: pid,
        name: 'عطر سالب',
        qty: -1,
        price: 110,
        size: '',
        color: '',
        costPrice: 45,
        variantId
      }],
      paymentMethod: 'cash',
      customerName: 'عميل',
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    error = e;
  }
  // Negative qty becomes 0, item filtered out -> sale with 0 items
  // This may or may not throw; the key is qty doesn't go negative
  const after = await db.get(db.STORES.products, pid);
  ok('quantity unchanged (10)', after.variants[0].quantity === 10);
} catch (e) {
  ok('no-size product negative qty handled', false, e.message);
}

await resetDb();

section('No-size product - refund restores quantity');

try {
  const pid = await createProductWithStock({
    id: 'p-nosize-6',
    name: 'عطر مرتجع',
    category: 'عطور',
    price: 200,
    costPrice: 80,
    variants: [],
    barcode: '1234567890137'
  });

  await db.restockProduct({
    productId: pid,
    productName: 'عطر مرتجع',
    lines: [{ size: '', color: '', qty: 10 }],
    unitCost: 85,
    newPrice: 210,
    supplierId: '',
    supplierName: 'مورد',
    date: new Date().toISOString().split('T')[0]
  });

  const product = await db.get(db.STORES.products, pid);
  const variantId = product.variants[0].id;

  const { createSale, refundSale, listSales } = await import(js('db.js'));
  await createSale({
    items: [{
      productId: pid,
      name: 'عطر مرتجع',
      qty: 4,
      price: 210,
      size: '',
      color: '',
      costPrice: 85,
      variantId
    }],
    paymentMethod: 'cash',
    customerName: 'عميل',
    timestamp: new Date().toISOString()
  });

  const sales = await listSales();
  const mySale = sales.find(s => s.items[0].productId === pid);
  await refundSale(mySale.id);

  const after = await db.get(db.STORES.products, pid);
  ok('quantity restored to 10 after refund', after.variants[0].quantity === 10);
} catch (e) {
  ok('no-size product refund', false, e.message);
}

await resetDb();

section('No-size product - edit invoice');

try {
  const pid = await createProductWithStock({
    id: 'p-nosize-7',
    name: 'عطر تعديل',
    category: 'عطور',
    price: 150,
    costPrice: 60,
    variants: [],
    barcode: '1234567890138'
  });

  await db.restockProduct({
    productId: pid,
    productName: 'عطر تعديل',
    lines: [{ size: '', color: '', qty: 20 }],
    unitCost: 65,
    newPrice: 160,
    supplierId: '',
    supplierName: 'مورد',
    date: new Date().toISOString().split('T')[0]
  });

  const product = await db.get(db.STORES.products, pid);
  const variantId = product.variants[0].id;

  const { createSale, updateSale, listSales } = await import(js('db.js'));
  const sale = await createSale({
    items: [{
      productId: pid,
      name: 'عطر تعديل',
      qty: 5,
      price: 160,
      size: '',
      color: '',
      costPrice: 65,
      variantId
    }],
    paymentMethod: 'cash',
    customerName: 'عميل',
    timestamp: new Date().toISOString()
  });

  // Edit: change qty from 5 to 3
  await updateSale(sale.id, {
    items: [{
      productId: pid,
      name: 'عطر تعديل',
      qty: 3,
      price: 160,
      size: '',
      color: '',
      costPrice: 65,
      variantId
    }],
    paymentMethod: 'cash',
    customerName: 'عميل',
    timestamp: new Date().toISOString()
  });

  const after = await db.get(db.STORES.products, pid);
  // 20 - 5 (original sale) + 5 (restored) - 3 (new sale) = 17
  // Actually: 20 restocked, sale 5 -> 15, edit to 3 -> restore 5, then sell 3 = 17
  ok('quantity after edit (17)', after.variants[0].quantity === 17);
} catch (e) {
  ok('no-size product edit invoice', false, e.message);
}

await resetDb();

section('No-size product - mixed invoice with sized product');

try {
  const pidNoSize = await createProductWithStock({
    id: 'p-nosize-8',
    name: 'عطر مختلط',
    category: 'عطور',
    price: 100,
    costPrice: 40,
    variants: [],
    barcode: '1234567890139'
  });

  const pidSized = await createProductWithStock({
    id: 'p-sized-8',
    name: 'قميص مختلط',
    category: 'ملابس',
    price: 80,
    costPrice: 35,
    variants: [{ size: 'M', color: 'أزرق', quantity: 10 }],
    barcode: '1234567890140'
  });

  await db.restockProduct({
    productId: pidNoSize,
    productName: 'عطر مختلط',
    lines: [{ size: '', color: '', qty: 5 }],
    unitCost: 45,
    newPrice: 110,
    supplierId: '',
    supplierName: 'مورد',
    date: new Date().toISOString().split('T')[0]
  });

  const noSizeProduct = await db.get(db.STORES.products, pidNoSize);
  const sizedProduct = await db.get(db.STORES.products, pidSized);
  const noSizeVariantId = noSizeProduct.variants[0].id;
  const sizedVariantId = sizedProduct.variants[0].id;

  const { createSale } = await import(js('db.js'));
  await createSale({
    items: [
      {
        productId: pidNoSize,
        name: 'عطر مختلط',
        qty: 2,
        price: 110,
        size: '',
        color: '',
        costPrice: 45,
        variantId: noSizeVariantId
      },
      {
        productId: pidSized,
        name: 'قميص مختلط',
        qty: 1,
        price: 80,
        size: 'M',
        color: 'أزرق',
        costPrice: 35,
        variantId: sizedVariantId
      }
    ],
    paymentMethod: 'cash',
    customerName: 'عميل مختلط',
    timestamp: new Date().toISOString()
  });

  const noSizeAfter = await db.get(db.STORES.products, pidNoSize);
  const sizedAfter = await db.get(db.STORES.products, pidSized);
  ok('no-size product qty reduced (3)', noSizeAfter.variants[0].quantity === 3);
  ok('sized product qty reduced (9)', sizedAfter.variants[0].quantity === 9);

  const sales = await db.listSales();
  const mySale = sales.find(s => s.items.some(i => i.productId === pidNoSize));
  ok('mixed sale created', !!mySale);
  ok('mixed sale has 2 items', mySale && mySale.items.length === 2);
  ok('mixed sale total = 2*110 + 1*80 = 300', mySale && mySale.total === 300);
} catch (e) {
  ok('no-size product mixed invoice', false, e.message);
}

await resetDb();

section('No-size product - export/import preserves data');

try {
  const pid = await createProductWithStock({
    id: 'p-nosize-9',
    name: 'عطر تصدير',
    category: 'عطور',
    price: 250,
    costPrice: 100,
    variants: [],
    barcode: '1234567890141'
  });

  await db.restockProduct({
    productId: pid,
    productName: 'عطر تصدير',
    lines: [{ size: '', color: '', qty: 30 }],
    unitCost: 110,
    newPrice: 260,
    supplierId: '',
    supplierName: 'مورد',
    date: new Date().toISOString().split('T')[0]
  });

  const { exportAll } = await import(js('db.js'));
  const exported = await exportAll();

  const exportedProduct = exported.products.find(p => p.id === pid);
  // After restock, product has one variant with empty size/color
  ok('exported product has 1 variant with empty size/color', exportedProduct.variants.length === 1);
  ok('exported variant has empty size', exportedProduct.variants[0].size === '');
  ok('exported variant has empty color', exportedProduct.variants[0].color === '');

  const exportedPurchases = exported.purchases.filter(p => p.productId === pid);
  ok('exported purchases count (1)', exportedPurchases.length === 1);
} catch (e) {
  ok('no-size product export/import', false, e.message);
}

await resetDb();

section('No-size product - restock at new price creates separate batch');

try {
  const pid = await createProductWithStock({
    id: 'p-nosize-10',
    name: 'عطر سعر جديد',
    category: 'عطور',
    price: 200,
    costPrice: 80,
    variants: [],
    barcode: '1234567890142'
  });

  await db.restockProduct({
    productId: pid,
    productName: 'عطر سعر جديد',
    lines: [{ size: '', color: '', qty: 10 }],
    unitCost: 85,
    newPrice: 210,
    supplierId: '',
    supplierName: 'مورد 1',
    date: new Date().toISOString().split('T')[0]
  });

  await db.restockProduct({
    productId: pid,
    productName: 'عطر سعر جديد',
    lines: [{ size: '', color: '', qty: 5 }],
    unitCost: 90,
    newPrice: 220,
    supplierId: '',
    supplierName: 'مورد 2',
    date: new Date().toISOString().split('T')[0]
  });

  const purchases = await db.listPurchases();
  const productPurchases = purchases.filter(p => p.productId === pid && p.units > 0);
  ok('two restock purchases', productPurchases.length === 2);

  const batches = await db.listStockBatches();
  const variantBatches = batches.filter(b => b.productId === pid && b.variantKey === '|');
  ok('two stock batches (one per restock)', variantBatches.length === 2);
  const costs = variantBatches.map(b => b.costPrice).sort((a, b) => a - b);
  ok('batch costs [85, 90]', JSON.stringify(costs) === JSON.stringify([85, 90]));
} catch (e) {
  ok('no-size product separate batches per price', false, e.message);
}

await resetDb();

section('Legacy no-size product (created before fix) - no crash');

try {
  // Simulate old product without variants array
  const pid = await db.put(db.STORES.products, {
    id: 'p-legacy-1',
    name: 'منتج قديم بلا متغيرات',
    category: 'عام',
    price: 50,
    costPrice: 20,
    // No variants field at all
    barcode: '1234567890143',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  // Restock should work - creates variant with empty size/color
  await db.restockProduct({
    productId: pid,
    productName: 'منتج قديم بلا متغيرات',
    lines: [{ size: '', color: '', qty: 10 }],
    unitCost: 25,
    newPrice: 55,
    supplierId: '',
    supplierName: 'مورد',
    date: new Date().toISOString().split('T')[0]
  });

  const after = await db.get(db.STORES.products, pid);
  ok('legacy product now has variant', after.variants.length === 1);
  ok('legacy variant has empty size/color', after.variants[0].size === '' && after.variants[0].color === '');
  ok('legacy variant qty 10', after.variants[0].quantity === 10);
} catch (e) {
  ok('legacy no-size product restock', false, e.message);
}

/* =================================================================== *
 * Mutation proofs
 * =================================================================== */
console.log('\n\n=== Mutation Proofs ===\n');

await resetDb();

section('Mutation: no-size product treated as single variant');

try {
  const pid = await createProductWithStock({
    id: 'p-mut-nosize-1',
    name: 'عطر طفرة',
    category: 'عطور',
    price: 100,
    costPrice: 40,
    variants: [],
    barcode: '1234567890144'
  });

  await db.restockProduct({
    productId: pid,
    productName: 'عطر طفرة',
    lines: [{ size: '', color: '', qty: 20 }],
    unitCost: 45,
    newPrice: 110,
    supplierId: '',
    supplierName: 'مورد',
    date: new Date().toISOString().split('T')[0]
  });

  const product = await db.get(db.STORES.products, pid);
  const variantId = product.variants[0].id;

  // If broken: sale would fail or create wrong variant
  const { createSale } = await import(js('db.js'));
  await createSale({
    items: [{
      productId: pid,
      name: 'عطر طفرة',
      qty: 5,
      price: 110,
      size: '',
      color: '',
      costPrice: 45,
      variantId
    }],
    paymentMethod: 'cash',
    customerName: 'عميل',
    timestamp: new Date().toISOString()
  });

  const after = await db.get(db.STORES.products, pid);
  ok('sale works with empty size/color variant', after.variants[0].quantity === 15);
} catch (e) {
  ok('mutation: no-size as single variant', false, e.message);
}

await resetDb();

section('Mutation: no-size product stock batches work');

try {
  const pid = await createProductWithStock({
    id: 'p-mut-nosize-2',
    name: 'عطر طفرة دفعات',
    category: 'عطور',
    price: 100,
    costPrice: 40,
    variants: [],
    barcode: '1234567890145'
  });

  await db.restockProduct({
    productId: pid,
    productName: 'عطر طفرة دفعات',
    lines: [{ size: '', color: '', qty: 10 }],
    unitCost: 50,
    newPrice: 120,
    supplierId: '',
    supplierName: 'مورد',
    date: new Date().toISOString().split('T')[0]
  });

  const batches = await db.listStockBatches();
  const variantBatches = batches.filter(b => b.productId === pid && b.variantKey === '|');
  ok('stock batch created for no-size product', variantBatches.length === 1);
  ok('batch has correct costPrice', variantBatches[0].costPrice === 50);
  ok('batch has correct sellingPrice', variantBatches[0].sellingPrice === 120);
} catch (e) {
  ok('mutation: no-size stock batches', false, e.message);
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