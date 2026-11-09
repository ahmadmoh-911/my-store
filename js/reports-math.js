/**
 * Pure period math for the reports and dashboard trend charts.
 *
 * Split out of js/screens/reports.js so node tests can hold the numbers to
 * account (tests/reports-periods.test.mjs) without dragging the screen, the
 * router or a DOM into the import. No UI imports here — on purpose.
 */
import { isoDate, dayKeyOf, startOfDay, endOfDay, addDays, sum } from './utils.js';

/*
 * Pure and exported ON PURPOSE: the Dashboard's "مسار المبيعات" card
 * (اليوم / الأسبوع / الشهر) and this screen's range chart draw from the
 * same calculation, and tests/reports-periods.test.mjs holds the numbers
 * to account. Every bucket is derived from real sale records (db.listSales)
 * filtered to the period — nothing is stored, nothing hard-coded.
 * ------------------------------------------------------------------ */

export const MAX_BUCKETS = 120;
const AR_DAYS_SHORT = ['أحد', 'إثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'];
const hourLabel = (h) => `${h % 12 || 12} ${h < 12 ? 'ص' : 'م'}`;

/** sale.total summed per LOCAL calendar day (the same key the reports use). */
const totalsByDay = (sales) => {
  const byDay = new Map();
  for (const s of sales) {
    const key = dayKeyOf(s.timestamp);
    if (!key) continue;
    byDay.set(key, (byDay.get(key) || 0) + (Number(s.total) || 0));
  }
  return byDay;
};

/** sale.total summed per hour (0–23) of ONE local day. */
const totalsByHour = (sales, day) => {
  const values = new Array(24).fill(0);
  const key = isoDate(startOfDay(day));
  for (const s of sales) {
    if (dayKeyOf(s.timestamp) !== key) continue;
    values[new Date(s.timestamp).getHours()] += Number(s.total) || 0;
  }
  return values;
};

/**
 * The "مسار المبيعات" series for a fixed period, anchored at `ref`
 * (today in the app). Each period owns its own axis, so switching the
 * period really does move both the data and the ticks:
 *
 *   'day'   → the 24 hours of that day
 *   'week'  → the 7 days ending at that day (weekday-name labels)
 *   'month' → the days of that month: 1st → ref for the current month,
 *             the full month for any other
 *
 * @param {Array} sales ALL sales (db.listSales()) — period filtering happens here
 * @param {'day'|'week'|'month'} period
 * @param {Date} [ref]
 * @returns {{labels:string[], values:number[], total:number}}
 */
export function trendSeries(sales, period, ref = new Date()) {
  if (period === 'day') {
    const values = totalsByHour(sales, ref);
    return { labels: Array.from({ length: 24 }, (_, h) => hourLabel(h)), values, total: sum(values) };
  }

  if (period === 'week') {
    const byDay = totalsByDay(sales);
    const labels = [];
    const values = [];
    for (let i = 6; i >= 0; i--) {
      const d = addDays(startOfDay(ref), -i);
      labels.push(AR_DAYS_SHORT[d.getDay()]);
      values.push(byDay.get(isoDate(d)) || 0);
    }
    return { labels, values, total: sum(values) };
  }

  // 'month' — the days of the month itself, not a rolling 30-day window.
  const byDay = totalsByDay(sales);
  const now = new Date();
  const isCurrentMonth = ref.getFullYear() === now.getFullYear() && ref.getMonth() === now.getMonth();
  const first = new Date(ref.getFullYear(), ref.getMonth(), 1);
  const last = isCurrentMonth ? startOfDay(ref) : new Date(ref.getFullYear(), ref.getMonth() + 1, 0);
  const count = Math.round((last - first) / 86400000) + 1;
  const labels = [];
  const values = [];
  for (let i = 0; i < count; i++) {
    const d = addDays(first, i);
    labels.push(String(d.getDate()));
    values.push(byDay.get(isoDate(d)) || 0);
  }
  return { labels, values, total: sum(values) };
}

/**
 * This screen's range-chart buckets, sized to the range the owner picked:
 *
 *   one day      → the 24 hours of that day (اليوم / أمس stop being one fat bar)
 *   2–7 days     → one bucket per day with weekday-name labels (أسبوع = ٧ أيام)
 *   8–120 days   → one bucket per day, "يوم/شهر" labels (الشهر = أيام الشهر)
 *   longer       → daily buckets clipped to the most recent MAX_BUCKETS days
 *
 * @param {Array} sales the sales ALREADY filtered to [from, to] (salesBetween)
 * @param {Date} from
 * @param {Date} to
 * @returns {{labels:string[], values:number[], clipped:boolean, total:number,
 *            mode:'hours'|'days'}}
 */
export function rangeBuckets(sales, from, to) {
  const span = Math.max(1, Math.round((endOfDay(to) - startOfDay(from)) / 86400000) + 1);

  if (span <= 1) {
    return {
      labels: Array.from({ length: 24 }, (_, h) => hourLabel(h)),
      values: totalsByHour(sales, from),
      clipped: false,
      total: span,
      mode: 'hours',
    };
  }

  const clipped = span > MAX_BUCKETS;
  const days = clipped ? MAX_BUCKETS : span;
  const byDay = totalsByDay(sales);
  const labels = [];
  const values = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = addDays(to, -i);
    labels.push(span <= 7 ? AR_DAYS_SHORT[d.getDay()] : `${d.getDate()}/${d.getMonth() + 1}`);
    values.push(byDay.get(isoDate(d)) || 0);
  }
  return { labels, values, clipped, total: span, mode: 'days' };
}
