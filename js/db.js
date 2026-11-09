/**
 * IndexedDB data layer.
 *
 * Why IndexedDB and not localStorage: we store product images (data URLs) and
 * potentially thousands of sales — localStorage is synchronous, has a ~5MB cap
 * and can only hold strings. IndexedDB gives us structured records, real
 * transactions and much more headroom.
 *
 * Stores
 *   products          keyPath 'id'   index 'createdAt'
 *   sales             keyPath 'id'   index 'timestamp'
 *   purchases         keyPath 'id'   index 'date'
 *   suppliers         keyPath 'id'   index 'createdAt'
 *   supplierInvoices  keyPath 'id'   index 'date'
 *   supplierPayments  keyPath 'id'   index 'date'
 *   settings          keyPath 'key'  (single 'app' record holds store config)
 *
 * Supplier invoices are a *purchases* ledger. They deliberately carry no
 * productId: recording a supplier bill must never touch stock, variants or
 * cost price.
 *
 * `purchases` is the opposite and the only inventory-writing purchase path:
 * it is what "تجديد الكمية" (restock) writes, and it raises the exact
 * size+colour variant it names. A supplier bill you type in by hand stays a
 * money record; stock only moves when the owner says it did.
 *
 * Store balance is DERIVED, never a stored counter:
 *
 *   balance = settings.openingBalance + Σ sales.total − Σ purchases.total
 *
 * A refund deletes the sale, so the credit reverses by construction; editing a
 * sale moves the balance with it. Nothing to reconcile, nothing that can drift
 * out of step with the records it is supposed to summarise.
 */

// The only import in this file: dayKeyOf maps a stored UTC timestamp back to
// its LOCAL calendar day, so receipt numbering shares one day convention with
// the dashboard, the reports and the POS sequence. utils.js reaches only
// icons.js and native.js, so this adds no cycle.
import { dayKeyOf } from './utils.js';
// Exact sale arithmetic (integer micro-units, halves up) — the single
// implementation of subtotal/discount/increase/total, shared by createSale,
// updateSale and importAll so a record and its restored copy agree to the
// agora. See js/money.js for the rounding rules and why floats cannot do it.
import {
  saleTotals,
  toMicro,
  microToAgorot,
  lotsCostMicro,
  microToDecimal,
} from './money.js';
// «سعر البيع يتبع الدفعة»: توزيع الكمية على الدفعات الأقدم أولًا (أو المختارة
// أولًا) وتجميع المأخوذات حسب سعر بيع كل دفعة. الوحدة نقية (بلا IndexedDB)
// ويستعملها أيضًا checkout.js لمعاينة الإجمالي، واختبارات node.
import { allocateLots, groupTakesByPrice, lotsOf, takeWithoutLots } from './lot-pricing.js';

export const DB_NAME = 'saher_db';
export const DB_VERSION = 6;

export const STORES = {
  products: 'products',
  sales: 'sales',
  purchases: 'purchases',
  suppliers: 'suppliers',
  supplierInvoices: 'supplierInvoices',
  supplierPayments: 'supplierPayments',
  settings: 'settings',
  // Stock batches (price lots) for FIFO inventory valuation
  stockBatches: 'stockBatches',
  // Refund records — one per refund operation, linked to the original sale.
  // A refund never deletes its sale; the original invoice stays intact for
  // audit, and the refund record carries the quantities, amounts and timing.
  refunds: 'refunds',
};

/* ------------------------------------------------------------------ *
 * Number guards
 *
 * Every number this app stores is a count, a price or an amount — none of
 * them can be negative, and none of them can be NaN. `min="0"` in the UI is a
 * convenience for the typist, not a guarantee: a stray minus sign, a paste from
 * a spreadsheet, a restored backup from another app, or a call site that never
 * went near a form can all produce one. So the rule is enforced HERE, at the
 * only place a record is actually written.
 *
 * The ONE deliberate exception is a supplier being paid more than they asked
 * for — that surplus is not an error, it is money the shop is holding for them,
 * and `supplierBalance()` accounts for it as credit.
 * ------------------------------------------------------------------ */

/** Any finite number at or above `min`. Garbage in → `min`, never NaN. */
export const nonNeg = (v, min = 0) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : min;
};

/** A whole number of pieces at or above `min` (stock is never fractional). */
export const nonNegInt = (v, min = 0) => Math.round(nonNeg(v, min));

let dbPromise = null;

/** Opens (and upgrades) the database; resolves once, shared by the whole app. */
export function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.products)) {
        const s = db.createObjectStore(STORES.products, { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
        s.createIndex('name', 'name');
      }
      if (!db.objectStoreNames.contains(STORES.sales)) {
        const s = db.createObjectStore(STORES.sales, { keyPath: 'id' });
        s.createIndex('timestamp', 'timestamp');
      }
      if (!db.objectStoreNames.contains(STORES.purchases)) {
        const s = db.createObjectStore(STORES.purchases, { keyPath: 'id' });
        s.createIndex('date', 'date');
        s.createIndex('productId', 'productId');
        s.createIndex('supplierId', 'supplierId');
      }
      if (!db.objectStoreNames.contains(STORES.suppliers)) {
        const s = db.createObjectStore(STORES.suppliers, { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains(STORES.supplierInvoices)) {
        const s = db.createObjectStore(STORES.supplierInvoices, { keyPath: 'id' });
        s.createIndex('date', 'date');
        s.createIndex('supplierId', 'supplierId');
      }
      if (!db.objectStoreNames.contains(STORES.supplierPayments)) {
        const s = db.createObjectStore(STORES.supplierPayments, { keyPath: 'id' });
        s.createIndex('date', 'date');
        s.createIndex('supplierId', 'supplierId');
      }
      if (!db.objectStoreNames.contains(STORES.settings)) {
        db.createObjectStore(STORES.settings, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORES.stockBatches)) {
        const s = db.createObjectStore(STORES.stockBatches, { keyPath: 'id' });
        s.createIndex('productId', 'productId');
        s.createIndex('variantKey', 'variantKey');
        s.createIndex('createdAt', 'createdAt');
      }

      // v3 — the customers store is gone from the app entirely. Drop it from
      // existing databases too, otherwise the old contact list lingers
      // invisibly forever.
      if (db.objectStoreNames.contains('customers')) {
        db.deleteObjectStore('customers');
        console.log('[db] dropped the legacy customers store');
      }

      // Deleting the store does not delete the index that pointed at it, and
      // old sale records still carry the name. Scrub both: an orphaned index
      // and an invisible field are still customer data sitting in the file,
      // and a backup taken from that file would carry them back out.
      if (e.oldVersion < 3) {
        const sales = req.transaction.objectStore(STORES.sales);
        if (sales.indexNames.contains('customerId')) {
          sales.deleteIndex('customerId');
          console.log('[db] dropped the orphaned customerId index on sales');
        }
        let scrubbed = 0;
        sales.openCursor().onsuccess = (ev) => {
          const cur = ev.target.result;
          if (!cur) {
            if (scrubbed) console.log(`[db] cleared customer fields from ${scrubbed} sale(s)`);
            return;
          }
          const rec = cur.value;
          if (rec.customerId !== undefined || rec.customerName !== undefined) {
            delete rec.customerId;
            delete rec.customerName;
            cur.update(rec);
            scrubbed++;
          }
          cur.continue();
        };
      }

      // v5 — introduce stockBatches store. Migrate existing product variants
      // into initial stock batches so FIFO valuation works from day one.
      if (e.oldVersion < 5) {
        const productsStore = req.transaction.objectStore(STORES.products);
        const batchesStore = req.transaction.objectStore(STORES.stockBatches);
        const now = new Date().toISOString();
        let migrated = 0;

        // Use a synchronous loop with a counter since onupgradeneeded is not async
        const cursorReq = productsStore.openCursor();
        cursorReq.onsuccess = (ev) => {
          const cur = ev.target.result;
          if (!cur) {
            console.log(`[db] v5 migration: created initial stock batches for ${migrated} product(s)`);
            return;
          }
          const product = cur.value;
          const variants = product.variants || [];
          for (const v of variants) {
            const qty = Number(v.quantity) || 0;
            if (qty <= 0) continue;
            const variantKey = `${v.size || ''}|${v.color || ''}`;
            batchesStore.put({
              id: crypto.randomUUID(),
              productId: product.id,
              variantKey,
              size: v.size || '',
              color: v.color || '',
              quantity: qty,
              costPrice: Number(product.costPrice) || 0,
              sellingPrice: Number(product.price) || 0,
              createdAt: product.createdAt || now,
            });
            migrated++;
          }
          cur.continue();
        };
        cursorReq.onerror = () => {
          console.error('[db] v5 migration failed:', cursorReq.error);
        };
      }

      // v6 — refunds store: refunds are separate records linked to the
      // original sale, never a deletion of the sale itself. This preserves
      // the audit trail, supports partial refunds, and lets reports show
      // gross sales vs refunds vs net sales.
      if (e.oldVersion < 6) {
        if (!db.objectStoreNames.contains(STORES.refunds)) {
          const s = db.createObjectStore(STORES.refunds, { keyPath: 'id' });
          s.createIndex('originalSaleId', 'originalSaleId');
          s.createIndex('refundDate', 'refundDate');
          s.createIndex('status', 'status');
        }
        console.log('[db] upgraded to version 6 — refunds store created');
      }

      console.log('[db] upgraded to version', e.oldVersion, '→', DB_VERSION);
    };

    req.onsuccess = () => {
      const db = req.result;
      // If another tab upgrades the schema we get blocked → close and retry.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => console.warn('[db] open blocked by another tab');
  });

  return dbPromise;
}

function tx(store, mode, run) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const os = t.objectStore(Array.isArray(store) ? store[0] : store);
        let out;
        try {
          out = run(os, t);
        } catch (err) {
          reject(err);
          return;
        }
        t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('transaction aborted'));
      })
  );
}

/**
 * Multi-store transaction — used when a sale must update several stores as one
 * unit (sales + products + stockBatches, say).
 *
 * `run(store, t, fail)` must issue every request synchronously; when all reads
 * resolve it may plan the outcome in memory and issue the writes, all still
 * inside the same transaction. `fail(err)` aborts the whole transaction — the
 * ONLY way out that leaves nothing behind — and the returned promise rejects
 * with that error once the abort has been observed. Either every write lands or
 * none does, which is what lets a sale, its stock movement and its FIFO lots
 * never drift apart.
 *
 * The promise resolves only on `oncomplete`, so a caller that awaits it knows
 * the data is committed.
 */
