/**
 * Cart state, shared by the POS screen and the sticky cart bar.
 *
 * This lives on its own — it imports only the pure arithmetic in money.js and,
 * since the basket reservation arrived, the read-only stock readers in db.js
 * (no writes, no DOM) — so that the bar, which is mounted once in the app shell
 * outside the router's #view, can read the cart without dragging in the POS
 * screen (or creating an import cycle through the router). The POS screen used
 * to own this array privately, which is exactly why the cart could not be shown
 * on any other screen. (db.js itself was already in cart-bar's import graph for
 * the currency, so this adds no new weight to the shell.)
 *
 *   cart   → [{ key, productId, name, image, size, color, qty, price, costPrice, max }]
 *   discount → { type: 'fixed' | 'percent', value }
 *
 * Every screen that touches the cart must call emit() after mutating it, so the
 * bar and the POS column repaint together.
 */

import { saleTotals } from './money.js';
import { get as dbGet, getStockBatches, STORES, variantStock } from './db.js';

/** @type {Array<Object>} */
export const cart = [];

/**
 * الخصم في الفواتير الجديدة **مبلغ ثابت فقط** بقرار صاحب المتجر: لا نسبة
 * مئوية في الواجهة. (الفواتير القديمة والنسخ الاحتياطية التي فيها نسبة تبقى
 * تُقرأ وتُعدَّل وتُرجَع كما هي — عبر `saleTotals` التي ما زالت تفهم `percent`،
 * لكن السلة لا تنتج إلا `fixed`.)
 *
 *   discount → { type: 'fixed', value }
 */
export const discount = { type: 'fixed', value: 0 };

export const priceIncrease = { value: 0 };

let paymentMethod = 'cash';

/** The most recent completed sale, so the receipt sheet can reopen it. */
let lastSale = null;

const listeners = new Set();

/** Subscribe to cart changes. Returns an unsubscribe function. */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Tell every listener the cart moved. `reason` lets listeners react differently
 * to a fresh addition than to an edit — the sticky bar peeks open on 'added'.
 */
