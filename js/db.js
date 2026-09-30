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
 *   suppliers         keyPath 'id'   index 'createdAt'
 *   supplierInvoices  keyPath 'id'   index 'date'
 *   supplierPayments  keyPath 'id'   index 'date'
 *   settings          keyPath 'key'  (single 'app' record holds store config)
 *
 * Supplier invoices are a *purchases* ledger. They deliberately carry no
 * productId: recording a supplier bill must never touch stock, variants or
 * cost price. Inventory stays owned by createSale/refundSale alone.
 */

// The only import in this file: dayKeyOf maps a stored UTC timestamp back to
// its LOCAL calendar day, so receipt numbering shares one day convention with
// the dashboard, the reports and the POS sequence. utils.js reaches only
// icons.js and native.js, so this adds no cycle.
import { dayKeyOf } from './utils.js';

export const DB_NAME = 'saher_db';
export const DB_VERSION = 3;

export const STORES = {
  products: 'products',
  sales: 'sales',
  suppliers: 'suppliers',
  supplierInvoices: 'supplierInvoices',
  supplierPayments: 'supplierPayments',
  settings: 'settings',
};

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

/** Multi-store transaction — used when a sale must update sales + products together. */
function multiTx(stores, mode, run) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(stores, mode);
        let out;
        try {
          out = run(t.objectStore.bind(t), t);
        } catch (err) {
          reject(err);
          return;
        }
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('transaction aborted'));
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