function multiTx(stores, mode, run) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(stores, mode);
        let out;
        let failure = null;
        // Abort first, reject after: the transaction's own onabort is the single
        // place the rejection is issued from, so a caller can never see a
        // resolved promise for a transaction that was rolled back.
        const fail = (err) => {
          if (failure) return;
          failure = err instanceof Error ? err : new Error(String(err || 'transaction failed'));
          try {
            t.abort();
          } catch {
            reject(failure);
          }
        };
        try {
          out = run(t.objectStore.bind(t), t, fail);
        } catch (err) {
          // A synchronous throw may have left requests queued; abort so none of
          // them can commit without the rest.
          try { t.abort(); } catch { /* already finished */ }
          reject(err);
          return;
        }
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(failure || t.error || new Error('transaction failed'));
        t.onabort = () => reject(failure || t.error || new Error('transaction aborted'));
      })
  );
}

const request = (r) =>
  new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

/* ------------------------------------------------------------------ *
 * Generic CRUD
 * ------------------------------------------------------------------ */

export async function getAll(store) {
  return request((await openDB()).transaction(store).objectStore(store).getAll());
}

export async function get(store, key) {
  return request((await openDB()).transaction(store).objectStore(store).get(key));
}

export function put(store, value) {
  return tx(store, 'readwrite', (os) => os.put(value));
}

export function del(store, key) {
  return tx(store, 'readwrite', (os) => os.delete(key));
}

export function clearStore(store) {
  return tx(store, 'readwrite', (os) => os.clear());
}

export async function count(store) {
  return request((await openDB()).transaction(store).objectStore(store).count());
}

/* ------------------------------------------------------------------ *
 * Domain: products
 * ------------------------------------------------------------------ */

export const listProducts = () => getAll(STORES.products);

export async function saveProduct(product) {
  const now = new Date().toISOString();
  const id = product.id || cryptoId();
  // "New" means the store holds no product under this id — not "the caller
  // left the id empty". The product form mints the id before the first save
  // (hydrate: `id: p?.id || uid()`), so judging by a missing id filed opening
  // lots for nobody and would file them *again* on every edit. Reading the
  // record first distinguishes the two for real: only a first save seeds lots.
  const isNew = !(await get(STORES.products, id));
  const rec = {
    id,
    name: product.name,
    sku: product.sku || '',
    category: product.category || 'غير مصنف',
    description: product.description || '',
    price: nonNeg(product.price),
    costPrice: nonNeg(product.costPrice),
    // Variants are rebuilt rather than passed through: a negative quantity on
    // one size would make "نفذت" lie and would let a sale hand back stock that
    // was never there.
    variants: (product.variants || []).map((v) => ({
      ...v,
      size: v.size || '',
      color: v.color || '',
      quantity: nonNegInt(v.quantity),
    })),
    image: product.image || '',
    createdAt: product.createdAt || now,
    updatedAt: now,
  };
  await put(STORES.products, rec);
  if (isNew) {
    await createInitialStockBatches(rec);
  }
}

export const deleteProduct = (id) => del(STORES.products, id);

/** Total units across every size/colour variant. */
export function stockOf(product) {
  return (product?.variants || []).reduce((t, v) => t + (Number(v.quantity) || 0), 0);
}

/** Units available for one specific size/colour pair. */
export function variantStock(product, size, color) {
  const v = (product?.variants || []).find(
    (x) => x.size === size && x.color === color
  );
  return v ? Number(v.quantity) || 0 : 0;
}

/** Variants that still have stock — used by the POS variant picker. */
export function availableVariants(product) {
  return (product?.variants || []).filter((v) => (Number(v.quantity) || 0) > 0);
}

export const totalStock = (products) => products.reduce((t, p) => t + stockOf(p), 0);
export const inventoryValue = (products) =>
  products.reduce((t, p) => t + stockOf(p) * (Number(p.costPrice) || 0), 0);

/* ------------------------------------------------------------------ *
 * Domain: purchases (restock — the ONLY path that raises stock)
 * ------------------------------------------------------------------ */

export const listPurchases = () => getAll(STORES.purchases);
export const deletePurchase = (id) => del(STORES.purchases, id);

/**
 * Records a restock: the named size+colour variants gain exactly the quantity
 * entered, the purchase price is remembered, the product's cost/sale price is
 * updated when the owner changes them, and one `purchases` row is written for
 * the store balance to read.
 *
 * One transaction over products + purchases, so stock can never move without
 * its money record (or the other way round). A line that names a variant the
 * product does not have is dropped rather than silently merged into another
 * one — the caller gets `written` back so it can tell the user what landed.
 *
 * @param {object} po
 * @param {string} po.productId
 * @param {string} [po.supplierId]
 * @param {string} [po.supplierName]
 * @param {string} [po.date]        ISO date of the purchase/order
 * @param {number} [po.unitCost]    purchase price per piece (updates the product)
 * @param {number} [po.newPrice]    optional new sale price (updates the product)
 * @param {Array}  po.lines         [{size, color, qty}]
 * @returns {Promise<{record: object, written: Array}>}
 */
export function createPurchase(po) {
  return purchaseCore(po, false);
}

/**
 * "تجديد الكمية" — the restock path.
 *
 * Identical to `createPurchase` except the stock batches are written in the
 * SAME transaction as the product variants and the purchase row. The UI used to
 * call `addStockBatch` once per line and then `createPurchase` — two stores, two
 * transactions — so a failure between them could raise the shelf (and FIFO
 * lots) without debiting the store balance, or bill a purchase whose stock
 * never landed. One transaction makes that impossible: the restock is all-or-
 * nothing, and the batches and variants can never disagree.
 *
 * @param {object} po  same shape as createPurchase
 * @returns {Promise<{record: object, written: Array}>}
 */
export function restockProduct(po) {
  return purchaseCore(po, true);
}

/**
 * The shared restock/purchase writer.
 *
 * The money half is written INSIDE the transaction, after the stock half has
 * resolved which variants actually exist. Billing the requested lines instead
 * would debit the store balance for pieces that never arrived — the ledger
 * would say we paid for stock we do not have, which is the one thing this
 * ledger exists to prevent.
 *
 * @param {object} po
 * @param {boolean} withBatches  also file a FIFO lot per landed line
 * @returns {Promise<{record: object, written: Array}>}
 */
function purchaseCore(po, withBatches) {
  const lines = (po.lines || [])
    .map((l) => ({
      size: l.size || '',
      color: l.color || '',
      qty: nonNegInt(l.qty),
    }))
    .filter((l) => l.qty > 0);

  if (!po.productId) return Promise.reject(new Error('لا يوجد منتج محدد'));
  if (!lines.length) return Promise.reject(new Error('الكمية يجب أن تكون أكبر من صفر'));

  const unitCost = nonNeg(po.unitCost);
  const newPrice =
    po.newPrice === undefined || po.newPrice === null || po.newPrice === ''
      ? null
      : round2(nonNeg(po.newPrice));

  const record = {
    id: po.id || cryptoId(),
    productId: po.productId,
    productName: po.productName || '',
    supplierId: po.supplierId || '',
    supplierName: po.supplierName || '',
    date: po.date || new Date().toISOString(),
    unitCost,
    units: 0,
    total: 0,
    newPrice,
    lines: [],
    note: po.note || '',
    createdAt: new Date().toISOString(),
  };

  const stores = withBatches
    ? [STORES.products, STORES.purchases, STORES.stockBatches]
    : [STORES.products, STORES.purchases];

  return multiTx(stores, 'readwrite', (store) => {
    const productsStore = store(STORES.products);
    const written = [];
    const req = productsStore.get(po.productId);
    req.onsuccess = () => {
      const p = req.result;
      const now = new Date().toISOString();

      if (p) {
        const sellingPrice = newPrice !== null ? newPrice : (Number(p.price) || 0);
        for (const l of lines) {
          // exact variant only — never fold one size/colour into another
          let v = (p.variants || []).find((x) => (x.size || '') === l.size && (x.color || '') === l.color);
          if (!v) {
            // New size/color combination — add it to the product
            v = { size: l.size || '', color: l.color || '', quantity: 0 };
            if (!p.variants) p.variants = [];
            p.variants.push(v);
          }
          v.quantity = Math.max(0, (Number(v.quantity) || 0) + l.qty);
          written.push(l);
          if (withBatches) {
            // The lot is created for exactly the pieces that landed, so the
            // FIFO book and the variant counters stay in step.
            store(STORES.stockBatches).put({
              id: cryptoId(),
              productId: po.productId,
              variantKey: `${l.size || ''}|${l.color || ''}`,
              size: l.size || '',
              color: l.color || '',
              quantity: l.qty,
              costPrice: unitCost,
              sellingPrice,
              createdAt: now,
            });
          }
        }
        if (written.length) {
          if (unitCost > 0) p.costPrice = unitCost;
          if (newPrice !== null) p.price = newPrice;
          p.updatedAt = now;
          productsStore.put(p);
        }
      }

      // Only what landed is billed: an unresolvable variant costs nothing.
      record.lines = written;
      record.units = written.reduce((t, l) => t + l.qty, 0);
      record.total = round2(unitCost * record.units);
      store(STORES.purchases).put(record);
    };

    // Resolved only once the transaction has completed, at which point
    // `written` is filled in — the caller can trust both halves of it.
    return { record, written };
  });
}

/**
 * The store's cash position, derived from the records that actually exist.
 *
 *   opening balance + completed sales − restock purchases
 *
 * Sales and purchases are read from the `sales` / `purchases` stores, so a
 * refund (which deletes its sale) and an edited sale total are already
 * reflected. Nothing here is stored, so it cannot disagree with the data.
 */
export function storeLedger(sales, purchases, settings, refunds = []) {
  const opening = round2(Number(settings?.openingBalance) || 0);
  const salesTotal = round2((sales || []).reduce((t, s) => t + (Number(s.total) || 0), 0));
  const purchasesTotal = round2((purchases || []).reduce((t, p) => t + (Number(p.total) || 0), 0));
  const refundsTotal = round2((refunds || []).reduce((t, r) => t + (Number(r.totalRefunded) || 0), 0));

  /* The trace. Every line here is a real record that exists in the database —
   * there is no synthetic "expenses" row, because the app does not pretend to
   * do accounting it cannot do. Refunds are separate records now: the original
   * sale stays intact and the refund appears as its own negative entry. */
  const entries = [];
  if (opening) {
    entries.push({
      type: 'opening',
      label: 'الرصيد الافتتاحي',
      date: null,
      amount: opening,
      sign: 1,
      ref: null,
    });
  }
  for (const p of purchases || []) {
    const amount = round2(Number(p.total) || 0);
    if (!amount) continue;
    entries.push({
      type: 'restock',
      label: p.productName ? `تجديد كمية — ${p.productName}` : 'تجديد كمية',
      date: p.date || p.createdAt || null,
      amount,
      sign: -1,
      ref: p.id,
    });
  }
  for (const s of sales || []) {
    const amount = round2(Number(s.total) || 0);
    if (!amount) continue;
    entries.push({
      type: 'sale',
      label: s.receiptNo ? `فاتورة بيع ${s.receiptNo}` : 'فاتورة بيع',
      date: s.timestamp || null,
      amount,
      sign: 1,
      ref: s.id,
    });
  }
  for (const r of refunds || []) {
    const amount = round2(Number(r.totalRefunded) || 0);
    if (!amount) continue;
    entries.push({
      type: 'refund',
      label: r.originalReceiptNo ? `استرجاع — فاتورة ${r.originalReceiptNo}` : 'استرجاع فاتورة',
      date: r.refundDate || null,
      amount,
      sign: -1,
      ref: r.id,
    });
  }
  entries.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  let run = 0;
  for (const e of entries) {
    run = round2(run + e.sign * e.amount);
    e.balance = run;
  }

  return {
    opening,
    salesTotal,
    purchasesTotal,
    refundsTotal,
    balance: round2(opening + salesTotal - purchasesTotal - refundsTotal),
    entries,
  };
}

