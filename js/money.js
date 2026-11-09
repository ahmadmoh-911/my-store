/**
 * Exact money arithmetic for sales — the ONE place sale totals are computed.
 *
 * ── Why this module exists ────────────────────────────────────────────
 * The shop allows prices with more than two decimals (the owner confirmed
 * this: 1.505 is a valid price). A basket of such prices can land on exactly
 * half an agora — 3 × 185.94 + 3 × 1.505 = 562.335 — and the rounding rule
 * (half up) then decides the last agora. Adding binary floats first and
 * rounding once at the end does NOT implement that rule: 562.335 arrives as
 * 562.3349999999999 in a double and rounded down to 562.33, while the exact
 * decimal answer is 562.34. The error is invisible, reproducible and wrong.
 *
 * So every figure here is computed in exact integer arithmetic:
 *
 *   • a price is read from its **decimal string** (the digits the owner typed),
 *     not from the double — so 1.005 is 1005000 micro-units, never 1004999;
 *   • 1 shekel = 1,000,000 micro-units, which holds six decimals exactly;
 *   • quantities are whole pieces;
 *   • every subtotal/discount/increase is rounded to whole agorot
 *     (1 agora = 10,000 micro-units), halves up, exactly once.
 *
 * ── The owner's confirmed rules this file implements ──────────────────
 *   1. Subtotal = Σ (qty × price) exact, then rounded half up — once, at the end.
 *   2. Percent discount = subtotal × pct / 100 from the exact subtotal,
 *      rounded half up once. A percent over 100 is 100%.
 *   3. Fixed discount is rounded first, then clamped so it never exceeds the
 *      stored subtotal (a discount bigger than the bill would make the total
 *      negative; the owner confirmed clamping to the subtotal — total 0 —
 *      is intended).
 *   4. "priceIncrease" (the owner's add-to-total) is stored at whole agorot
 *      like every other receipt figure, so the receipt always adds up:
 *      subtotal − discount + increase = total, to the agora, always.
 *
 * All four returned numbers are whole agorot (n × 0.01), so adding and
 * subtracting them in double precision is exact and every consumer — the
 * checkout screen, the cart bar, the invoice editor, the stored record and a
 * restored backup — shows and keeps the same figures.
 *
 * This module is pure (no IndexedDB, no DOM) so it can be imported from the
 * cart store, which deliberately imports nothing stateful. The tests measure
 * it against an INDEPENDENT reference implementation (tests/reference-accounting.mjs)
 * that shares no code with this file, on purpose: a shared helper would make
 * a bug in the helper cancel itself out.
 */

const SCALE = 1000000n; // micro-units per shekel
const AGORA = 10000n;    // micro-units per agora
// pct is a percent value scaled by SCALE, so
//   subMicro × pctMicro / PERCENT_DEN
// = (subShekel × pct / 100) in agorot.
const PERCENT_DEN = 100n * SCALE * AGORA;

/** Nearest integer of num/den, halves away from zero (the round2 rule, exact). */
function roundHalfUp(num, den) {
  const n = BigInt(num);
  const d = BigInt(den);
  if (d <= 0n) throw new Error('money: denominator must be positive');
  if (n < 0n) return -roundHalfUp(-n, d);
  return (n * 2n + d) / (d * 2n);
}

/**
 * A decimal amount → exact micro-units.
 *
 * Reads the STRING form so `toMicro(0.1)` is 100000n and not the binary
 * approximation of 0.1. Anything past the sixth decimal is rounded half up.
 * Non-numeric input is zero — the same guard the receipt paths apply before
 * these figures ever reach money.
 */
export function toMicro(value) {
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

/**
 * The totals of one sale, computed exactly.
 *
 * @param {Array<{qty:number, price:number}>} items  cart/invoice lines (qty > 0)
 * @param {'fixed'|'percent'} discountType
 * @param {number} discountValue   agorot amount (fixed) or percent (percent)
 * @param {number} priceIncrease   the amount added to the total
 * @returns {{subtotal:number, discount:number, priceIncrease:number, total:number}}
 *          every figure at whole agorot, satisfying
 *          subtotal − discount + priceIncrease === total, exactly.
 */
export function saleTotals(items, discountType, discountValue, priceIncrease) {
  // ── 1 · exact subtotal ─────────────────────────────────────────────
  let subMicro = 0n;
  for (const it of items || []) {
    const qty = Math.round(Number(it && it.qty) || 0);
    if (qty <= 0) continue;
    subMicro += BigInt(qty) * toMicro(it ? it.price : 0);
  }
  const subAgorot = roundHalfUp(subMicro, AGORA);

  // ── 2 · discount, rounded once, never past the subtotal ────────────
  const dv = Math.max(0, Number(discountValue) || 0);
  let discAgorot;
  if (discountType === 'percent') {
    // A percent over 100 is 100%, not a negative total. The clamp against the
    // subtotal is unreachable for percents ≤ 100 but is kept so no input at
    // all can produce a discount above the bill.
    const pctMicro = toMicro(Math.min(dv, 100));
    discAgorot = roundHalfUp(subMicro * pctMicro, PERCENT_DEN);
  } else {
    discAgorot = roundHalfUp(toMicro(dv), AGORA);
  }
  if (discAgorot > subAgorot) discAgorot = subAgorot;

  // ── 3 · increase and total — all whole agorot, so the receipt adds up ─
  const incAgorot = roundHalfUp(toMicro(priceIncrease), AGORA);
  const totalAgorot = subAgorot - discAgorot + incAgorot; // ≥ increase ≥ 0

  return {
    subtotal: Number(subAgorot) / 100,
    discount: Number(discAgorot) / 100,
    priceIncrease: Number(incAgorot) / 100,
    total: Number(totalAgorot) / 100,
  };
}

/**
 * Round an exact micro-unit amount to whole agorot (half up), as a BigInt.
 *
 * This is the cost side of the same rule the sale totals follow: the shop's
 * currency stops at the agora, so a cost of goods figure is stored at whole
 * agorot like every other money figure. The rounding happens ONCE, at the
 * boundary where the figure is recorded — never on the per-piece cost, which
 * stays exact so a sum can still be recomputed from it.
 */
export function microToAgorot(micro) {
  return roundHalfUp(micro, AGORA);
}

/**
 * The exact cost of a set of consumed FIFO lots, in micro-units.
 *
 * Each take is `{ qty, costPrice }`. The price is read from its decimal string
 * (exactly what the lot recorded), so a lot bought at 0.155 costs 465000 micro
 * for three pieces — 0.465, not 0.46499999999999997 as a float sum would give.
 * The result is exact; callers round it to agorot with `microToAgorot`.
 *
 * @param {Array<{qty:number, costPrice:number}>} consumed
 * @returns {bigint} micro-units
 */
export function lotsCostMicro(consumed) {
  let m = 0n;
  for (const c of consumed || []) {
    const qty = Math.round(Number(c && c.qty) || 0);
    if (qty <= 0) continue;
    m += BigInt(qty) * toMicro(c ? c.costPrice : 0);
  }
  return m;
}

/**
 * An exact micro-unit amount → a decimal string with at most six places.
 *
 * Used for the per-piece cost a receipt line shows: the average is a display
 * figure only (the authoritative number is the line's whole-agorot cost), so it
 * is emitted as digits instead of a float that could carry binary noise back
 * into a later sum.
 */
export function microToDecimal(micro) {
  let m = BigInt(micro);
  const neg = m < 0n;
  if (neg) m = -m;
  const whole = m / SCALE;
  const frac = (m % SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}