export function saveProduct(product) {
  const now = new Date().toISOString();
  const rec = {
    id: product.id,
    name: product.name,
    sku: product.sku || '',
    category: product.category || 'غير مصنف',
    description: product.description || '',
    price: Number(product.price) || 0,
    costPrice: Number(product.costPrice) || 0,
    variants: product.variants || [],
    image: product.image || '',
    createdAt: product.createdAt || now,
    updatedAt: now,
  };
  return put(STORES.products, rec);
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
 * Domain: sales
 * ------------------------------------------------------------------ */

export const listSales = () => getAll(STORES.sales);

/**
 * Records a sale and decrements stock in ONE transaction, so the two can
 * never drift apart if something fails halfway.
 *
 * @param {object} sale
 * @param {Array}  sale.items [{productId, size, color, qty, price, costPrice, name}]
 * @returns {Promise<object>} the stored sale (with id / receiptNo assigned)
 */
export function createSale(sale) {
  const id = sale.id || cryptoId();
  const items = sale.items.map((it) => ({
    productId: it.productId,
    name: it.name,
    size: it.size,
    color: it.color,
    qty: Number(it.qty) || 0,
    price: Number(it.price) || 0,
    costPrice: Number(it.costPrice) || 0,
  }));

  const subtotal = items.reduce((t, it) => t + it.qty * it.price, 0);
  const discountValue = Number(sale.discountValue) || 0;
  const discount =
    sale.discountType === 'percent'
      ? round2((subtotal * Math.min(discountValue, 100)) / 100)
      : Math.min(round2(discountValue), subtotal);
  const total = round2(subtotal - discount);

  const record = {
    id,
    receiptNo: sale.receiptNo || nextReceiptNo(sale.receiptSeq),
    items,
    subtotal: round2(subtotal),
    discount,
    discountType: sale.discountType || 'fixed',
    discountValue,
    total,
    paymentMethod: sale.paymentMethod || 'cash',
    costTotal: items.reduce((t, it) => t + it.qty * (it.costPrice || 0), 0),
    timestamp: sale.timestamp || new Date().toISOString(),
    note: sale.note || '',
  };

  return multiTx([STORES.sales, STORES.products], 'readwrite', (store) => {
    store(STORES.sales).put(record);

    // Read every affected product exactly once, apply all of its line items,
    // then write it back once. A get/put pair per line would let two lines of
    // the same product overwrite one another: both reads see the same
    // snapshot, so the last write silently discards the earlier decrement.
    const productsStore = store(STORES.products);
    const ids = [...new Set(items.map((it) => it.productId))];
    const loaded = new Map();
    let left = ids.length;

    if (left) {
      const flush = () => {
        if (--left > 0) return;
        const now = new Date().toISOString();
        for (const p of loaded.values()) {
          for (const it of items) {
            if (it.productId !== p.id) continue;
            const v = (p.variants || []).find((x) => x.size === it.size && x.color === it.color);
            if (v) v.quantity = Math.max(0, (Number(v.quantity) || 0) - it.qty);
          }
          p.updatedAt = now;
          productsStore.put(p);
        }
      };

      for (const pid of ids) {
        const req = productsStore.get(pid);
        req.onsuccess = () => {
          if (req.result) loaded.set(pid, req.result);
          flush();
        };
        req.onerror = flush;
      }
    }

    // multiTx resolves on transaction completion, so the decrements above are
    // already committed by the time this promise settles.
    return record;
  });
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
export function updateSale(saleId, patch) {
  const now = new Date().toISOString();

  return multiTx([STORES.sales, STORES.products], 'readwrite', (store) => {
    const salesStore = store(STORES.sales);
    const productsStore = store(STORES.products);

    const req = salesStore.get(saleId);
    req.onsuccess = () => {
      const old = req.result;
      if (!old) return;

      const items = (patch.items || old.items || []).map((it) => ({
        productId: it.productId,
        name: it.name,
        size: it.size,
        color: it.color,
        qty: Math.max(0, Number(it.qty) || 0),
        price: Number(it.price) || 0,
        costPrice: Number(it.costPrice) || 0,
      }));

      const subtotal = items.reduce((t, it) => t + it.qty * it.price, 0);
      const discountType = patch.discountType || old.discountType || 'fixed';
      const discountValue = patch.discountValue === undefined ? old.discountValue : Number(patch.discountValue) || 0;
      const discount =
        discountType === 'percent'
          ? round2((subtotal * Math.min(discountValue, 100)) / 100)
          : Math.min(round2(discountValue), subtotal);
      const total = round2(subtotal - discount);

      salesStore.put({
        ...old,
        items,
        subtotal: round2(subtotal),
        discount,
        discountType,
        discountValue,
        total,
        costTotal: items.reduce((t, it) => t + it.qty * (it.costPrice || 0), 0),
        paymentMethod: patch.paymentMethod || old.paymentMethod || 'cash',
        note: patch.note === undefined ? old.note : patch.note,
        updatedAt: now,
      });

      // How many pieces each variant must gain (positive) or lose (negative).
      // Keyed by product, then by the size+color that identifies the variant.
      const delta = new Map();
      const bump = (productId, size, color, by) => {
        if (!by) return;
        if (!delta.has(productId)) delta.set(productId, new Map());
        const per = delta.get(productId);
        const k = `${size} ${color}`;
        per.set(k, (per.get(k) || 0) + by);
      };
      for (const it of old.items || []) bump(it.productId, it.size, it.color, it.qty);
      for (const it of items) bump(it.productId, it.size, it.color, -it.qty);

      const ids = [...delta.keys()];
      if (!ids.length) return;

      let left = ids.length;
      const flush = () => {
        if (--left > 0) return;
        for (const [pid, per] of delta) {
          const preq = productsStore.get(pid);
          preq.onsuccess = () => {
            const p = preq.result;
            if (!p) return;
            for (const [k, by] of per) {
              const [size, color] = k.split(' ');
              const v = (p.variants || []).find((x) => x.size === size && x.color === color);
              if (!v) continue;
              v.quantity = Math.max(0, (Number(v.quantity) || 0) + by);
            }
            p.updatedAt = now;
            productsStore.put(p);
          };
        }
      };
      for (const pid of ids) {
        const greq = productsStore.get(pid);
        greq.onsuccess = flush;
        greq.onerror = flush;
      }
    };
  });
}

/** Undo a sale (used by "استرجاع" from reports) — restores stock. */
export function refundSale(saleId) {
  return multiTx([STORES.sales, STORES.products], 'readwrite', (store) => {
    const salesStore = store(STORES.sales);
    const productsStore = store(STORES.products);
    const req = salesStore.get(saleId);
    req.onsuccess = () => {
      const sale = req.result;
      if (!sale) return;
      salesStore.delete(saleId);

      // One read and one write per product, for the same reason as createSale:
      // a get/put pair per line lets two lines clobber each other.
      const ids = [...new Set(sale.items.map((it) => it.productId))];
      const loaded = new Map();
      let left = ids.length;
      if (!left) return;

      const flush = () => {
        if (--left > 0) return;
        const now = new Date().toISOString();
        for (const p of loaded.values()) {
          for (const it of sale.items) {
            if (it.productId !== p.id) continue;
            const v = (p.variants || []).find((x) => x.size === it.size && x.color === it.color);
            if (v) v.quantity = (Number(v.quantity) || 0) + it.qty;
          }
          p.updatedAt = now;
          productsStore.put(p);
        }
      };

      for (const pid of ids) {
        const preq = productsStore.get(pid);
        preq.onsuccess = () => {
          if (preq.result) loaded.set(pid, preq.result);
          flush();
        };
        preq.onerror = flush;
      }
    };
  });
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
    openingBalance: Number(s.openingBalance) || 0,
    createdAt: s.createdAt || now,
    updatedAt: now,
  });
}

export const deleteSupplier = (id) => del(STORES.suppliers, id);

export const listSupplierInvoices = () => getAll(STORES.supplierInvoices);
export const listSupplierPayments = () => getAll(STORES.supplierPayments);

/**
 * Records a supplier bill. A single transaction, and *only* the invoice store
 * is opened — there is no product store in the list, which makes it structurally
 * impossible for this to move stock.
 *
 * @param {object} inv
 * @param {string} inv.supplierId
 * @param {string} [inv.invoiceNo]  the supplier's own printed number
 * @param {Array}  inv.items        [{name, qty, price}] — free text, not SKUs
 */
