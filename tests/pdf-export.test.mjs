/**
 * PDF Export verification tests — verifies PDF content matches reports screen.
 * Run: node --test tests/pdf-export.test.mjs
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
 * Test cases - verify PDF calculations match reports screen
 * =================================================================== */

await resetDb();

section('PDF Export - Scenario 1: Multiple batches, discount, refund, no-size product');

try {
  // Create products
  const pidSized = await createProductWithStock({
    id: 'p-pdf-1',
    name: 'قميص PDF',
    category: 'ملابس',
    price: 100,
    costPrice: 40,
    variants: [{ size: 'M', color: 'أحمر', quantity: 20 }],
    barcode: '1234567890146'
  });

  const pidNoSize = await createProductWithStock({
    id: 'p-pdf-2',
    name: 'عطر PDF',
    category: 'عطور',
    price: 200,
    costPrice: 80,
    variants: [],
    barcode: '1234567890147'
  });

  // Restock sized product at new price
  await db.restockProduct({
    productId: pidSized,
    productName: 'قميص PDF',
    lines: [{ size: 'M', color: 'أحمر', qty: 10 }],
    unitCost: 45,
    newPrice: 110,
    supplierId: '',
    supplierName: 'مورد',
    date: '2026-10-01'
  });

  // Restock no-size product
  await db.restockProduct({
    productId: pidNoSize,
    productName: 'عطر PDF',
    lines: [{ size: '', color: '', qty: 15 }],
    unitCost: 85,
    newPrice: 210,
    supplierId: '',
    supplierName: 'مورد',
    date: '2026-10-01'
  });

  const sizedProduct = await db.get(db.STORES.products, pidSized);
  const noSizeProduct = await db.get(db.STORES.products, pidNoSize);
  const sizedVariantId = sizedProduct.variants[0].id;
  const noSizeVariantId = noSizeProduct.variants[0].id;

  const { createSale, refundSale, listSales } = await import(js('db.js'));

  // Sale 1: 5 sized - will use old batch (sellingPrice 100)
  const sale1 = await createSale({
    items: [{
      productId: pidSized,
      name: 'قميص PDF',
      qty: 5,
      price: 110, // input price (used for subtotal before split)
      size: 'M',
      color: 'أحمر',
      costPrice: 40,
      variantId: sizedVariantId
    }],
    paymentMethod: 'cash',
    customerName: 'عميل 1',
    discountValue: 55, // 10% of 550 (but subtotal will be 5*100=500)
    timestamp: '2026-10-02T10:00:00.000Z'
  });

  // Sale 2: 3 no-size - uses old batch (sellingPrice 200)
  const sale2 = await createSale({
    items: [{
      productId: pidNoSize,
      name: 'عطر PDF',
      qty: 3,
      price: 210,
      size: '',
      color: '',
      costPrice: 80,
      variantId: noSizeVariantId
    }],
    paymentMethod: 'card',
    customerName: 'عميل 2',
    timestamp: '2026-10-02T11:00:00.000Z'
  });

  // Sale 3: 2 sized - uses old batch (sellingPrice 100)
  const sale3 = await createSale({
    items: [{
      productId: pidSized,
      name: 'قميص PDF',
      qty: 2,
      price: 110,
      size: 'M',
      color: 'أحمر',
      costPrice: 45,
      variantId: sizedVariantId
    }],
    paymentMethod: 'transfer',
    customerName: 'عميل 3',
    timestamp: '2026-10-02T12:00:00.000Z'
  });

  // Refund sale2 (sale stays, refund record created instead)
  const salesBeforeRefund = await listSales();
  const sale2Record = salesBeforeRefund.find(s => s.id === sale2.id);
  await refundSale(sale2Record.id);

  // Now verify calculations match what reports screen would compute
  const allSales = await listSales();
  // Refunded sale STAYS in the list (audit trail); revenue subtracts refunds
  const completedSales = allSales;

  const { revenue, discountGiven, orderCount, profit } = await import(js('analytics.js'));
  const { listRefunds, listProducts } = await import(js('db.js'));
  const refunds = await listRefunds();
  const products = await listProducts();

  // Revenue = sum of sale totals (after discount) MINUS refunds
  // Sale1: 5 from old batch @ 100 = subtotal 500, discount 55 -> total 445
  // Sale3: 2 from old batch @ 100 = subtotal 200, no discount -> total 200
  // Sale2: 3 no-size @ 210 = total 630, cost 85 each -> costTotal 255
  // Sale2 is NOT deleted; it is refunded for 630
  // Revenue = 445 + 630 + 200 - 630 = 645
  const rev = revenue(completedSales) - (refunds.reduce((t, r) => t + Number(r.totalRefunded || 0), 0));
  ok('revenue = 445 + 630 + 200 - 630 (refund) = 645', rev === 645);

  const disc = discountGiven(completedSales);
  ok('discount = 55 (from sale1)', disc === 55);

  const ordCnt = orderCount(completedSales);
  ok('order count = 3 (sales stay in ledger)', ordCnt === 3);

  const prof = profit(completedSales);
  // Profit = sum(total - costTotal) minus refunded profit
  // Sale1: 445-200=245, Sale3: 200-80=120, Sale2: 630-255=375
  // Total = 740, refunded profit = 375
  // Net = 740 - 375 = 365
  const refundedCost = refunds.reduce((t, r) => t + Number(r.costTotalRefunded || 0), 0);
  const refundedTotal = refunds.reduce((t, r) => t + Number(r.totalRefunded || 0), 0);
  const profAdj = prof - (refundedTotal - refundedCost);
  ok('profit = 740 - 375 = 365', profAdj === 365);

  const cogs = rev - profAdj;
  ok('COGS = 280', cogs === 280);

  console.log(`  Revenue: ${rev}, Discount: ${disc}, Orders: ${ordCnt}, Profit: ${profAdj}, COGS: ${cogs}`);
} catch (e) {
  ok('PDF scenario 1 calculations', false, e.message);
}

