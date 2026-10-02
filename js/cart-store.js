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
  if (!discount.value) return 0;
  // A percentage over 100 is treated as 100%, not as a negative total.
  if (discount.type === 'percent') return Math.min(sub, (sub * Math.min(discount.value, 100)) / 100);
  return Math.min(sub, discount.value);
}

export const grandTotal = () => Math.max(0, subtotal() - discountAmount());

/* ------------------------------------------------------------------ *
 * Payment + last sale
 * ------------------------------------------------------------------ */

export const getPaymentMethod = () => paymentMethod;
export function setPaymentMethod(id) {
  paymentMethod = id;
}

export const getLastSale = () => lastSale;
export function setLastSale(sale) {
  lastSale = sale;
}

/* ------------------------------------------------------------------ *
 * Mutators — each one keeps the bar in step
 * ------------------------------------------------------------------ */

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
  const next = Math.max(0, Math.min(qty, max || qty));
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