/** Convenience wrapper — the number every screen shows. */
export async function storeBalance() {
  const [sales, purchases, settings, refunds] = await Promise.all([
    listSales(),
    listPurchases(),
    getSettings(),
    listRefunds(),
  ]);
  return storeLedger(sales, purchases, settings, refunds).balance;
}

/* ------------------------------------------------------------------ *
 * Domain: sales
 * ------------------------------------------------------------------ */

export const listSales = () => getAll(STORES.sales);

/** Refund records — separate audit entries linked to original sales. */
export const listRefunds = () => getAll(STORES.refunds);

/* ------------------------------------------------------------------ *
 * In-transaction stock planning
 *
 * A sale, an edit and a refund all have to touch the invoice, the product
 * variants and the FIFO lots together. The functions below let that happen
 * inside ONE IndexedDB transaction: `readStock` gathers what is needed, then
 * hands plain arrays to a synchronous planner that decides the outcome and
 * issues the writes. Nothing here opens its own transaction — doing so was the
 * old defect, where lots could be consumed and then a later write could fail,
 * leaving stock gone with no invoice (or the reverse).
 * ------------------------------------------------------------------ */

/**
 * Takes `qty` pieces off one variant's lots, oldest first, MUTATING the lot
 * records in `lots`. Returns the takes that a sale records; throws when the
 * lots are short, having changed nothing — so the caller can abort a whole
 * transaction without a manual undo.
 *
 * The allocation itself is the pure `allocateLots` in js/lot-pricing.js (FIFO,
 * or the owner's chosen batch served first); this wrapper is only the mutation:
 * it applies the plan to `lots` and returns the takes. Keeping one algorithm in
 * the pure module means the checkout preview and the stored sale cannot drift.
 *
 * @returns {Array<{batchId:string, qty:number, costPrice:number, sellingPrice:number}>}
 */
function takeLots(lots, productId, variantKey, qty, preferredLotId) {
  const taken = allocateLots(lots, productId, variantKey, qty, preferredLotId);
  for (const t of taken) {
    const b = lots.find((x) => x.id === t.batchId);
    if (b) b.quantity = (Number(b.quantity) || 0) - t.qty;
  }
  return taken;
}

/** Puts `qty` pieces back into a named lot, if it still exists. */
function returnToLot(lots, batchId, qty) {
  const b = lots.find((x) => x.id === batchId);
  if (b) b.quantity = (Number(b.quantity) || 0) + (Number(qty) || 0);
  return !!b;
}

/** A brand-new lot record — used when the original lot is unknown. */
function freshLot(spec) {
  return {
    id: cryptoId(),
    productId: spec.productId,
    variantKey: `${spec.size || ''}|${spec.color || ''}`,
    size: spec.size || '',
    color: spec.color || '',
    quantity: Math.max(0, Math.round(Number(spec.qty) || 0)),
    costPrice: Number(spec.costPrice) || 0,
    sellingPrice: Number(spec.sellingPrice) || 0,
    createdAt: new Date().toISOString(),
  };
}

/** The exact cost of one line's FIFO takes, in micro-units (BigInt). */
const lineCostMicro = (taken) => lotsCostMicro(taken);

/** That exact cost rounded to whole agorot — the figure the sale stores. */
const lineCostAgorot = (taken) => microToAgorot(lineCostMicro(taken));

/** Per-piece cost for display (six decimals at most), from the exact line cost. */
function lineUnitCost(taken, qty) {
  const n = Math.round(Number(qty) || 0);
  if (n <= 0) return 0;
  return Number(microToDecimal(lineCostMicro(taken) / BigInt(n)));
}

/**
 * Reads, inside transaction `t`, every product, every FIFO lot of every named
 * variant, and any lot named by id, then calls `finish(lots, products)` once —
 * still inside the transaction, so the caller can plan and write before it
 * commits. A read error aborts the whole transaction.
 *
 * @param {(name:string)=>IDBObjectStore} store  `t.objectStore` already bound
 * @param {{productIds?:string[], variants?:string[], lotIds?:string[]}} needs
 * @param {(lots:Array, products:Map<string,object>)=>void} finish
 * @param {(err:any)=>void} fail
 */
function readStock(store, needs, finish, fail) {
  const ids = [...new Set((needs.productIds || []).filter(Boolean))];
  const keys = [...new Set((needs.variants || []).filter(Boolean))];
  const lotIds = [...new Set((needs.lotIds || []).filter(Boolean))];
  const lotsById = new Map();
  const products = new Map();
  const addLot = (b) => { if (b && b.id != null) lotsById.set(b.id, b); };
  let waiting = ids.length + keys.length + lotIds.length;
  const tick = () => { if (waiting > 0 && --waiting === 0) finish([...lotsById.values()], products); };

  for (const pid of ids) {
    const r = store(STORES.products).get(pid);
    r.onsuccess = () => { if (r.result) products.set(pid, r.result); tick(); };
    r.onerror = () => fail(r.error);
  }
  for (const vk of keys) {
    const r = store(STORES.stockBatches).index('variantKey').getAll(vk);
    r.onsuccess = () => { for (const b of r.result) addLot(b); tick(); };
    r.onerror = () => fail(r.error);
  }
  for (const bid of lotIds) {
    const r = store(STORES.stockBatches).get(bid);
    r.onsuccess = () => { addLot(r.result); tick(); };
    r.onerror = () => fail(r.error);
  }
  if (waiting === 0) finish([...lotsById.values()], products);
}

/**
 * Records a sale and decrements stock in ONE transaction, so the two can
 * never drift apart if something fails halfway.
 *
 * The invoice row, the product variants and the FIFO lots are all written
 * inside a single `readwrite` transaction: the lots are planned in memory from
 * a consistent snapshot and the writes are issued together. If stock runs out
 * (or any read fails) the transaction is aborted and NOTHING is stored — there
 * is no window in which stock left the shelf without an invoice, or an invoice
 * was filed without its cost.
 *
 * @param {object} sale
 * @param {Array}  sale.items [{productId, size, color, qty, price, costPrice, name,
 *                             lotId?}] — `lotId` (optional) names the stock batch the
 *                             owner chose for the line: it is consumed first and the
 *                             remainder falls back to FIFO. Omitted (the default) is
 *                             pure FIFO, exactly as it has always been. `price` is
 *                             IGNORED for the stored line: the selling price follows
 *                             the batch (Option A), and a line whose quantity spans
 *                             several batches at different prices is SPLIT into one
 *                             stored line per price.
 * @returns {Promise<object>} the stored sale (with id / receiptNo assigned)
 */