await resetDb();

section('PDF Export - Scenario 2: Verify invoice line split by batch price');

try {
  const pid = await createProductWithStock({
    id: 'p-pdf-3',
    name: 'منتج فواتير',
    category: 'اختبار',
    price: 100,
    costPrice: 40,
    variants: [{ size: 'L', color: 'أزرق', quantity: 10 }],
    barcode: '1234567890148'
  });

  // Restock 10 at new price 120 (cost 50)
  await db.restockProduct({
    productId: pid,
    productName: 'منتج فواتير',
    lines: [{ size: 'L', color: 'أزرق', qty: 10 }],
    unitCost: 50,
    newPrice: 120,
    supplierId: '',
    supplierName: 'مورد',
    date: '2026-10-01'
  });

  const product = await db.get(db.STORES.products, pid);
  const variantId = product.variants[0].id;

  const { createSale } = await import(js('db.js'));
  
  // Sell 15: 10 from old batch (price 100) + 5 from new batch (price 120)
  await createSale({
    items: [{
      productId: pid,
      name: 'منتج فواتير',
      qty: 15,
      price: 120, // input price
      size: 'L',
      color: 'أزرق',
      costPrice: 40,
      variantId
    }],
    paymentMethod: 'cash',
    customerName: 'عميل فواتير',
    timestamp: '2026-10-03T10:00:00.000Z'
  });

  const sales = await db.listSales();
  const mySale = sales[0];

  // Sale should be split into 2 lines by batch selling price
  ok('sale has 2 lines (split by batch price)', mySale.items.length === 2);
  
  const line1 = mySale.items[0];
  const line2 = mySale.items[1];
  
  // One line at price 100 (old batch), one at 120 (new batch)
  const prices = [line1.price, line2.price].sort((a, b) => a - b);
  ok('lines have correct prices [100, 120]', JSON.stringify(prices) === JSON.stringify([100, 120]));

  // Quantities: 10 at old price, 5 at new price
  const qtys = [line1.qty, line2.qty].sort((a, b) => a - b);
  ok('lines have correct quantities [5, 10]', JSON.stringify(qtys) === JSON.stringify([5, 10]));

  // Total = 10*100 + 5*120 = 1000 + 600 = 1600
  ok('sale total = 1600', mySale.total === 1600);

  // Cost total = 10*40 + 5*50 = 400 + 250 = 650
  const totalCost = mySale.items.reduce((sum, it) => sum + (it.costTotal || 0), 0);
  ok('sale cost total = 650', totalCost === 650);
} catch (e) {
  ok('PDF scenario 2 invoice lines', false, e.message);
}

await resetDb();

section('PDF Export - Scenario 3: No-size product in invoice (no initial batch)');

