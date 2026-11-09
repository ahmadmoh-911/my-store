/**
 * Independent reference calculator — the yardstick the app is measured against.
 *
 * ── Why this file exists ────────────────────────────────────────────────
 * "The number is right" is a claim, and a claim needs a second opinion that
 * did not come from the same code. This module re-derives every accounting
 * figure in the shop using **exact integer arithmetic**, written from the rules
 * the owner confirmed — not copied from `js/db.js`. It shares no code with the
 * app on purpose: if both used the same helper, a mistake in that helper would
 * cancel itself out and the tests would prove nothing.
 *
 * ── The unit ───────────────────────────────────────────────────────────
 * The shop allows prices with more than two decimals (the owner confirmed
 * this), so the reference cannot stop at the agora. Money is held as a BigInt
 * count of **micro-units** (1/1,000,000 of a shekel): fine enough to hold any
 * price a person types, and exact — no float ever enters a calculation.
 *
 *   micro("19.99")   → 19990000n
 *   cents(micro)     → round to the nearest agora
 *
 * Quantities are integers (the app refuses fractional pieces). Percentages are
 * integers. Every comparison the tests make is an exact integer comparison.
 *
 * ── Rounding rule ──────────────────────────────────────────────────────
 * `roundHalfUp(num, den)` rounds a rational to the nearest integer, halves away
 * from zero — the exact behaviour the app's `round2` shows for the positive
 * amounts a shop deals in.
 */

const SCALE = 1000000n; // micro-units per shekel
const CENTS = 10000n;   // micro-units per agora

/** Nearest integer of num/den, halves away from zero. */
export function roundHalfUp(num, den = 1n) {
  const n = BigInt(num);
  const d = BigInt(den);
  if (d <= 0n) throw new Error('denominator must be positive');
  if (n < 0n) return -roundHalfUp(-n, d);
  return (n * 2n + d) / (d * 2n);
}

/**
 * A decimal amount → exact micro-units.
 *
 * Reads the **string** form, so `micro(0.1)` is 100000n and not the binary
 * approximation. Anything past the sixth decimal is rounded half up.
 */
export function micro(value) {
  if (value === null || value === undefined || value === '') return 0n;
  const s = String(value).trim();
  if (!/^[+-]?\d*(\.\d*)?$/.test(s)) return 0n;
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const [intPart = '0', fracPart = ''] = body.split('.');
  const frac = (fracPart + '000000').slice(0, 6);
  let m = BigInt(intPart || '0') * SCALE + BigInt(frac || '0');
  const extra = fracPart.length > 6 ? fracPart.slice(6) : '';
  if (extra && Number(extra[0]) >= 5) m += 1n;
  return neg ? -m : m;
}

/** Micro-units → whole agorot (rounded half up). */
export const toCents = (m) => roundHalfUp(m, CENTS);

/** Whole agorot → micro-units. */
export const centsToMicro = (c) => BigInt(c) * CENTS;

/**
 * The one formula every sale is checked against.
 *
 * @param {Array<{qty:number|bigint, priceMicro:bigint}>} lines
 * @param {'fixed'|'percent'} discountType
 * @param {bigint} discountValue  integer percent (percent) or micro-units (fixed)
 * @param {bigint} increaseMicro
 * @returns {{subtotalMicro, subtotalCents, discountMicro, discountCents,
 *            increaseMicro, totalMicro, totalCents}}
 */
export function saleTotals(lines, discountType = 'fixed', discountValue = 0n, increaseMicro = 0n) {
  let subtotalMicro = 0n;
  for (const l of lines) {
    const qty = BigInt(l.qty);
    if (qty <= 0n) continue;
    subtotalMicro += qty * BigInt(l.priceMicro);
  }

  const v = BigInt(discountValue);
  let discountMicro;
  if (discountType === 'percent') {
    const pct = v > 100n ? 100n : v < 0n ? 0n : v;
    // (subtotal × pct / 100), rounded to the agora exactly once — never twice,
    // because two roundings can land a half-cent away from one.
    discountMicro = centsToMicro(roundHalfUp(subtotalMicro * pct, 100n * CENTS));
  } else {
    const fixed = centsToMicro(roundHalfUp(v < 0n ? 0n : v, CENTS));
    // The clamp is against the SUBTOTAL AS STORED (whole agorot) — the owner's
    // "a discount bigger than the bill becomes the bill" rule applied to the
    // figure the receipt actually shows. Clamping to the raw fractional
    // subtotal would store a sub-agora discount, and then the receipt's own
    // columns would no longer add up.
    const cap = centsToMicro(toCents(subtotalMicro));
    discountMicro = fixed > cap ? cap : fixed;
  }

  // Every figure on the receipt is whole agorot, the increase included, so
  // subtotal − discount + increase = total holds for the printed columns.
  const increase = centsToMicro(toCents(increaseMicro < 0n ? 0n : BigInt(increaseMicro)));
  // The total must be built from the ROUNDED stored subtotal (exactly what the
  // app persists on the sale), not the raw fractional one: the discount is
  // capped against the stored figure, so using 214.135 here while the discount
  // is capped at 214.14 would push the reference total 1 micro-unit below the
  // app's zero. Columns on the receipt then always add up.
  const storedSubtotalMicro = centsToMicro(toCents(subtotalMicro));
  const sumMicro = storedSubtotalMicro - discountMicro + increase;

  return {
    subtotalMicro,
    subtotalCents: toCents(subtotalMicro),
    discountMicro,
    discountCents: toCents(discountMicro),
    increaseMicro: increase,
    totalMicro: sumMicro,
    totalCents: toCents(sumMicro),
  };
}

