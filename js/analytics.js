/**
 * Shared read-only analytics used by the Dashboard and Reports screens.
 * Everything here is derived from the raw `sales` / `products` records —
 * nothing is stored pre-aggregated, so a restore/backup always rebuilds
 * identical numbers.
 */
import { listSales, listProducts, getSettings, stockOf } from './db.js';
import { startOfDay, addDays, sum, groupBy, isoDate, dayKeyOf } from './utils.js';

/** Loads everything a screen usually needs in one round-trip. */
export async function loadAll() {
  const [products, sales, settings] = await Promise.all([
    listProducts(),
    listSales(),
    getSettings(),
  ]);
  return { products, sales, settings };
}

/* ------------------------------------------------------------------ *
 * Filtering
 * ------------------------------------------------------------------ */

export function salesBetween(sales, from, to) {
  const f = from.getTime();
  const t = to.getTime();
  return sales.filter((s) => {
    const ts = new Date(s.timestamp).getTime();
    return ts >= f && ts <= t;
  });
}

export const salesOn = (sales, day) => {
  const key = isoDate(day);
  return sales.filter((s) => dayKeyOf(s.timestamp) === key);
};

export const dayStart = (d) => startOfDay(d);

/* ------------------------------------------------------------------ *
 * Totals
 * ------------------------------------------------------------------ */

export const revenue = (sales) => sum(sales, (s) => s.total);
export const orderCount = (sales) => sales.length;
export const unitsSold = (sales) => sum(sales, (s) => sum(s.items, (i) => i.qty));
export const discountGiven = (sales) => sum(sales, (s) => s.discount || 0);

/** Profit = revenue − cost of goods (costTotal is captured at sale time). */
export const profit = (sales) =>
  sales.reduce((t, s) => t + (Number(s.total) - Number(s.costTotal || 0)), 0);

export const avgBasket = (sales) => (sales.length ? revenue(sales) / sales.length : 0);

/** Percentage change of `now` vs `prev`; returns null when there is no baseline. */
export function pctChange(now, prev) {
  if (!prev) return now > 0 ? null : 0;
  return ((now - prev) / prev) * 100;
}

/* ------------------------------------------------------------------ *
 * Series / breakdowns
 * ------------------------------------------------------------------ */

/**
 * Builds a contiguous daily series for the last `days` days (oldest → newest).
 * Days with no sales contribute 0 rather than a gap, so the line stays honest.
 *
 * @param {Array} sales all sales
 * @param {number} days window size
 * @param {string} mode 'day' | 'month' label style
 * @returns {{labels:string[], values:number[], days:Date[], total:number}}
 */
export function dailySeries(sales, days) {
  const out = { labels: [], values: [], dates: [], total: 0 };
  const today = startOfDay();

  for (let i = days - 1; i >= 0; i--) {
    const d = addDays(today, -i);
    const key = isoDate(d);
    const daySales = sales.filter((s) => dayKeyOf(s.timestamp) === key);
    const v = sum(daySales, (s) => s.total);
    out.values.push(v);
    out.total += v;
    out.dates.push(d);
    out.labels.push(
      days <= 7
        ? shortDay(d.getDay())
        : `${d.getDate()}/${d.getMonth() + 1}`
    );
  }
  return out;
}

/** Hourly series for "today". */
export function hourlySeries(sales) {
  const labels = [];
  const values = new Array(24).fill(0);
  const key = isoDate(startOfDay());
  for (const s of sales) {
    if (dayKeyOf(s.timestamp) !== key) continue;
    values[new Date(s.timestamp).getHours()] += Number(s.total) || 0;
  }
  for (let h = 0; h < 24; h++) {
    labels.push(`${h % 12 || 12} ${h < 12 ? 'ص' : 'م'}`);
  }
  return { labels, values };
}

const AR_DAYS_SHORT = ['أحد', 'إثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'];
const shortDay = (i) => AR_DAYS_SHORT[i];

/**
 * Top products by revenue/quantity.
 * @returns {{name:string, qty:number, revenue:number, productId:string}[]}
 */
export function bestSellers(sales, limit = 5) {
  const map = new Map();
  for (const s of sales) {
    for (const it of s.items || []) {
      const key = it.productId || it.name;
      const cur = map.get(key) || {
        productId: it.productId,
        name: it.name,
        qty: 0,
        revenue: 0,
      };
      cur.qty += Number(it.qty) || 0;
      cur.revenue += (Number(it.qty) || 0) * (Number(it.price) || 0);
      map.set(key, cur);
    }
  }
  return [...map.values()].sort((a, b) => b.revenue - a.revenue).slice(0, limit);
}

/** Category breakdown by revenue (joins sale items → product.category). */
export function categoryTotals(sales, products) {
  const byId = new Map(products.map((p) => [p.id, p]));
  const map = new Map();
  for (const s of sales) {
    for (const it of s.items || []) {
      const p = byId.get(it.productId);
      const cat = p ? p.category : 'غير مصنف';
      map.set(cat, (map.get(cat) || 0) + (Number(it.qty) || 0) * (Number(it.price) || 0));
    }
  }
  return [...map.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
}

export function paymentBreakdown(sales) {
  const map = new Map();
  for (const s of sales) map.set(s.paymentMethod, (map.get(s.paymentMethod) || 0) + Number(s.total || 0));
  const labels = { cash: 'نقود', card: 'بطاقة', transfer: 'تحويل' };
  return [...map.entries()].map(([k, v]) => ({ name: labels[k] || k, value: v }));
}

/* ------------------------------------------------------------------ *
 * Inventory helpers
 * ------------------------------------------------------------------ */

export function lowStockProducts(products, threshold = 5) {
  return products
    .map((p) => ({ product: p, stock: stockOf(p) }))
    .filter((x) => x.stock <= threshold)
    .sort((a, b) => a.stock - b.stock);
}

export const outOfStock = (products) => products.filter((p) => stockOf(p) === 0);

export function stockByCategory(products) {
  const groups = groupBy(products, (p) => p.category);
  return Object.entries(groups).map(([name, list]) => ({
    name,
    count: list.length,
    qty: list.reduce((t, p) => t + stockOf(p), 0),
    value: list.reduce((t, p) => t + stockOf(p) * (Number(p.costPrice) || 0), 0),
  }));
}