export function emit(reason = '') {
  for (const fn of listeners) {
    try {
      fn(reason);
    } catch (err) {
      // A broken listener must not stop the others from being told.
      console.error('[cart] listener failed', err);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Cart panel visibility
 *
 * The floating cart panel is part of the cart's state, not of the bar that
 * renders it: the bottom-nav cart button has to be able to open it, and the
 * bar has to stay open while the invoice is on screen. Keeping the flag here
 * (a module that imports nothing) lets the router set it without importing the
 * bar, which would be an import cycle.
 * ------------------------------------------------------------------ */

let panelOpen = false;

export const isPanelOpen = () => panelOpen;

/** Opens/closes the floating cart panel. Works with an empty cart too. */
export function setPanelOpen(next) {
  const value = Boolean(next);
  if (panelOpen === value) return;
  panelOpen = value;
  emit('panel');
}

/* ------------------------------------------------------------------ *
 * Totals
 *
 * One calculation, the exact one js/money.js defines — the same arithmetic
 * createSale will run when the sale is confirmed. The figure the customer
 * sees on the cart bar and the figure printed on the receipt are therefore
 * identical to the agora, including for baskets whose prices carry three
 * decimals and land on an exact half-cent.
 * ------------------------------------------------------------------ */

/** The exact totals of the current basket at this instant. */
export function cartTotals() {
  return saleTotals(cart, discount.type, discount.value, priceIncrease.value);
}

export const subtotal = () => cartTotals().subtotal;

export const totalItems = () => cart.reduce((t, l) => t + l.qty, 0);

export const lineCount = () => cart.length;

export function discountAmount() {
  // `discount.value` is clamped by setDiscount(); money.js clamps again, so a
  // hand-edited store object can never produce a discount above the bill.
  return cartTotals().discount;
}

export const grandTotal = () => cartTotals().total;

/**
 * The one supported way to touch the discount: a FIXED amount, never negative.
 *
 * A percentage is deliberately not accepted here any more — the owner asked for
 * amount-only discounts on new sales. `discount.type` stays a field (and stays
 * 'fixed' through this path) so the stored record keeps its shape and an old
 * invoice that carries `percent` still round-trips; only the cart cannot create
 * one. money.js still clamps to the subtotal, so a hand-edited store object can
 * never produce a discount above the bill.
 */
export function setDiscount(value) {
  discount.type = 'fixed';
  discount.value = Math.max(0, Number(value) || 0);
  return discount.value;
}

export function priceIncreaseAmount(sub = subtotal()) {
  const v = Math.max(0, Number(priceIncrease.value) || 0);
  return v;
}

export function setPriceIncrease(value) {
  priceIncrease.value = Math.max(0, Number(value) || 0);
  return priceIncrease.value;
}

/* ------------------------------------------------------------------ *
 * Payment + last sale
 * ------------------------------------------------------------------ */

export const PAYMENT_METHODS = [
  { id: 'cash', label: 'نقداً' },
  { id: 'card', label: 'بطاقة' },
  { id: 'transfer', label: 'تحويل' },
];

export const getPaymentMethod = () => paymentMethod;

/** Only a known method can be selected. */
export function setPaymentMethod(id) {
  if (PAYMENT_METHODS.some((p) => p.id === id)) paymentMethod = id;
  return paymentMethod;
}

export const getLastSale = () => lastSale;
export function setLastSale(sale) {
  lastSale = sale;
}

/* ------------------------------------------------------------------ *
 * Mutators — each one keeps the bar in step
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Basket reservation — what the shelf can still supply
 *
 * The stock a variant shows is the WHOLE shelf; the basket itself is part of
 * what has already been promised against it. Adding "one more" of a piece
 * whose remaining shelf is already sitting in the basket must be refused here,
 * at the only place a piece enters the basket — otherwise the owner finds out
 * only at checkout, when createSale throws and the whole bill is bounced.
 *
 * Nothing here writes anything: the deduction itself stays the single atomic
 * one inside db.createSale. This is a promise, not a hold.
 * ------------------------------------------------------------------ */

/**
 * How many pieces of one product+variant are currently in the basket.
 *
 * @param {string} productId
 * @param {string} variantKey  the same "size|color" key db.js builds
 * @returns {number}
 */
export function inCartQty(productId, variantKey) {
  const want = String(variantKey || '');
  return cart.reduce(
    (t, l) =>
      t + (l.productId === productId && `${l.size || ''}|${l.color || ''}` === want
        ? Number(l.qty) || 0
        : 0),
    0
  );
}

/** Splits "size|color" back into its two halves (db.js builds the key this way). */
function splitVariantKey(variantKey) {
  const s = String(variantKey || '');
  const i = s.indexOf('|');
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}

/**
 * What this variant can still supply on top of the basket:
 *
 *   shelf stock (db.variantStock) − in-cart quantity, never below zero.
 *
 * Async because the shelf figure lives in IndexedDB. A shelf that cannot be
 * read reads as zero — refusing to promise stock we cannot see is the safe
 * direction for a sale instrument.
 *
 * @param {string} productId
 * @param {string} variantKey  "size|color"
 * @returns {Promise<number>}
 */
export async function availableWithCart(productId, variantKey) {
  const [size, color] = splitVariantKey(variantKey);
  let shelf = 0;
  try {
    const p = await dbGet(STORES.products, productId);
    shelf = p ? variantStock(p, size, color) : 0;
  } catch {
    shelf = 0;
  }
  return Math.max(0, shelf - inCartQty(productId, variantKey));
}

/**
 * أول (أقدم) دفعة على رفّ هذا المقاس بعد FIFO — أي الدفعة التي سيخرج منها
 * البيع أولًا. سعر البيع الذي تُضاف به القطعة للسلة يُؤخذ منها، فيكون ما
 * يراه العميل هو ما ستسجّله الفاتورة فعلًا («السعر يتبع الدفعة»)، لا «آخر
 * سعر» للمنتج الذي قد يكون قد تغيّر بوريدٍ لاحق.
 *
 * لا دفعات للمقاس (بيانات قديمة أو مستوردة) ⇒ `null`، ويسقط المستدعي على سعر
 * المنتج — نفس ما يفعله `db.createSale` عند البيع.
 *
 * قراءة فقط، ولا تفتح ولا تكتب معاملة بنفسها؛ وخطأ القراءة يُعاد كـ `null`
 * فيبقى سعر المنتج هو الطريق الآمن.
 *
 * @param {string} productId
 * @param {string} size
 * @param {string} color
 * @returns {Promise<object|null>}
 */
export async function firstLotFor(productId, size, color) {
  try {
    const lots = await getStockBatches(productId, `${size || ''}|${color || ''}`);
    return lots.length ? lots[0] : null;
  } catch {
    return null;
  }
}

/**
 * Puts a product in the basket, or bumps it if it is already there.
 *
 * Everything about the line is normalised here — a line is always at least one
 * whole piece, always priced at zero or more, and never more than the stock its
 * variant actually has. Callers that build the line by hand would each have to
 * remember that, and the ones that forget would sell stock that is not there.
 *
 * The ceiling is the variant stock MINUS what the basket already holds of the
 * same product+variant (`max` arrives as the whole shelf from the POS screen).
 * Exceeding it is refused with 'full' — the same outcome the caller already
 * handles with a toast — never a silent clamp past what the shelf will supply.
 *
 * @returns {'added'|'bumped'|'full'} so the caller can say the right thing
 */
export function addLine(line) {
  const max = Math.max(0, Math.round(Number(line.max) || 0));
  const available = Math.max(
    0,
    max - inCartQty(line.productId, `${line.size || ''}|${line.color || ''}`)
  );
  const existing = cart.find((l) => l.key === line.key);
  if (existing) {
    if (existing.qty >= available) return 'full';
    existing.qty = Math.min(existing.qty + 1, available);
    emit('added');
    return 'bumped';
  }
  if (available <= 0) return 'full';
  cart.push({
    ...line,
    qty: Math.min(1, available),
    price: Math.max(0, Number(line.price) || 0),
    costPrice: Math.max(0, Number(line.costPrice) || 0),
    max,
  });
  emit('added');
  return 'added';
}

export function clearCart() {
  cart.length = 0;
  // `discount` is a const object shared with the POS screen, so it is reset in
  // place — assigning a new object here would break every holder of it.
  discount.type = 'fixed';
  discount.value = 0;
  panelOpen = false;
  emit();
}

/** Wipes the basket between sales without touching the payment preference. */
export function resetForNextSale() {
  clearCart();
}

/** Sets a line's quantity, clamped to what is actually in stock. */
export function setQty(key, qty) {
  const line = cart.find((l) => l.key === key);
  if (!line) return;
  const max = Number(line.max) || 0;
  // Rounded and floored at zero: a quantity is a count of whole pieces, and a
  // negative one would take stock IN rather than give it back.
  const asked = Math.round(Number(qty) || 0);
  const next = Math.max(0, Math.min(asked, max || asked));
  if (next === 0) {
    removeLine(key);
    return;
  }
  line.qty = next;
  emit();
}

/** Drops one line, and any discount that no longer applies to a smaller basket. */
export function removeLine(key) {
  const i = cart.findIndex((l) => l.key === key);
  if (i < 0) return;
  cart.splice(i, 1);
  if (!cart.length) discount.value = 0;
  emit();
}