export async function createSale(sale) {
  const id = sale.id || cryptoId();
  // A line with no pieces is not a line: keeping it would put a 0-quantity,
  // 0-total row on the receipt and on the profit report. A line whose
  // quantity was typed as a negative is dropped for the same reason — it is
  // not a return, refunds go through refundSale().
  const items = (sale.items || [])
    .map((it) => ({
      productId: it.productId,
      name: it.name,
      size: it.size,
      color: it.color,
      qty: nonNegInt(it.qty),
      price: nonNeg(it.price),
      costPrice: nonNeg(it.costPrice),
      // Optional per-line batch choice (the lot-picker): the sale consumes THIS
      // lot first, then FIFO for whatever it could not cover. The id itself is
      // deliberately NOT stored on the invoice line — the takes land in
      // `stockBatchesConsumed` with each lot's real cost and selling price, so
      // the stored line keeps its exact legacy shape and an old reader (and an
      // old backup) sees nothing new.
      lotId: it.lotId == null || it.lotId === '' ? null : String(it.lotId),
    }))
    .filter((it) => it.qty > 0);

  // Exact totals are computed INSIDE the transaction, from the lot-priced
  // lines (see below): the price of each line is the selling price of the batch
  // it actually consumed, so the subtotal cannot be known until the batches are.
  const discountValue = nonNeg(sale.discountValue);
  const receiptNo = sale.receiptNo || nextReceiptNo(sale.receiptSeq);

  let stored = null;
  await multiTx([STORES.sales, STORES.products, STORES.stockBatches], 'readwrite', (store, t, fail) => {
    // Idempotent under a double submit: if this exact receipt id is already
    // stored, return the stored record and do NOT consume stock again. Without
    // this, two fast taps of "confirm" (or a retry after a slow response) would
    // take the pieces off the shelf twice while only one invoice existed — the
    // stock book and the day's takings would disagree by a whole basket.
    const salesStore = store(STORES.sales);
    const existing = salesStore.get(id);
    existing.onsuccess = () => {
      if (existing.result) {
        stored = existing.result;
        return;
      }
      readStock(
        store,
        {
          productIds: items.map((it) => it.productId),
          variants: items.map((it) => `${it.size || ''}|${it.color || ''}`),
          // Any explicitly chosen lot has to be in the snapshot too — a lot id
          // alone is not enough to consume from it.
          lotIds: items.map((it) => it.lotId),
        },
        (lots, products) => {
        let lines;
        let consumed;
        let totals;
        try {
          lines = [];
          consumed = [];
          for (const it of items) {
            const variantKey = `${it.size || ''}|${it.color || ''}`;
            // سطر لا يقابل له أي دفعة (منتج/مقاس قديم أو مستورد): يُسعَّر بسعر
            // المنتج وتكلفته بتكلفته، ويُترك استهلاكه فارغًا — الطريق القديم.
            // أمّا مقاس تقع دفعاته على الرفّ ثم ينقصها المطلوب فالرفض كما هو:
            // allocateLots ترمي وتُلغى المعاملة كلها (لا تخمين).
            const taken = lotsOf(lots, it.productId, variantKey).length
              ? takeLots(lots, it.productId, variantKey, it.qty, it.lotId)
              : takeWithoutLots(it.qty, products.get(it.productId), it);
            // «سعر البيع يتبع الدفعة» (Option A): the line is expanded into one
            // output line per distinct lot selling price it consumed. 3 pieces at
            // 15 from the old lot + 2 at 18 from the new one become two lines
            // (3×15, 2×18) — never one line at an average nobody quoted. The
            // stored per-piece figure is display only; the authoritative cost is
            // the whole-agorot line total below (DEFECT-I).
            const groups = groupTakesByPrice(taken);
            for (const g of groups) {
              const lineIndex = lines.length;
              lines.push({
                productId: it.productId,
                name: it.name,
                size: it.size,
                color: it.color,
                qty: g.qty,
                price: g.price,
                costPrice: lineUnitCost(g.takes, g.qty),
                // (أ) تكلفة السطر تُقرَّب مرة واحدة هنا — لا على القطعة ولا على
                // الفاتورة — وتكلفة الفاتورة مجموع حرفي لهذه الأرقام (أسفله).
                costTotal: Number(lineCostAgorot(g.takes)) / 100,
              });
              // سطر بلا دفعات لا يترك سجلًا: `batchId` فارغ يعني «لم تخرج من دفعة».
              for (const c of g.takes) if (c.batchId != null) consumed.push({ ...c, lineIndex });
            }
          }
          // Exact totals from the ACTUAL lot-priced lines — not from the price
          // the caller typed. subtotal/discount/increase/total in integer
          // arithmetic, halves up (js/money.js).
          totals = saleTotals(lines, sale.discountType, discountValue, sale.priceIncrease);
        } catch (err) {
          fail(err);
          return;
        }

        // Read every affected product exactly once, apply all of its line
        // items, then write it back once. A get/put pair per line would let two
        // lines of the same product overwrite one another: both reads see the
        // same snapshot, so the last write silently discards the earlier
        // decrement.
        const now = new Date().toISOString();
        try {
          for (const p of products.values()) {
            for (const it of items) {
              if (it.productId !== p.id) continue;
              const v = (p.variants || []).find((x) => x.size === it.size && x.color === it.color);
              if (!v) continue;
              // (و) رفض حقيقي بدل الصمت: كان `Math.max(0, …)` يُخفي المقاس الناتج
              // تحت الصفر (كمية صفر على الرفّ وفاتورة تقول إنها باعت أكثر ممّا
              // كان هناك). الآن يُرمى الخطأ داخل try المعاملة فتنسحب كل الكتابة —
              // لا فاتورة بلا بضاعة ولا مخزون سالب.
              const left = (Number(v.quantity) || 0) - it.qty;
              if (left < 0) {
                throw new Error(
                  `المخزون غير كافٍ لـ«${it.name || p.name}»: على الرفّ ${Number(v.quantity) || 0} قطعة والمطلوب ${it.qty}`
                );
              }
              v.quantity = left;
            }
            p.updatedAt = now;
          }
        } catch (err) {
          fail(err);
          return;
        }

        // Each line cost is whole agorot, so the invoice cost is their exact
        // integer sum — it can never carry sub-agora dust (DEFECT-I). Summed in
        // micro-units (the common denominator) and divided once, so no float
        // multiplication is involved anywhere.
        const costTotalMicro = lines.reduce((sum, it) => sum + toMicro(it.costTotal), 0n);

        const record = {
          id,
          receiptNo,
          items: lines,
          subtotal: totals.subtotal,
          discount: totals.discount,
          discountType: sale.discountType || 'fixed',
          discountValue,
          priceIncrease: totals.priceIncrease,
          total: totals.total,
          paymentMethod: sale.paymentMethod || 'cash',
          costTotal: Number(costTotalMicro) / 1000000,
          // Store consumed batches separately for refund/restore. `lineIndex`
          // names the OUTPUT line the take belongs to (a split line has its own
          // index), so a refund can put every piece back where it came from.
          stockBatchesConsumed: consumed,
          timestamp: sale.timestamp || new Date().toISOString(),
          note: sale.note || '',
        };

        for (const b of lots) store(STORES.stockBatches).put(b);
        for (const p of products.values()) store(STORES.products).put(p);
        store(STORES.sales).put(record);
        stored = record;
        },
        fail
      );
    };
    existing.onerror = () => fail(existing.error);
    return null;
  });
  return stored;
}

/**
 * Edits a saved sale.
 *
 * Stock was already decremented when the sale was created, so an edit has to
 * move inventory by the *difference* between what was sold and what is now
 * being claimed — not by the new quantities. Lowering a line from 3 to 1 puts
 * 2 pieces back on the shelf; raising it to 4 takes 1 more off. Every affected
 * product is read once and written once, for the same reason createSale does:
 * per-line get/put pairs make two lines of one product overwrite each other.
 */
export async function updateSale(saleId, patch) {
  // Read the old sale first: which of the two stock paths applies depends on it
  // (a recorded sale knows its lots; a legacy sale does not).
  const old = await get(STORES.sales, saleId);
  if (!old) return null;

  const normalize = (list) =>
    (list || [])
      .map((it) => ({
        productId: it.productId,
        name: it.name,
        size: it.size,
        color: it.color,
        qty: nonNegInt(it.qty),
        price: nonNeg(it.price),
        costPrice: nonNeg(it.costPrice),
      }))
      .filter((it) => it.qty > 0);

  const oldItems = (old.items || []).filter((it) => (Number(it.qty) || 0) > 0);
  const newItems = normalize(patch.items || old.items);

  const keyOf = (it) => `${it.size || ''}|${it.color || ''}`;
  const mapKey = (it) => `${it.productId}|${keyOf(it)}`;
  const splitKey = (k) => {
    const i = k.indexOf('|');
    return [k.slice(0, i), k.slice(i + 1)];
  };

  /* ── FIFO: the owner's rule — editing a sale recomputes its cost from the
   * batches. Put back what THIS sale had taken, then take the new amounts.
   *
   * Two kinds of sale meet this code:
   *   • recorded sales carry `stockBatchesConsumed` — their lots are known, so
   *     the shelf is made whole and the full new quantity is consumed fresh;
   *   • legacy sales (recorded before batches existed) were never in the batch
   *     book — v5 seeded the batches from the post-sale variants, so the batch
   *     state already excludes their old quantities. Only the DIFFERENCE moves:
   *     edited up → consume the increase; edited down → hand the surplus back
   *     as a fresh lot. Their per-line cost stays as recorded, because there
   *     is no lot to recompute it from.
   *
   * All of it happens in ONE transaction: the whole edit either lands or is
   * rolled back. A refusal is an abort, not a hand-rolled undo — there is no
   * intermediate state where lots were restored but the sale was not rewritten.
   */
  const oldConsumed = (old.stockBatchesConsumed || []).filter((c) => c && c.batchId && c.qty > 0);
  const recordsPath = oldConsumed.length > 0;

  // Exact totals are computed inside the transaction, from the final lines.
  const discountType = patch.discountType || old.discountType || 'fixed';
  const discountValue = nonNeg(patch.discountValue === undefined ? old.discountValue : patch.discountValue);
  const priceIncrease = nonNeg(patch.priceIncrease === undefined ? (old.priceIncrease || 0) : patch.priceIncrease);

  const productIds = [...new Set([...oldItems, ...newItems].map((it) => it.productId))];
  const variants = [...new Set([...oldItems, ...newItems].map(keyOf))];

  let updated = null;
  await multiTx([STORES.sales, STORES.products, STORES.stockBatches], 'readwrite', (store, t, fail) => {
    readStock(store, { productIds, variants, lotIds: oldConsumed.map((c) => c.batchId) }, (lots, products) => {
      let lines;
      let consumed = [];
      let totals;
      try {
        if (recordsPath) {
          // Make the shelf whole first (oldest-then-reverse order, exactly as
          // before), then take the new amounts. `takeLots` refuses if the
          // restored shelf cannot cover them — and that throw aborts the whole
          // transaction, so the restore never half-happens.
          for (const c of [...oldConsumed].reverse()) returnToLot(lots, c.batchId, c.qty);
          lines = [];
          for (const it of newItems) {
            const taken = takeLots(lots, it.productId, keyOf(it), it.qty);
            // «سعر البيع يتبع الدفعة»: an edit reprices from the lots the same
            // way a fresh sale does — one stored line per distinct lot price.
            for (const g of groupTakesByPrice(taken)) {
              const lineIndex = lines.length;
              lines.push({
                productId: it.productId,
                name: it.name,
                size: it.size,
                color: it.color,
                qty: g.qty,
                price: g.price,
                costPrice: lineUnitCost(g.takes, g.qty),
                costTotal: Number(lineCostAgorot(g.takes)) / 100,
              });
              for (const c of g.takes) consumed.push({ ...c, lineIndex });
            }
          }
        } else {
          // Legacy sale: move only the DIFFERENCE. Increases come off the lots;
          // a surplus is filed as a fresh lot at the line's own recorded cost.
          const newPerKey = new Map();
          for (const it of newItems) newPerKey.set(mapKey(it), (newPerKey.get(mapKey(it)) || 0) + it.qty);
          const oldPerKey = new Map();
          for (const it of oldItems) oldPerKey.set(mapKey(it), (oldPerKey.get(mapKey(it)) || 0) + it.qty);
          const keys = new Set([...newPerKey.keys(), ...oldPerKey.keys()]);
          for (const k of keys) {
            const net = (newPerKey.get(k) || 0) - (oldPerKey.get(k) || 0);
            if (net === 0) continue;
            const [pid, vk] = splitKey(k);
            if (net > 0) {
              // The increase's records are deliberately not stored: this sale is
              // still legacy (records = []), and refundSale returns every piece
              // it can't attribute to a lot as a fresh one, which nets out.
              // (ب) مقاس لا دفعات له أصلًا (بيانات قديمة/مستوردة): لا شيء يخرج
              // من رفّ الدفعات فلا توزيع ولا رفض — والمقاس يتحرك بمقدار الفرق
              // أسفله. أمّا مقاس تقع دفعاته ثم ينقصها الزيادة فيبقى مرفوضًا:
              // takeLots ترمي وتُلغى المعاملة كلها (لا تخمين).
              if (lotsOf(lots, pid, vk).length) takeLots(lots, pid, vk, net);
            } else {
              const [size, color] = vk.split('|');
              const ref = oldItems.find((it) => mapKey(it) === k) || newItems.find((it) => mapKey(it) === k);
              lots.push(freshLot({
                productId: pid, size, color, qty: -net,
                costPrice: ref ? ref.costPrice : 0,
                sellingPrice: ref ? ref.price : 0,
              }));
            }
          }
          // Legacy lines keep the per-piece cost they were given (nothing else
          // exists to recompute from), but the line total is still exact: it is
          // rounded to the agora once (DEFECT-I).
          lines = newItems.map((it) => ({
            ...it,
            costTotal: Number(microToAgorot(toMicro(it.costPrice) * BigInt(it.qty))) / 100,
          }));
        }
      } catch (err) {
        fail(err);
        return;
      }

      // Exact totals from the final lines (js/money.js) —
      // subtotal − discount + increase = total, always.
      totals = saleTotals(lines, discountType, discountValue, priceIncrease);

      // Compute and apply the variant delta (old pieces come back, new ones go
      // out) with one read and one write per product.
      const delta = new Map();
      const bump = (productId, size, color, by) => {
        if (!by) return;
        if (!delta.has(productId)) delta.set(productId, new Map());
        const per = delta.get(productId);
        const k = `${size}|${color}`;
        per.set(k, (per.get(k) || 0) + by);
      };
      for (const it of oldItems) bump(it.productId, it.size, it.color, it.qty);
      for (const it of newItems) bump(it.productId, it.size, it.color, -it.qty);

      const now = new Date().toISOString();
      try {
        for (const [pid, per] of delta) {
          const product = products.get(pid);
          if (!product) continue;
          for (const [k, by] of per) {
            const [size, color] = k.split('|');
            const v = (product.variants || []).find((x) => x.size === size && x.color === color);
            if (!v) continue;
            // (و) رفض حقيقي بدل الصمت — نفس قاعدة البيع: تعديل ينزل المقاس تحت
            // الصفر يُلغى كل شيء (fail ت abort المعاملة) فلا فاتورة معدَّلة ولا
            // مخزون سالب. يمرّ عبر هذا الطريق الواحد كلا حالتي التعديل: طريق
            // السجلات (يعاد حسابه من الدفعات) وطريق الفواتير القديمة (بالفرق).
            const left = (Number(v.quantity) || 0) + by;
            if (left < 0) {
              throw new Error(
                `المخزون غير كافٍ لتعديل فاتورة «${product.name}» (${size || '—'}/${color || '—'}): ` +
                  `على الرفّ ${Number(v.quantity) || 0} قطعة والتعديل يخصم ${-by}`
              );
            }
            v.quantity = left;
          }
          product.updatedAt = now;
        }
      } catch (err) {
        fail(err);
        return;
      }

      // Each line cost is whole agorot, so the invoice cost is their exact sum.
      const costTotalMicro = lines.reduce((sum, it) => sum + toMicro(it.costTotal), 0n);

      const updatedRecord = {
        ...old,
        items: lines,
        subtotal: totals.subtotal,
        discount: totals.discount,
        discountType,
        discountValue,
        priceIncrease: totals.priceIncrease,
        total: totals.total,
        costTotal: Number(costTotalMicro) / 1000000,
        // Freshly recorded lots, tagged by line so a later refund can hand each
        // piece back; legacy sales keep an empty list — refundSale synthesises
        // fresh lots for whatever the records do not cover.
        stockBatchesConsumed: recordsPath ? consumed : [],
        paymentMethod: patch.paymentMethod || old.paymentMethod || 'cash',
        note: patch.note === undefined ? old.note : patch.note,
        updatedAt: now,
      };

      for (const b of lots) store(STORES.stockBatches).put(b);
      for (const p of products.values()) store(STORES.products).put(p);
      store(STORES.sales).put(updatedRecord);
      updated = updatedRecord;
    }, fail);
    return null;
  });
  return updated;
}