try {
  const pid = await createProductWithStock({
    id: 'p-pdf-4',
    name: 'عطر فاتورة',
    category: 'عطور',
    price: 150,
    costPrice: 60,
    variants: [], // Empty - no initial stock batch created
    barcode: '1234567890149'
  });

  await db.restockProduct({
    productId: pid,
    productName: 'عطر فاتورة',
    lines: [{ size: '', color: '', qty: 10 }],
    unitCost: 65,
    newPrice: 160, // First batch sellingPrice
    supplierId: '',
    supplierName: 'مورد',
    date: '2026-10-01'
  });

  const product = await db.get(db.STORES.products, pid);
  const variantId = product.variants[0].id;

  const { createSale } = await import(js('db.js'));
  await createSale({
    items: [{
      productId: pid,
      name: 'عطر فاتورة',
      qty: 2,
      price: 160,
      size: '',
      color: '',
      costPrice: 65,
      variantId
    }],
    paymentMethod: 'cash',
    customerName: 'عميل عطر',
    timestamp: '2026-10-03T10:00:00.000Z'
  });

  const sales = await db.listSales();
  const mySale = sales[0];

  ok('no-size sale has 1 line', mySale.items.length === 1);
  ok('line has empty size', mySale.items[0].size === '');
  ok('line has empty color', mySale.items[0].color === '');
  // First restock creates the variant AND batch with newPrice as sellingPrice
  ok('line price = batch sellingPrice (160 from restock)', mySale.items[0].price === 160);
  ok('line qty = 2', mySale.items[0].qty === 2);
  // total = 2 * 160 = 320
  ok('sale total = 320', mySale.total === 320);
} catch (e) {
  ok('PDF scenario 3 no-size invoice', false, e.message);
}

await resetDb();

section('PDF Export - Scenario 4: Refund deletes sale');

try {
  const pid = await createProductWithStock({
    id: 'p-pdf-5',
    name: 'منتج مرتجع',
    category: 'اختبار',
    price: 100,
    costPrice: 40,
    variants: [{ size: 'M', color: 'أخضر', quantity: 20 }],
    barcode: '1234567890150'
  });

  const product = await db.get(db.STORES.products, pid);
  const variantId = product.variants[0].id;

  const { createSale, refundSale, listSales } = await import(js('db.js'));

  // Sale 1: 5 items
  await createSale({
    items: [{ productId: pid, name: 'منتج مرتجع', qty: 5, price: 100, size: 'M', color: 'أخضر', costPrice: 40, variantId }],
    paymentMethod: 'cash',
    customerName: 'عميل',
    timestamp: '2026-10-04T10:00:00.000Z'
  });

  // Sale 2: 3 items (to be refunded/deleted)
  await createSale({
    items: [{ productId: pid, name: 'منتج مرتجع', qty: 3, price: 100, size: 'M', color: 'أخضر', costPrice: 40, variantId }],
    paymentMethod: 'cash',
    customerName: 'عميل 2',
    timestamp: '2026-10-04T11:00:00.000Z'
  });

  let sales = await listSales();
  ok('2 sales before refund', sales.length === 2);
  
  const sale2 = sales.find(s => s.items[0].qty === 3);
  await refundSale(sale2.id);

  sales = await listSales();
  ok('2 sales after refund (sale STAYS for audit)', sales.length === 2);
  ok('remaining sale has qty 5', sales.find(s => s.items[0].qty === 5) !== undefined);

  const { revenue, discountGiven, orderCount, profit } = await import(js('analytics.js'));
  const { listRefunds } = await import(js('db.js'));
  const refunds = await listRefunds();
  const completedSales = sales;

  // Sale1 stays (500, cost 200), Sale2 is refunded (300, cost 120)
  // Revenue = 800 - 300 refund = 500
  ok('revenue excludes refunded sale (800 - 300 = 500)', revenue(completedSales) - Number(refunds[0].totalRefunded) === 500);
  ok('refund record exists', refunds.length === 1);
  ok('refund total = 300', Number(refunds[0].totalRefunded) === 300);

  // Profit: sale1 profit 300 + sale2 profit 180 = 480; subtract refunded profit (300-120=180)
  // Net profit = 480 - 180 = 300
  const refundedCost = refunds.reduce((t, r) => t + Number(r.costTotalRefunded || 0), 0);
  const refundedProfit = Number(refunds[0].totalRefunded) - refundedCost;
  ok('profit = 480 - 180 = 300', profit(completedSales) - refundedProfit === 300);
} catch (e) {
  ok('PDF scenario 4 refund deletes sale', false, e.message);
}

/* =================================================================== *
 * Mutation proofs - verify tests detect broken calculations
 * =================================================================== */
console.log('\n\n=== Mutation Proofs ===\n');

await resetDb();

section('Mutation: profit calculation uses FIFO costs');

