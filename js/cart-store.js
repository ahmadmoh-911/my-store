/**
 * Cart state, shared by the POS screen and the sticky cart bar.
 *
 * This lives on its own — it imports nothing — so that the bar, which is
 * mounted once in the app shell outside the router's #view, can read the cart
 * without dragging in the POS screen (or creating an import cycle through the
 * router). The POS screen used to own this array privately, which is exactly
 * why the cart could not be shown on any other screen.
 *
 *   cart   → [{ key, productId, name, image, size, color, qty, price, costPrice, max }]
 *   discount → { type: 'fixed' | 'percent', value }
 *
 * Every screen that touches the cart must call emit() after mutating it, so the
 * bar and the POS column repaint together.
 */

/** @type {Array<Object>} */
export const cart = [];

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
 * ------------------------------------------------------------------ */

export const subtotal = () => cart.reduce((t, l) => t + l.qty * l.price, 0);

export const totalItems = () => cart.reduce((t, l) => t + l.qty, 0);

export const lineCount = () => cart.length;

export function discountAmount(sub = subtotal()) {
  // `discount.value` is clamped by setDiscount(); the clamp is repeated here so
  // a hand-edited store object can never produce a negative total either.
  const v = Math.max(0, Number(discount.value) || 0);
  if (!v) return 0;
  // A percentage over 100 is treated as 100%, not as a negative total.
  if (discount.type === 'percent') return Math.min(sub, (sub * Math.min(v, 100)) / 100);
  return Math.min(sub, v);
}

export const grandTotal = () => Math.max(0, subtotal() - discountAmount() + priceIncreaseAmount());

/**
 * The one supported way to touch the discount.
 *
 * A discount can never be negative and a percentage can never exceed 100 —
 * both are refused here, at the single place the value is written, instead of
 * being trusted from whichever screen happens to own the input this frame.
 */
export function setDiscount(type, value) {
  discount.type = type === 'percent' ? 'percent' : 'fixed';
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

/**
 * Puts a product in the basket, or bumps it if it is already there.
 *
 * Everything about the line is normalised here — a line is always at least one
 * whole piece, always priced at zero or more, and never more than the stock its
 * variant actually has. Callers that build the line by hand would each have to
 * remember that, and the ones that forget would sell stock that is not there.
 *
 * @returns {'added'|'bumped'|'full'} so the caller can say the right thing
 */
export function addLine(line) {
  const max = Math.max(0, Math.round(Number(line.max) || 0));
  const existing = cart.find((l) => l.key === line.key);
  if (existing) {
    if (existing.qty >= max) return 'full';
    existing.qty = Math.min(existing.qty + 1, max);
    emit('added');
    return 'bumped';
  }
  cart.push({
    ...line,
    qty: Math.min(1, max || 1),
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