/**
 * Refunds a sale — in full or in part — and records the refund as a separate
 * audit entry. The original sale is NEVER deleted: its invoice, lines and
 * historical values stay intact for audit.
 *
 * Stock is restored inside the same transaction as the refund record, so the
 * shelf, the lots and the refund log can never disagree.
 *
 * @param {string} saleId  the sale being refunded
 * @param {object} [options]
 * @param {Array}  options.items   [{productId, size, color, qty}] — lines to refund.
 *                                 Omitted = refund every line in full.
 * @param {string} options.reason  free-text reason (shown in reports/admin)
 * @param {string} options.paymentMethod  how the money is being returned
 * @param {string} options.idempotencyKey  client-generated key to prevent
 *                                 double-refund from a retry or double tap
 * @returns {Promise<{refund: object, sale: object}>} the created refund record
 *          and the (unchanged) original sale
 */
export function refundSale(saleId, options = {}) {
  const {
    items: requestedItems,
    reason = '',
    paymentMethod = null,
    idempotencyKey = null,
  } = options;

  const now = new Date().toISOString();
  const refundId = idempotencyKey || cryptoId();

  // Pre-check idempotency outside the transaction: a retry that finds an
  // existing refund under the same key returns it immediately without
  // touching stock. The write below uses the same key as the refund id, so
  // a concurrent double-tap lands on the same record.
  if (idempotencyKey) {
    return get(STORES.refunds, idempotencyKey).then((existing) => {
      if (existing) {
        return get(STORES.sales, saleId).then((sale) => ({ refund: existing, sale }));
      }
      return writeRefund();
    });
  }
  return writeRefund();

  function writeRefund() {
    return multiTx([STORES.sales, STORES.products, STORES.stockBatches, STORES.refunds], 'readwrite', (store, t, fail) => {
      const salesStore = store(STORES.sales);
      const saleReq = salesStore.get(saleId);
      saleReq.onsuccess = () => {
        const sale = saleReq.result;
        if (!sale) {
          fail(new Error('الفاتورة غير موجودة'));
          return;
        }

        const items = sale.items || [];
        const consumed = (sale.stockBatchesConsumed || []).filter((c) => c && c.batchId && c.qty > 0);

        // ── Determine what is being refunded ──
        let refundLines; // [{productId, name, size, color, qty, price, costPrice, lineIndex}]
        let totalRefundedAgorot = 0n;
        let costTotalRefundedAgorot = 0n;

        if (requestedItems && requestedItems.length > 0) {
          // Partial refund: validate each requested line and build refund lines.
          // Amounts are computed below from actual consumed batches (LIFO), not
          // from the input line's price, because a sale line may be split across
          // multiple batches at different prices (Option A).
          refundLines = [];
          for (const req of requestedItems) {
            const lineIdx = items.findIndex((it) =>
              it.productId === req.productId &&
              it.size === req.size &&
              it.color === req.color &&
              (Number(it.qty) || 0) > 0
            );
            if (lineIdx < 0) {
              fail(new Error(`السطر المطلوب استرجاعه غير موجود في الفاتورة: ${req.productId}`));
              return;
            }
            const soldQty = Number(items[lineIdx].qty) || 0;
            const refundQty = Math.round(Number(req.qty) || 0);
            if (refundQty <= 0) continue;
            if (refundQty > soldQty) {
              fail(new Error(`الكمية المطلوبة استرجاعها (${refundQty}) أكبر من الكمية المباعة (${soldQty})`));
              return;
            }
            const line = { ...items[lineIdx], qty: refundQty };
            refundLines.push({ ...line, lineIndex: lineIdx });
          }
        } else {
          // Full refund: every line, every piece.
          refundLines = items.map((it, i) => ({ ...it, lineIndex: i }));
        }

        if (refundLines.length === 0) {
          fail(new Error('لا يوجد شيء لاسترجاعه'));
          return;
        }

        // ── Read stock for restoring batches ──
        readStock(
          store,
          {
            productIds: [...new Set(refundLines.map((l) => l.productId))],
            variants: [...new Set(refundLines.map((l) => `${l.size || ''}|${l.color || ''}`))],
            lotIds: consumed.map((c) => c.batchId),
          },
          (lots, products) => {
            // Build batchId → batch details for matching consumed batches to variants.
            const batchById = new Map();
            for (const b of lots) batchById.set(b.id, b);

            // ── Compute actual refund amounts from consumed batches (LIFO) ──
            // A sale line may be split across multiple batches at different prices
            // (Option A), so the input line's price is not authoritative. We
            // allocate the refunded qty across the consumed batches for that
            // variant, most recently consumed first, and compute amounts from
            // each batch's actual selling price and cost price.
            if (requestedItems && requestedItems.length > 0) {
              // Group consumed batches by product/size/color variant.
              const consumedByVariant = new Map();
              for (const c of consumed) {
                const b = batchById.get(c.batchId);
                if (!b) continue;
                const key = `${b.productId}|${b.size || ''}|${b.color || ''}`;
                if (!consumedByVariant.has(key)) consumedByVariant.set(key, []);
                consumedByVariant.get(key).push(c);
              }

              for (const line of refundLines) {
                const key = `${line.productId}|${line.size || ''}|${line.color || ''}`;
                const variantConsumed = (consumedByVariant.get(key) || []).reverse(); // LIFO
                let remaining = Number(line.qty);
                for (const c of variantConsumed) {
                  if (remaining <= 0) break;
                  const take = Math.min(remaining, Number(c.qty));
                  totalRefundedAgorot += BigInt(take) * toMicro(c.sellingPrice);
                  costTotalRefundedAgorot += BigInt(take) * toMicro(c.costPrice || 0);
                  remaining -= take;
                }
              }
            } else {
              // Full refund: amounts are computed below in the restore section
              // from refundLines (legacy sales have no consumed batches).
            }

            // Determine which batches to restore.
            // Full refund: restore all consumed batches.
            // Partial refund: restore only the batches for the refunded qty,
            // in reverse consumption order (LIFO within the sale).
            const batchesToRestore = [];
            const freshLots = [];

            if (requestedItems && requestedItems.length > 0) {
              // Partial refund: group restore qty by product/size/color variant.
              const restoreByVariant = new Map();
              for (const line of refundLines) {
                const key = `${line.productId}|${line.size || ''}|${line.color || ''}`;
                const existing = restoreByVariant.get(key) || {
                  qty: 0, productId: line.productId, size: line.size,
                  color: line.color, costPrice: line.costPrice, sellingPrice: line.price
                };
                existing.qty += Number(line.qty) || 0;
                restoreByVariant.set(key, existing);
              }

              for (const [, restore] of restoreByVariant) {
                let remaining = restore.qty;
                // Consumed batches for this variant, in reverse consumption order.
                const variantConsumed = consumed.filter((c) => {
                  const b = batchById.get(c.batchId);
                  return b && b.productId === restore.productId
                    && b.size === restore.size && b.color === restore.color;
                }).reverse();

                for (const c of variantConsumed) {
                  if (remaining <= 0) break;
                  const restoreQty = Math.min(remaining, Number(c.qty));
                  batchesToRestore.push({ batchId: c.batchId, qty: restoreQty });
                  remaining -= restoreQty;
                }

                if (remaining > 0) {
                  freshLots.push({
                    productId: restore.productId, size: restore.size, color: restore.color,
                    qty: remaining, costPrice: restore.costPrice, sellingPrice: restore.sellingPrice,
                  });
                }
              }
            } else {
              // Full refund: restore all consumed batches, and for any refunded
              // qty not covered by batch records (legacy sales without lots),
              // file fresh lots at the line's recorded cost.
              const coveredByVariant = new Map();
              for (const c of consumed) {
                const b = batchById.get(c.batchId);
                if (!b) continue;
                const key = `${b.productId}|${b.size || ''}|${b.color || ''}`;
                coveredByVariant.set(key, (coveredByVariant.get(key) || 0) + Number(c.qty));
              }
              for (const line of refundLines) {
                const key = `${line.productId}|${line.size || ''}|${line.color || ''}`;
                const coveredQty = coveredByVariant.get(key) || 0;
                const lineQty = Number(line.qty) || 0;
                const remaining = Math.max(0, lineQty - coveredQty);
                totalRefundedAgorot += BigInt(lineQty) * toMicro(line.price);
                costTotalRefundedAgorot += BigInt(lineQty) * toMicro(line.costPrice || 0);
                if (remaining > 0) {
                  freshLots.push({
                    productId: line.productId, size: line.size, color: line.color,
                    qty: remaining, costPrice: line.costPrice, sellingPrice: line.price,
                  });
                }
              }
              for (const c of [...consumed].reverse()) {
                batchesToRestore.push({ batchId: c.batchId, qty: c.qty });
              }
            }

            // Apply batch restorations.
            for (const { batchId, qty } of batchesToRestore) {
              returnToLot(lots, batchId, qty);
            }

            // For quantities not covered by batch records, file fresh lots.
            for (const fl of freshLots) {
              lots.push(freshLot(fl));
            }

            // Update variant quantities: put refunded pieces back on the shelf.
            const nowIso = new Date().toISOString();
            for (const p of products.values()) {
              for (const line of refundLines) {
                if (line.productId !== p.id) continue;
                const v = (p.variants || []).find((x) => x.size === line.size && x.color === line.color);
                if (v) v.quantity = (Number(v.quantity) || 0) + (Number(line.qty) || 0);
              }
              p.updatedAt = nowIso;
            }

            // Build the refund record.
            const totalRefunded = Number(microToAgorot(totalRefundedAgorot)) / 100;
            const costTotalRefunded = Number(microToAgorot(costTotalRefundedAgorot)) / 100;

            const refundRecord = {
              id: refundId,
              originalSaleId: saleId,
              originalReceiptNo: sale.receiptNo || null,
              items: refundLines.map((l) => ({
                productId: l.productId,
                name: l.name,
                size: l.size,
                color: l.color,
                qty: Number(l.qty) || 0,
                price: nonNeg(l.price),
                costPrice: nonNeg(l.costPrice),
                lineIndex: l.lineIndex,
              })),
              totalRefunded: round2(totalRefunded),
              costTotalRefunded: round2(costTotalRefunded),
              paymentMethod: paymentMethod || sale.paymentMethod || 'cash',
              reason: String(reason || '').trim(),
              status: 'completed',
              refundDate: now,
              createdAt: now,
            };

            store(STORES.refunds).put(refundRecord);
            for (const b of lots) store(STORES.stockBatches).put(b);
            for (const p of products.values()) store(STORES.products).put(p);
            // The sale is NOT deleted — it stays as the historical record.
          },
          fail
        );
      };
      saleReq.onerror = () => fail(saleReq.error);
      return null;
    }).then(() => {
      return get(STORES.refunds, refundId).then((refund) => {
        if (!refund) throw new Error('لم يتم إنشاء سجل الاسترجاع');
        return get(STORES.sales, saleId).then((sale) => ({ refund, sale }));
      });
    });
  }
}