try {
  const pid = await createProductWithStock({
    id: 'p-mut-pdf-1',
    name: 'منتج طفرة ربح',
    category: 'اختبار',
    price: 100,
    costPrice: 40,
    variants: [{ size: 'M', color: 'أحمر', quantity: 10 }],
    barcode: '1234567890151'
  });

  await db.restockProduct({
    productId: pid,
    productName: 'منتج طفرة ربح',
    lines: [{ size: 'M', color: 'أحمر', qty: 10 }],
    unitCost: 50,
    newPrice: 110,
    supplierId: '',
    supplierName: 'مورد',
    date: '2026-10-01'
  });

  const product = await db.get(db.STORES.products, pid);
  const variantId = product.variants[0].id;

  const { createSale } = await import(js('db.js'));
  await createSale({
    items: [{ productId: pid, name: 'منتج طفرة ربح', qty: 10, price: 110, size: 'M', color: 'أحمر', costPrice: 40, variantId }],
    paymentMethod: 'cash',
    customerName: 'عميل',
    timestamp: '2026-10-05T10:00:00.000Z'
  });

  const sales = await db.listSales();
  const mySale = sales[0];

  // If broken: profit would use product.costPrice (50) instead of FIFO
  // Correct: 10 from old batch at cost 40 = 400 cost
  // Broken: 10 at cost 50 = 500 cost
  const totalCost = mySale.items.reduce((sum, it) => sum + (it.costTotal || 0), 0);
  ok('costTotal uses FIFO (400), not product.costPrice (500)', totalCost === 400);
} catch (e) {
  ok('mutation: FIFO profit', false, e.message);
}

await resetDb();

section('Mutation: refunded sales excluded from revenue (deleted)');

try {
  const pid = await createProductWithStock({
    id: 'p-mut-pdf-2',
    name: 'منتج طفرة مرتجع',
    category: 'اختبار',
    price: 100,
    costPrice: 40,
    variants: [{ size: 'S', color: 'أزرق', quantity: 20 }],
    barcode: '1234567890152'
  });

  const product = await db.get(db.STORES.products, pid);
  const variantId = product.variants[0].id;

  const { createSale, refundSale, listSales } = await import(js('db.js'));

  await createSale({
    items: [{ productId: pid, name: 'منتج طفرة مرتجع', qty: 5, price: 100, size: 'S', color: 'أزرق', costPrice: 40, variantId }],
    paymentMethod: 'cash',
    customerName: 'عميل',
    timestamp: '2026-10-06T10:00:00.000Z'
  });

  await createSale({
    items: [{ productId: pid, name: 'منتج طفرة مرتجع', qty: 3, price: 100, size: 'S', color: 'أزرق', costPrice: 40, variantId }],
    paymentMethod: 'cash',
    customerName: 'عميل 2',
    timestamp: '2026-10-06T11:00:00.000Z'
  });

  const sales = await listSales();
  const sale2 = sales.find(s => s.items[0].qty === 3);
  await refundSale(sale2.id);

  const allSales = await listSales();
  const { revenue } = await import(js('analytics.js'));
  const { listRefunds } = await import(js('db.js'));
  const refunds = await listRefunds();

  // Sale1: 500, Sale2: 300 refunded.
  // Revenue = 800 - 300 refund = 500
  ok('revenue excludes refunded amount (800 - 300 = 500)', revenue(allSales) - Number(refunds[0].totalRefunded) === 500);
} catch (e) {
  ok('mutation: refunded deleted', false, e.message);
}

await resetDb();

section('Mutation: discount subtracted from subtotal (batch prices)');

try {
  const pid = await createProductWithStock({
    id: 'p-mut-pdf-3',
    name: 'منتج طفرة خصم',
    category: 'اختبار',
    price: 100,
    costPrice: 40,
    variants: [{ size: 'L', color: 'أخضر', quantity: 20 }],
    barcode: '1234567890153'
  });

  const product = await db.get(db.STORES.products, pid);
  const variantId = product.variants[0].id;

  const { createSale } = await import(js('db.js'));
  await createSale({
    items: [{ productId: pid, name: 'منتج طفرة خصم', qty: 10, price: 100, size: 'L', color: 'أخضر', costPrice: 40, variantId }],
    paymentMethod: 'cash',
    customerName: 'عميل',
    discountValue: 50, // 5% discount
    timestamp: '2026-10-07T10:00:00.000Z'
  });

  const sales = await db.listSales();
  const { revenue, discountGiven } = await import(js('analytics.js'));
  const completedSales = sales;

  // Sale uses old batch sellingPrice 100
  // subtotal = 10 * 100 = 1000
  // discount = 50 (fixed)
  // total = 950
  ok('subtotal = 1000 (batch price 100)', sales[0].subtotal === 1000);
  ok('discount = 50', discountGiven(completedSales) === 50);
  ok('total = 950', revenue(completedSales) === 950);
  ok('netSales = revenue (already after discount) = 950', revenue(completedSales) === 950);
} catch (e) {
  ok('mutation: discount in netSales', false, e.message);
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