/**
 * A per-variant FIFO queue of price lots.
 *
 * Ordering is by `createdAt` (oldest first), which is the order the app's
 * `getStockBatches` hands to `consumeStockFIFO`.
 *
 * Each lot carries BOTH prices the app's batches carry: `costMicro` (what the
 * piece cost the shop) and `sellMicro` (what it is supposed to sell for on that
 * lot). `sellMicro` is optional in `add()` — callers that only care about cost
 * omit it and it reads as 0 — but the lots tests feed it and assert that a sale
 * records the selling price of the lot it actually consumed.
 */
export class FifoBook {
  constructor() {
    /** @type {Map<string, Array<{id:string, qty:number, costMicro:bigint, sellMicro:bigint, createdAt:string}>>} */
    this.lots = new Map();
  }

  key(productId, variantKey) {
    return `${productId}::${variantKey}`;
  }

  add(productId, variantKey, lot) {
    const k = this.key(productId, variantKey);
    if (!this.lots.has(k)) this.lots.set(k, []);
    this.lots.get(k).push({
      id: lot.id,
      qty: Number(lot.qty),
      costMicro: BigInt(lot.costMicro ?? micro(lot.costPrice ?? 0)),
      sellMicro: BigInt(lot.sellMicro ?? micro(lot.sellingPrice ?? 0)),
      createdAt: lot.createdAt || '1970-01-01T00:00:00.000Z',
    });
  }

  available(productId, variantKey) {
    const list = this.lots.get(this.key(productId, variantKey)) || [];
    return list.reduce((t, l) => t + l.qty, 0);
  }

  ordered(productId, variantKey) {
    const list = this.lots.get(this.key(productId, variantKey)) || [];
    return [...list]
      .filter((l) => l.qty > 0)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  /**
   * A stable copy of one variant's lots — id, remaining quantity and both
   * prices — for before/after comparisons (a full return must put each lot
   * back to exactly what it was).
   */
  snapshot(productId, variantKey) {
    return (this.lots.get(this.key(productId, variantKey)) || [])
      .map((l) => ({ id: l.id, qty: l.qty, costMicro: l.costMicro, sellMicro: l.sellMicro, createdAt: l.createdAt }))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  /**
   * Takes `qty` units oldest-first — or, when `preferredLotId` names one, that
   * lot FIRST (as much of it as it holds) and the remainder oldest-first, the
   * exact rule db.js `takeLots` implements. Throws when there is not enough
   * stock, or when the preferred lot is not a positive lot of this variant;
   * the book is left untouched in that case, so a caller can retry.
   */
  consume(productId, variantKey, qty, preferredLotId = null) {
    let remaining = Number(qty);
    const taken = [];
    const key = this.key(productId, variantKey);
    const list = this.lots.get(key) || [];
    const ordered = [...list].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

    const takeFrom = (lot) => {
      const take = Math.min(lot.qty, remaining);
      taken.push({ id: lot.id, qty: take, costMicro: lot.costMicro, sellMicro: lot.sellMicro });
      lot.qty -= take;
      remaining -= take;
    };

    if (preferredLotId != null) {
      const pref = ordered.find((l) => l.id === preferredLotId && l.qty > 0);
      if (!pref) {
        throw new Error(`preferred lot ${preferredLotId} is not available for ${productId} ${variantKey}`);
      }
      takeFrom(pref);
    }
    for (const lot of ordered) {
      if (remaining <= 0) break;
      if (preferredLotId != null && lot.id === preferredLotId) continue; // already served first
      if (lot.qty <= 0) continue;
      takeFrom(lot);
    }
    if (remaining > 0) {
      for (const t of taken) {
        const lot = list.find((l) => l.id === t.id);
        if (lot) lot.qty += t.qty;
      }
      throw new Error(`insufficient stock for ${productId} ${variantKey}: short ${remaining}`);
    }
    return taken;
  }

  costOf(taken) {
    return taken.reduce((t, c) => t + BigInt(c.qty) * c.costMicro, 0n);
  }

  /** The selling-price total of a set of takes (each piece at its OWN lot's price). */
  sellOf(taken) {
    return taken.reduce((t, c) => t + BigInt(c.qty) * c.sellMicro, 0n);
  }

  restore(taken) {
    for (const t of taken) {
      for (const list of this.lots.values()) {
        const lot = list.find((l) => l.id === t.id);
        if (lot) {
          lot.qty += Number(t.qty);
          break;
        }
      }
    }
  }

  totalValue() {
    let sum = 0n;
    for (const list of this.lots.values()) {
      for (const l of list) sum += BigInt(l.qty) * l.costMicro;
    }
    return sum;
  }
}

/* ------------------------------------------------------------------ *
 * Store ledger and supplier balances
 * ------------------------------------------------------------------ */

export function storeBalance(openingMicro, salesTotalsCents, purchaseTotalsCents) {
  const s = salesTotalsCents.reduce((t, v) => t + centsToMicro(v), 0n);
  const p = purchaseTotalsCents.reduce((t, v) => t + centsToMicro(v), 0n);
  return BigInt(openingMicro) + s - p;
}

export function supplierBalance(openingMicro, invoiceTotalsMicro, paymentsMicro) {
  const billed = invoiceTotalsMicro.reduce((t, v) => t + BigInt(v), 0n);
  const paid = paymentsMicro.reduce((t, v) => t + BigInt(v), 0n);
  const remaining = BigInt(openingMicro) + billed - paid;
  return {
    billed,
    paid,
    remaining,
    owed: remaining > 0n ? remaining : 0n,
    credit: remaining < 0n ? -remaining : 0n,
  };
}