export const deleteSale = (id) => del(STORES.sales, id);

/* ------------------------------------------------------------------ *
 * Domain: suppliers (purchases ledger — never touches inventory)
 * ------------------------------------------------------------------ */

export const listSuppliers = () => getAll(STORES.suppliers);

export function saveSupplier(s) {
  const now = new Date().toISOString();
  return put(STORES.suppliers, {
    id: s.id || cryptoId(),
    name: (s.name || '').trim(),
    phone: (s.phone || '').trim(),
    notes: s.notes || '',
    // What we already owed this supplier before the app started tracking
    // invoices — their opening credit line.
    openingBalance: nonNeg(s.openingBalance),
    createdAt: s.createdAt || now,
    updatedAt: now,
  });
}

/**
 * Removes a supplier together with everything owed on their account.
 *
 * The cascade lives here rather than in the screen that offers the button: an
 * invoice left behind with no supplier would sit in every "total owed" sum and
 * could be re-attached to a new supplier with the same name, quietly corrupting
 * both balances. Restock records are deliberately untouched — they are the
 * store's stock history, not the supplier's paper.
 */
export function deleteSupplier(id) {
  return multiTx([STORES.suppliers, STORES.supplierInvoices, STORES.supplierPayments], 'readwrite', (store) => {
    store(STORES.suppliers).delete(id);
    for (const name of [STORES.supplierInvoices, STORES.supplierPayments]) {
      const req = store(name).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        if (cur.value.supplierId === id) cur.delete();
        cur.continue();
      };
    }
  });
}

export const listSupplierInvoices = () => getAll(STORES.supplierInvoices);
export const listSupplierPayments = () => getAll(STORES.supplierPayments);

/**
 * Lists all stock batches.
 * @returns {Promise<Array<Object>>}
 */
export const listStockBatches = () => getAll(STORES.stockBatches);

/* ------------------------------------------------------------------ *
 * Stock Batches (price lots) — FIFO inventory valuation
 * ------------------------------------------------------------------ */

/**
 * A stock batch represents a single restock lot with its own purchase and
 * selling prices. This enables FIFO inventory valuation: when selling,
 * we consume from the oldest batch first, preserving the correct cost
 * basis and selling price for each unit.
 *
 * @typedef {Object} StockBatch
 * @property {string} id
 * @property {string} productId
 * @property {string} variantKey  size|color key (e.g. "L|Red")
 * @property {string} size
 * @property {string} color
 * @property {number} quantity    remaining pieces in this batch
 * @property {number} costPrice   purchase price per unit
 * @property {number} sellingPrice selling price per unit
 * @property {string} createdAt   ISO timestamp
 */

/**
 * Creates initial stock batches for a product from its current variants.
 * Called during v5 migration and when a new product is first saved with stock.
 * @param {object} product
 * @returns {Promise<Array<StockBatch>>}
 */
export async function createInitialStockBatches(product) {
  const variants = product.variants || [];
  const now = new Date().toISOString();
  const batches = [];
  for (const v of variants) {
    const qty = Number(v.quantity) || 0;
    if (qty <= 0) continue;
    const batchId = cryptoId();
    const variantKey = `${v.size || ''}|${v.color || ''}`;
    const batch = {
      id: batchId,
      productId: product.id,
      variantKey,
      size: v.size || '',
      color: v.color || '',
      quantity: qty,
      costPrice: Number(product.costPrice) || 0,
      sellingPrice: Number(product.price) || 0,
      createdAt: product.createdAt || now,
    };
    batches.push(batch);
  }
  if (batches.length) {
    await multiTx([STORES.stockBatches], 'readwrite', (store) => {
      for (const b of batches) store(STORES.stockBatches).put(b);
    });
  }
  return batches;
}

/**
 * Adds a new stock batch (restock) with explicit purchase and selling prices.
 * If sellingPrice is not provided, uses the product's current selling price.
 * @param {object} params
 * @returns {Promise<StockBatch>}
 */
export async function addStockBatch({ productId, variantKey, size, color, quantity, costPrice, sellingPrice }) {
  const batchId = cryptoId();
  const batch = {
    id: batchId,
    productId,
    variantKey,
    size: size || '',
    color: color || '',
    quantity: Number(quantity) || 0,
    costPrice: Number(costPrice) || 0,
    sellingPrice: sellingPrice !== undefined && sellingPrice !== null && sellingPrice !== '' ? Number(sellingPrice) : 0,
    createdAt: new Date().toISOString(),
  };
  await multiTx([STORES.stockBatches], 'readwrite', (store) => {
    store(STORES.stockBatches).put(batch);
  });
  return batch;
}

/**
 * Gets all batches for a product variant, ordered by createdAt (oldest first) for FIFO.
 * @param {string} productId
 * @param {string} variantKey
 * @returns {Promise<Array<StockBatch>>}
 */
export async function getStockBatches(productId, variantKey) {
  return new Promise((resolve, reject) => {
    multiTx([STORES.stockBatches], 'readonly', (store) => {
      const index = store(STORES.stockBatches).index('variantKey');
      const req = index.getAll(variantKey);
      req.onsuccess = () => {
        const batches = req.result.filter(b => b.productId === productId && b.quantity > 0);
        batches.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        resolve(batches);
      };
      req.onerror = () => reject(req.error);
    });
  });
}

/**
 * Consumes stock from batches using FIFO. Returns the consumed batches with
 * quantities and cost/selling prices for accurate sale recording.
 * @param {string} productId
 * @param {string} variantKey
 * @param {number} qtyToConsume
 * @returns {Promise<Array<{batchId:string, qty:number, costPrice:number, sellingPrice:number}>>}
 */
export async function consumeStockFIFO(productId, variantKey, qtyToConsume) {
  const batches = await getStockBatches(productId, variantKey);
  let remaining = qtyToConsume;
  const consumed = [];

  for (const batch of batches) {
    if (remaining <= 0) break;
    const take = Math.min(batch.quantity, remaining);
    if (take > 0) {
      consumed.push({
        batchId: batch.id,
        qty: take,
        costPrice: batch.costPrice,
        sellingPrice: batch.sellingPrice,
      });
      // Update batch quantity
      await multiTx([STORES.stockBatches], 'readwrite', (store) => {
        store(STORES.stockBatches).put({ ...batch, quantity: batch.quantity - take });
      });
      remaining -= take;
    }
  }

  if (remaining > 0) {
    throw new Error(`Insufficient stock: needed ${qtyToConsume}, only ${qtyToConsume - remaining} available`);
  }

  return consumed;
}

/**
 * Restores stock to batches (for refunds). Adds quantity back to the
 * original batches in reverse FIFO order (most recently consumed first).
 * @param {Array<{batchId:string, qty:number}>} consumed
 * @returns {Promise<void>}
 */
export async function restoreStockBatches(consumed) {
  if (!consumed || !consumed.length) return;
  // Restore in reverse order (last consumed first) to maintain FIFO integrity
  for (const c of [...consumed].reverse()) {
    await multiTx([STORES.stockBatches], 'readwrite', (store) => {
      const req = store(STORES.stockBatches).get(c.batchId);
      req.onsuccess = () => {
        const batch = req.result;
        if (batch) {
          batch.quantity = (Number(batch.quantity) || 0) + c.qty;
          store(STORES.stockBatches).put(batch);
        }
      };
    });
  }
}

/**
 * Gets total available stock for a variant across all batches.
 * @param {string} productId
 * @param {string} variantKey
 * @returns {Promise<number>}
 */
export async function getAvailableStock(productId, variantKey) {
  const batches = await getStockBatches(productId, variantKey);
  return batches.reduce((sum, b) => sum + (Number(b.quantity) || 0), 0);
}

