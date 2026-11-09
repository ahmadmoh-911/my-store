/**
 * Store Hub — the POS screen must see stock changes immediately.
 *
 *   node tests/pos-refresh.test.mjs
 *
 * ─────────────────────────────────────────────────────────────────────────
 * What this file is for
 * ─────────────────────────────────────────────────────────────────────────
 * The owner adds a product (or restocks one), then walks to «بيع جديد» —
 * and the new quantity must be sellable right there, without closing the
 * app. The POS screen keeps a module-level cache (pos.js `cache`), and that
 * cache used to be loaded on the very first open and then served forever:
 * `invalidateCache()` existed but nothing called it. These tests pin the
 * fix from both sides:
 *
 *   • the exported invalidation (`pos.invalidateCache()`) really makes the
 *     next read pick up what was just written to IndexedDB;
 *   • the window event `storehub:products-changed` (fired by products.js
 *     `invalidate()`, which the product form, the restock sheet and the
 *     checkout all reach) drives that invalidation through the real
 *     module-level listener registered by pos.js;
 *   • the database itself answers a fresh `listProducts()` immediately
 *     after `saveProduct()` / `restockProduct()` — the shelf's source of
 *     truth must never lag the write.
 *
 * Node has no DOM, so the test stubs the two globals the wiring touches:
 * `window` (an EventTarget — the listener is registered on it at module
 * load) and `document` (paintProducts() no-ops when #screen-pos is not
 * mounted, which the stub's always-null getElementById guarantees).
 *
 * Zero dependencies: the project has no node_modules and must not grow one.
 */

import { createFakeIndexedDB } from './fake-indexeddb.mjs';

globalThis.indexedDB = createFakeIndexedDB();
globalThis.window = new EventTarget();
globalThis.document = { getElementById: () => null };

const js = (rel) => new URL(`../js/${rel}`, import.meta.url).href;

/* ------------------------------------------------------------------ *
 * Tiny runner (same shape as the other suites)
 * ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
const failures = [];

function ok(label, condition, detail = '') {
  if (condition) {
    passed++;
    return;
  }
  failed++;
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ''}`);
}

function eq(label, actual, expected) {
  ok(label, Object.is(actual, expected), `expected ${expected}, got ${actual}`);
}

function section(title) {
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------------ *
 * The real modules, in the order the app loads them
 * ------------------------------------------------------------------ */

// router.js FIRST: the screens and the router import each other, so loading
// pos.js alone trips over the half-initialised binding ("posScreen before
// initialisation"). Loading the router resolves the cycle exactly as the
// app's entry point does.
await import(js('router.js'));

const db = await import(js('db.js'));
const pos = await import(js('screens/pos.js'));
const products = await import(js('screens/products.js'));

async function resetDb() {
  for (const name of Object.values(db.STORES)) await db.clearStore(name);
}

const saveProduct = (id, name, qty) =>
  db.saveProduct({
    id, name, sku: '', category: 'غير مصنف', description: '',
    price: 20, costPrice: 8, image: '',
    variants: [{ size: 'M', color: 'أحمر', quantity: qty }],
    createdAt: new Date().toISOString(),
  });

/* ================================================================== *
 * 1 · a saved product reaches the till the moment the cache is dropped
 * ================================================================== */

await resetDb();
await saveProduct('p-a', 'المنتج الأول', 5);
await pos.ensureCache(); // prime the cache as a first POS visit would

section('1 · حفظ منتج جديد ثم قراءة قائمة المنتجات فورًا');

await saveProduct('p-b', 'المنتج الجديد', 7);

const freshDbList = await db.listProducts();
eq('قائمة المنتجات من قاعدة البيانات تُظهر المنتجين فورًا', freshDbList.length, 2);
eq('كمية المنتج الجديد في قاعدة البيانات = 7',
  freshDbList.find((p) => p.id === 'p-b')?.variants[0].quantity, 7);

// Without invalidation the POS cache still serves the load from before the
// save — this is the bug being guarded against, documented as behaviour.
const stale = await pos.ensureCache();
eq('قبل الإبطال: الكاش القديم لا يعرف المنتج الجديد (العطل الموثّق)', stale.products.length, 1);

pos.invalidateCache();
const refreshed = await pos.ensureCache();
eq('بعد إبطال الكاش: المنتج الجديد يظهر في شاشة البيع', refreshed.products.length, 2);
eq('وكميته كما حُفظت (7)',
  db.stockOf(refreshed.products.find((p) => p.id === 'p-b')), 7);

/* ================================================================== *
 * 2 · the storehub:products-changed event drives the invalidation
 * ================================================================== */

section('2 · حدث storehub:products-changed يعيد تحميل كاش شاشة البيع');

// Back to a cache that only knows p-a and p-b…
pos.invalidateCache();
await pos.ensureCache();

await saveProduct('p-c', 'المنتج الثالث', 3);
eq('قبل الحدث: الكاش ما زال قديمًا', (await pos.ensureCache()).products.length, 2);

// The real listener registered by pos.js at module load, on the window stub.
window.dispatchEvent(new Event(products.PRODUCTS_CHANGED_EVENT));

const afterEvent = await pos.ensureCache();
eq('بعد الحدث: المنتج الجديد ظهر في كاش شاشة البيع', afterEvent.products.length, 3);
eq('وكميته 3', db.stockOf(afterEvent.products.find((p) => p.id === 'p-c')), 3);

// The restock path: quantities written by restockProduct must reach the till
// through the same event — restock lands via the inventory screen's onDone,
// which calls products.invalidate().
const beforeRestock = db.stockOf(afterEvent.products.find((p) => p.id === 'p-a'));
await db.restockProduct({
  productId: 'p-a', productName: 'المنتج الأول', unitCost: 2,
  lines: [{ size: 'M', color: 'أحمر', qty: 4 }],
});
window.dispatchEvent(new Event(products.PRODUCTS_CHANGED_EVENT));

const afterRestock = await pos.ensureCache();
const restocked = afterRestock.products.find((p) => p.id === 'p-a');
eq('بعد تجديد المخزون والحدث: الكمية ارتفعت فورًا', db.stockOf(restocked), beforeRestock + 4);

/* ================================================================== *
 * 3 · products.js invalidate() clears its cache and fires the event
 * ================================================================== */

section('3 · products.js invalidate() يطلق الحدث الموعود');

let fired = 0;
const spy = () => fired++;
window.addEventListener(products.PRODUCTS_CHANGED_EVENT, spy);

products.invalidate();
eq('invalidate() أطلق الحدث مرة واحدة', fired, 1);

products.invalidate();
eq('كل استدعاء يطلق الحدث مرة', fired, 2);

window.removeEventListener(products.PRODUCTS_CHANGED_EVENT, spy);

/* ------------------------------------------------------------------ *
 * Run summary
 * ------------------------------------------------------------------ */

console.log(`\n${'='.repeat(56)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log('='.repeat(56));

process.exitCode = failed === 0 ? 0 : 1;