export function createSupplierInvoice(inv) {
  const items = (inv.items || [])
    .map((it) => ({
      name: String(it.name || '').trim(),
      qty: Number(it.qty) || 0,
      price: Number(it.price) || 0,
    }))
    .filter((it) => it.name && it.qty > 0);

  const subtotal = round2(items.reduce((t, it) => t + it.qty * it.price, 0));

  const record = {
    id: inv.id || cryptoId(),
    supplierId: inv.supplierId,
    invoiceNo: (inv.invoiceNo || '').trim(),
    date: inv.date || new Date().toISOString(),
    items,
    subtotal,
    // A discount the supplier granted on the whole bill.
    discount: round2(Math.min(Number(inv.discount) || 0, subtotal)),
    total: round2(subtotal - (Number(inv.discount) || 0)),
    note: inv.note || '',
    createdAt: new Date().toISOString(),
  };

  return put(STORES.supplierInvoices, record);
}

export const deleteSupplierInvoice = (id) => del(STORES.supplierInvoices, id);

/** Records money paid *to* a supplier. */
export function createSupplierPayment(p) {
  const record = {
    id: p.id || cryptoId(),
    supplierId: p.supplierId,
    amount: round2(Math.abs(Number(p.amount) || 0)),
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
 * remaining = openingBalance + Σ invoices − Σ payments
 *
 * Positive → we still owe them. Negative → they are in advance to us.
 */
export function supplierBalance(supplier, invoices, payments) {
  const mine = (rows) => (rows || []).filter((r) => r.supplierId === supplier.id);
  const billed = mine(invoices).reduce((t, r) => t + (r.total || 0), 0);
  const paid = mine(payments).reduce((t, r) => t + (r.amount || 0), 0);
  const opening = Number(supplier.openingBalance) || 0;
  return {
    opening,
    billed: round2(billed),
    paid: round2(paid),
    remaining: round2(opening + billed - paid),
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
      const opening = Number(s.openingBalance) || 0;
      return [s.id, { opening, billed: b, paid: p, remaining: round2(opening + b - p) }];
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
  return { ...DEFAULT_SETTINGS, ...(rec || {}), key: 'app' };
}

export function saveSettings(patch) {
  return getSettings().then((cur) => put(STORES.settings, { ...cur, ...patch, key: 'app' }));
}

/* ------------------------------------------------------------------ *
 * Whole-database operations (backup / restore / clear)
 * ------------------------------------------------------------------ */

export async function exportAll() {
  const [products, sales, suppliers, supplierInvoices, supplierPayments, settings] =
    await Promise.all([
      listProducts(),
      listSales(),
      listSuppliers(),
      listSupplierInvoices(),
      listSupplierPayments(),
      getSettings(),
    ]);
  return {
    app: 'saher',
    version: DB_VERSION,
    exportedAt: new Date().toISOString(),
    products,
    sales,
    suppliers,
    supplierInvoices,
    supplierPayments,
    settings,
  };
}

/** Wipes everything then inserts the payload from a backup file. */
export async function importAll(data) {
  if (!data || data.app !== 'saher') {
    throw new Error('ملف النسخة الاحتياطية غير صالح');
  }
  const restores = [STORES.products, STORES.sales, STORES.settings];
  // Only wipe the supplier stores if the backup actually carries them, so a v1
  // file cannot silently wipe a ledger the user has since entered by hand.
  const hasLedger =
    Array.isArray(data.suppliers) ||
    Array.isArray(data.supplierInvoices) ||
    Array.isArray(data.supplierPayments);
  if (hasLedger) restores.push(STORES.suppliers, STORES.supplierInvoices, STORES.supplierPayments);

  await Promise.all(restores.map((s) => clearStore(s)));

  await multiTx(restores, 'readwrite', (store) => {
    for (const p of data.products || []) store(STORES.products).put(p);
    // A backup written by an older build still carries customerId/customerName
    // on its sales. The v3 migration already ran, so nothing upstream would
    // strip them again - drop them here or a legacy restore quietly brings the
    // whole customers feature back from the dead.
    for (const s of data.sales || []) {
      const { customerId, customerName, ...rest } = s;
      store(STORES.sales).put(rest);
    }
    for (const s of data.suppliers || []) store(STORES.suppliers).put(s);
    for (const s of data.supplierInvoices || []) store(STORES.supplierInvoices).put(s);
    for (const s of data.supplierPayments || []) store(STORES.supplierPayments).put(s);
    store(STORES.settings).put({ ...DEFAULT_SETTINGS, ...(data.settings || {}), key: 'app' });
  });
}

export async function clearAll() {
  await Promise.all([
    clearStore(STORES.products),
    clearStore(STORES.sales),
    clearStore(STORES.suppliers),
    clearStore(STORES.supplierInvoices),
    clearStore(STORES.supplierPayments),
  ]);
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function cryptoId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
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