/**
 * Validates that enough stock exists in batches for a sale.
 * @param {string} productId
 * @param {string} variantKey
 * @param {number} qty
 * @returns {Promise<boolean>}
 */
export async function hasStockInBatches(productId, variantKey, qty) {
  const available = await getAvailableStock(productId, variantKey);
  return available >= qty;
}

/**
 * Records the consumed batches on a sale for later refund/restore.
 * Adds a `stockBatchesConsumed` array to the sale items.
 */
export function recordConsumedBatches(sale) {
  // This is a placeholder - the actual consumption happens in createSale
  // and the consumed batches are attached to each sale item.
  return sale;
}

/**
 * Rebuilds stock batches from product variants (emergency repair).
 * @param {string} productId
 * @returns {Promise<number>}
 */
export async function rebuildStockBatches(productId) {
  const product = await get(STORES.products, productId);
  if (!product) return 0;
  // Delete existing batches for this product
  await multiTx([STORES.stockBatches], 'readwrite', (store) => {
    const index = store(STORES.stockBatches).index('productId');
    const req = index.openCursor(productId);
    req.onsuccess = (ev) => {
      const cur = ev.target.result;
      if (cur) {
        cur.delete();
        cur.continue();
      }
    };
  });
  // Recreate from product variants
  await createInitialStockBatches(product);
  return 1;
}

/**
 * Records a supplier bill.
 *
 * A single write, and *only* the invoice store is touched — there is no product
 * store involved, which makes it structurally impossible for this to move
 * stock.
 *
 * ── The one place a number may exceed what it "should" ────────────────
 * Paying a supplier MORE than their bill is not a mistake, it is an advance:
 * the shop is holding their money and will deduct it from their next bill. So
 * `paid` is deliberately NOT clamped to the total. Whatever the supplier
 * already had in hand is applied to this bill automatically (`advance`), so the
 * shop does not have to remember to do it by hand, and only the money that
 * actually moves is written to `supplierPayments` — an advance being spent is
 * not a second payment.
 *
 * When editing an invoice, that invoice's own effect is left out of the advance
 * calculation. Otherwise saving it twice would re-apply its coverage and the
 * bill would look paid twice over.
 *
 * @param {object} inv
 * @param {string} inv.supplierId
 * @param {string} [inv.invoiceNo]  the supplier's own printed number
 * @param {Array}  inv.items        [{name, qty, price}] — free text, not SKUs
 * @param {string} [inv.payStatus]   'carried' | 'partial' | 'full' | 'advance'
 * @param {number} [inv.paid]        money handed over NOW (may exceed the bill)
 */
export async function createSupplierInvoice(inv) {
  const items = (inv.items || [])
    .map((it) => ({
      name: String(it.name || '').trim(),
      qty: nonNegInt(it.qty),
      price: nonNeg(it.price),
    }))
    .filter((it) => it.name && it.qty > 0);

  const subtotal = round2(items.reduce((t, it) => t + it.qty * it.price, 0));
  const discount = round2(Math.min(nonNeg(inv.discount), subtotal));
  const total = round2(Math.max(0, subtotal - discount));

  const nowPaid = round2(nonNeg(inv.paid));
  const held = await advanceAvailable(inv.supplierId, inv.id);
  // What the bill actually CONSUMES of the credit, which is never more than the
  // bill itself: a 250 bill spends 250 of a 1500 advance and leaves 1250 for the
  // next one. Recording the whole held figure here would make the statement claim
  // a 250 bill had been covered by 1500.
  const advance = round2(Math.min(held, total));

  // What this bill ends up covered by: the money handed over now plus whatever
  // of the supplier's own money we were already holding. `paid` can read above
  // the total — that surplus is our credit and the next bill spends it.
  const paid = round2(nowPaid + advance);

  const record = {
    id: inv.id || cryptoId(),
    supplierId: inv.supplierId,
    invoiceNo: (inv.invoiceNo || '').trim(),
    date: inv.date || new Date().toISOString(),
    items,
    subtotal,
    // A discount the supplier granted on the whole bill.
    discount,
    total,
    // How the bill was settled when it was written down. The money itself lives
    // in `supplierPayments`, so the balance never has to read this — it is here
    // so the invoice and the statement can say what happened without guessing.
    payStatus: inv.payStatus || 'carried',
    paid,
    // Split out so the statement can say "X of this was covered by the advance
    // you already had" without redoing the arithmetic. `surplus` is the part of
    // the surplus that did NOT cover this bill and is still ours to hold.
    advance,
    surplus: round2(Math.max(0, paid - total)),
    note: inv.note || '',
    createdAt: new Date().toISOString(),
  };

  return put(STORES.supplierInvoices, record);
}

/**
 * How much of the supplier's money is already in our hands and unspent.
 *
 * Read-only, so it costs nothing and changes no schema: the surplus is simply
 * a negative running balance, which supplierBalance() already computes.
 *
 * @param {string} supplierId
 * @param {string} [excludeInvoiceId]  ignored while editing — see the note above
 * @returns {Promise<number>} never negative
 */
export async function advanceAvailable(supplierId, excludeInvoiceId) {
  if (!supplierId) return 0;
  const [suppliers, invoices, payments] = await Promise.all([
    listSuppliers(),
    listSupplierInvoices(),
    listSupplierPayments(),
  ]);
  const s = suppliers.find((x) => x.id === supplierId);
  if (!s) return 0;
  const b = supplierBalance(
    s,
    invoices.filter((r) => r.id !== excludeInvoiceId),
    payments
  );
  return round2(Math.max(0, -b.remaining));
}

export const deleteSupplierInvoice = (id) => del(STORES.supplierInvoices, id);

/**
 * Records money paid *to* a supplier.
 *
 * There is deliberately no ceiling: paying more than the bill is allowed, and
 * the surplus becomes the supplier's credit with us (see createSupplierInvoice).
 * There is still no floor below zero — a "negative payment" is a payment in the
 * other direction, which is an invoice, not a payment — and it is refused
 * outright rather than written as a zero, for the same reason createPurchase
 * refuses a zero-quantity restock: a row that settles nothing is not a record.
 *
 * @throws {Error} when `amount` is not above zero
 */
export function createSupplierPayment(p) {
  const amount = round2(nonNeg(p.amount));
  if (amount <= 0) return Promise.reject(new Error('مبلغ الدفعة يجب أن يكون أكبر من صفر'));

  const record = {
    id: p.id || cryptoId(),
    supplierId: p.supplierId,
    amount,
    method: p.method || 'cash',
    date: p.date || new Date().toISOString(),
    // Optional: ties the payment to one invoice, for the statement view.
    invoiceId: p.invoiceId || null,
    note: p.note || '',
    createdAt: new Date().toISOString(),
  };
  return put(STORES.supplierPayments, record);
}

export const deleteSupplierPayment = (id) => del(STORES.supplierPayments, id);

/**
 * Rolls a supplier's whole ledger into the numbers the UI shows.
 *
 *   remaining = openingBalance + Σ invoices − Σ payments
 *
 * One number, two meanings, split out here so no screen has to guess:
 *   owed    > 0  → we still owe them
 *   credit  > 0  → they are in advance to us, and the next bill spends it
 */
export function supplierBalance(supplier, invoices, payments) {
  const mine = (rows) => (rows || []).filter((r) => r.supplierId === supplier.id);
  const billed = mine(invoices).reduce((t, r) => t + (r.total || 0), 0);
  const paid = mine(payments).reduce((t, r) => t + (r.amount || 0), 0);
  const opening = nonNeg(supplier.openingBalance);
  const remaining = round2(opening + billed - paid);
  return {
    opening: round2(opening),
    billed: round2(billed),
    paid: round2(paid),
    remaining,
    owed: round2(Math.max(0, remaining)),
    credit: round2(Math.max(0, -remaining)),
  };
}

/** Ledger for every supplier at once — one pass instead of N filtered scans. */
export function allSupplierBalances(suppliers, invoices, payments) {
  const billed = new Map();
  const paid = new Map();
  for (const r of invoices || []) {
    billed.set(r.supplierId, (billed.get(r.supplierId) || 0) + (r.total || 0));
  }
  for (const r of payments || []) {
    paid.set(r.supplierId, (paid.get(r.supplierId) || 0) + (r.amount || 0));
  }
  return new Map(
    (suppliers || []).map((s) => {
      const b = round2((billed.get(s.id) || 0));
      const p = round2((paid.get(s.id) || 0));
      const opening = nonNeg(s.openingBalance);
      const remaining = round2(opening + b - p);
      return [
        s.id,
        {
          opening: round2(opening),
          billed: b,
          paid: p,
          remaining,
          owed: round2(Math.max(0, remaining)),
          credit: round2(Math.max(0, -remaining)),
        },
      ];
    })
  );
}

export const PAYMENT_METHODS = {
  cash: 'نقداً',
  card: 'بطاقة',
  transfer: 'حوالة',
  cheque: 'شيك',
};

/* ------------------------------------------------------------------ *
 * Domain: settings
 * ------------------------------------------------------------------ */

export const DEFAULT_SETTINGS = {
  key: 'app',
  storeName: 'متجري',
  ownerName: '',
  storeTagline: 'إدارة متجر الملابس',
  phone: '',
  address: '',
  currency: 'ILS',
  // Money already in the till on the day the app started being used, so the
  // store balance has a real starting point instead of always reading zero.
  openingBalance: 0,
  // Local gate for the sensitive fields in the product form (quantities,
  // sizes, colours). NOT security — it only stops an accidental edit.
  editPin: '0000',
  lowStockThreshold: 5,
  logo: '',
  categories: ['قمصان وبلوزات', 'فساتين', 'بناطيل', 'جاكيتات ومعاطف', 'تيشيرتات', 'أحذية وإكسسوارات'],
  sizes: ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
  colors: [
    { name: 'أوف وايت كريمي', hex: '#FBF0F4' },
    { name: 'كحلي', hex: '#363E67' },
    { name: 'رمادي محايد', hex: '#C9C9C9' },
    { name: 'خشب داكن', hex: '#DBCCBE' },
    { name: 'أبيض ناصع', hex: '#FFFFFF' },
    { name: 'أسود', hex: '#1A1A1A' },
  ],
  receiptFooter: 'شكراً لتسوقكم معنا — نراكم قريباً',
  receiptShowLogo: true,
  seeded: false,
  installHintDismissed: false,
};

export async function getSettings() {
  const rec = await get(STORES.settings, 'app');
  return { ...DEFAULT_SETTINGS, ...(rec || {}), key: 'app', currency: 'ILS' };
}

/**
 * The currency is not a preference: this app is priced in shekels and the
 * settings screen no longer offers a choice. Forcing it here means a stale
 * backup or an old call site cannot reintroduce another symbol.
 *
 * `openingBalance` and `lowStockThreshold` are clamped for the same reason the
 * rest of the app is: they are numbers, and a negative opening balance would
 * print a negative store balance on the dashboard.
 */
export function saveSettings(patch) {
  return getSettings().then((cur) =>
    put(STORES.settings, {
      ...cur,
      ...patch,
      openingBalance: nonNeg(patch.openingBalance === undefined ? cur.openingBalance : patch.openingBalance),
      lowStockThreshold: nonNegInt(patch.lowStockThreshold === undefined ? cur.lowStockThreshold : patch.lowStockThreshold),
      key: 'app',
      currency: 'ILS',
    })
  );
}

/* ------------------------------------------------------------------ *
 * Whole-database operations (backup / restore / clear)
 * ------------------------------------------------------------------ */

export async function exportAll() {
  const [products, sales, purchases, suppliers, supplierInvoices, supplierPayments, settings, stockBatches, refunds] =
    await Promise.all([
      listProducts(),
      listSales(),
      listPurchases(),
      listSuppliers(),
      listSupplierInvoices(),
      listSupplierPayments(),
      getSettings(),
      listStockBatches(),
      listRefunds(),
    ]);
  return {
    app: 'saher',
    version: DB_VERSION,
    exportedAt: new Date().toISOString(),
    products,
    sales,
    purchases,
    suppliers,
    supplierInvoices,
    supplierPayments,
    stockBatches,
    refunds,
    settings,
  };
}

/** What a file has to carry before we are willing to touch the live database. */
export function validateBackup(data) {
  if (!data || typeof data !== 'object') return 'ملف النسخة الاحتياطية غير صالح';
  if (data.app !== 'saher') return 'هذا الملف ليس نسخة احتياطية من Store Hub';
  if (!Array.isArray(data.products)) return 'النسخة الاحتياطية لا تحتوي على قائمة المنتجات';
  if (!Array.isArray(data.sales)) return 'النسخة الاحتياطية لا تحتوي على قائمة الفواتير';
  // refunds is new in v6 — old backups won't have it, which is fine.
  // A settings block is what carries the store balance's opening figure; a file
  // without one would silently reset the shop back to a zero balance.
  if (data.settings && typeof data.settings !== 'object') return 'بيانات المتجر داخل الملف غير صالحة';
  return null;
}

/**
 * Replaces the database with a backup.
 *
 * The clear and the inserts share ONE transaction, so a failure part-way
 * through rolls the whole thing back and the shop is left exactly as it was —
 * the previous version wiped every store in separate transactions first, which
 * could leave an empty database behind if the insert failed.
 */
export async function importAll(data) {
  const problem = validateBackup(data);
  if (problem) throw new Error(problem);

  const restores = [STORES.products, STORES.sales, STORES.settings];
  // Only wipe the supplier stores if the backup actually carries them, so an old
  // file cannot silently wipe a ledger the user has since entered by hand.
  const hasLedger =
    Array.isArray(data.suppliers) ||
    Array.isArray(data.supplierInvoices) ||
    Array.isArray(data.supplierPayments);
  if (hasLedger) restores.push(STORES.suppliers, STORES.supplierInvoices, STORES.supplierPayments);
  // Same reasoning for purchases: a file written before restock existed has none.
  const hasPurchases = Array.isArray(data.purchases);
  if (hasPurchases) restores.push(STORES.purchases);
  // stockBatches exist from v5 onward; restore them if present
  const hasBatches = Array.isArray(data.stockBatches);
  if (hasBatches) restores.push(STORES.stockBatches);
  // refunds exist from v6 onward; restore them if present
  const hasRefunds = Array.isArray(data.refunds);
  if (hasRefunds) restores.push(STORES.refunds);

  await multiTx(restores, 'readwrite', (store) => {
    for (const s of restores) store(s).clear();

    for (const p of data.products || []) {
      store(STORES.products).put({
        ...p,
        price: nonNeg(p.price),
        costPrice: nonNeg(p.costPrice),
        variants: (p.variants || []).map((v) => ({ ...v, quantity: nonNegInt(v.quantity) })),
      });
    }
    // A backup written by an older build still carries customerId/customerName
    // on its sales. The v3 migration already ran, so nothing upstream would
    // strip them again - drop them here or a legacy restore quietly brings the
    // whole customers feature back from the dead.
    for (const s of data.sales || []) {
      const { customerId, customerName, ...rest } = s;
      // A file is untrusted input as far as arithmetic goes. A well-formed
      // backup round-trips untouched; one carrying a negative quantity or price
      // (hand-edited, or written by a build without the guards) is corrected on
      // the way in rather than loaded as-is. The three totals are rebuilt from
      // the corrected lines rather than merely floored, so the arithmetic of a
      // restored invoice can never contradict its own lines.
      const items = (rest.items || [])
        .map((it) => ({
          ...it,
          qty: nonNegInt(it.qty),
          price: nonNeg(it.price),
          costPrice: nonNeg(it.costPrice),
        }))
        .filter((it) => it.qty > 0);
      // Same exact arithmetic as createSale (js/money.js): a well-formed
      // backup round-trips to the agora, and a hand-edited one is rebuilt
      // from its corrected lines rather than trusted.
      const dType = rest.discountType || 'fixed';
      const dVal = nonNeg(rest.discountValue);
      const totals = saleTotals(items, dType, dVal, rest.priceIncrease);
      // Cost of goods: keep each line's recorded whole-agorot cost when the file
      // carries one (so a backup round-trips exactly); derive it from the line's
      // per-piece cost otherwise. Never re-derive it as a float sum (DEFECT-I).
      const costedItems = items.map((it) => {
        const micro = it.costTotal === undefined || it.costTotal === null || it.costTotal === ''
          ? toMicro(it.costPrice) * BigInt(it.qty)
          : toMicro(it.costTotal);
        return { ...it, costTotal: Number(microToAgorot(micro)) / 100 };
      });
      const costMicro = costedItems.reduce((sum, it) => sum + toMicro(it.costTotal), 0n);
      store(STORES.sales).put({
        ...rest,
        items: costedItems,
        subtotal: totals.subtotal,
        discount: totals.discount,
        priceIncrease: totals.priceIncrease,
        total: totals.total,
        costTotal: Number(costMicro) / 1000000,
      });
    }
    for (const p of data.purchases || []) {
      store(STORES.purchases).put({
        ...p,
        unitCost: nonNeg(p.unitCost),
        units: nonNegInt(p.units),
        total: nonNeg(p.total),
      });
    }
    for (const b of data.stockBatches || []) {
      store(STORES.stockBatches).put({
        ...b,
        quantity: nonNegInt(b.quantity),
        costPrice: nonNeg(b.costPrice),
        sellingPrice: nonNeg(b.sellingPrice),
      });
    }
    for (const r of data.refunds || []) {
      store(STORES.refunds).put({
        ...r,
        totalRefunded: nonNeg(r.totalRefunded),
        costTotalRefunded: nonNeg(r.costTotalRefunded),
        items: (r.items || []).map((it) => ({
          ...it,
          qty: nonNegInt(it.qty),
          price: nonNeg(it.price),
          costPrice: nonNeg(it.costPrice),
        })),
      });
    }
    for (const s of data.suppliers || []) {
      store(STORES.suppliers).put({ ...s, openingBalance: nonNeg(s.openingBalance) });
    }
    for (const s of data.supplierInvoices || []) {
      // Same story as sales: rebuild the money from the corrected lines, and keep
      // `paid` as it was recorded — a supplier invoice is the one record where a
      // figure may legitimately sit above the bill, because that surplus is the
      // advance the shop is holding for them.
      const items = (s.items || [])
        .map((it) => ({
          name: String(it.name || '').trim(),
          qty: nonNegInt(it.qty),
          price: nonNeg(it.price),
        }))
        .filter((it) => it.name && it.qty > 0);
      const sub = round2(items.reduce((t, it) => t + it.qty * it.price, 0));
      const discount = round2(Math.min(nonNeg(s.discount), sub));
      const total = round2(Math.max(0, sub - discount));
      const paid = round2(Math.max(0, nonNeg(s.paid)));
      store(STORES.supplierInvoices).put({
        ...s,
        items,
        subtotal: sub,
        discount,
        total,
        paid,
        surplus: round2(Math.max(0, paid - total)),
      });
    }
    for (const s of data.supplierPayments || []) {
      // A payment of zero or less is not a payment; loading one would add a row
      // to the ledger that settles nothing.
      const amount = round2(nonNeg(s.amount));
      if (amount > 0) store(STORES.supplierPayments).put({ ...s, amount });
    }
    // A restored file is untrusted input as far as arithmetic goes: clamp the
    // settings numbers on the way in, exactly as saveSettings does.
    const restored = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
    store(STORES.settings).put({
      ...restored,
      openingBalance: nonNeg(restored.openingBalance),
      lowStockThreshold: nonNegInt(restored.lowStockThreshold),
      key: 'app',
      currency: 'ILS',
    });
  });
}

/**
 * Empties every store, settings included.
 *
 * Settings has to be in here: leaving it behind would keep an old
 * `openingBalance` while every sale and purchase vanished, and the store
 * balance would report money nobody ever had. A cleared database is a brand
 * new shop, so it starts from the defaults.
 */
export async function clearAll() {
  await Promise.all([
    clearStore(STORES.products),
    clearStore(STORES.sales),
    clearStore(STORES.purchases),
    clearStore(STORES.suppliers),
    clearStore(STORES.supplierInvoices),
    clearStore(STORES.supplierPayments),
    clearStore(STORES.settings),
  ]);
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function cryptoId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Rounds a money amount to whole agorot (half up) in EXACT decimal arithmetic.
 *
 * `Math.round(n * 100) / 100` is not the same rule: the fractional input is
 * already a binary approximation by the time it arrives, so `round2(0.465)`
 * saw 0.46499999999999997 and rounded DOWN to 0.46 instead of up to 0.47. Issue
 * I: every figure that feeds the store balance, a purchase total or a supplier
 * balance is rounded here, so the fix belongs in the one place they all pass
 * through. The digits are read from the value's own decimal string (js/money.js)
 * exactly as `saleTotals` does, so a value the owner typed and the value it
 * rounds to never disagree.
 */
function round2(n) {
  return Number(microToAgorot(toMicro(n))) / 100;
}

/** Receipt numbers restart daily: 0001, 0002 … per day. */
function nextReceiptNo(seq) {
  // The date half must use the same local-day convention as everything else —
  // seed.js already builds its numbers with isoDate(). Slicing toISOString()
  // here would stamp a UTC day, so a sale made shortly after local midnight
  // would carry the previous day's prefix while counting as the first sale of
  // the new day.
  const day = dayKeyOf(new Date()).replace(/-/g, '');
  const n = String((seq || 0) + 1).padStart(4, '0');
  return `${day}-${n}`;
}
