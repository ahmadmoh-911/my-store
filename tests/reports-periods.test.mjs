/**
 * Store Hub — the reports "sales path" per period.
 *
 *   node tests/reports-periods.test.mjs
 *
 * The dashboard's مسار المبيعات card (اليوم / الأسبوع / الشهر) must draw
 * REAL sale records with an axis that belongs to the chosen period:
 *   day   → the 24 hours of that day
 *   week  → the 7 days ending at that day
 *   month → the days of that month (1st → today, or the full month for a
 *           past month)
 * These tests hold known invoices against `trendSeries` (js/screens/reports.js)
 * and would go red if the chart ever ignored the period again.
 */

import { trendSeries } from '../js/reports-math.js';

let passed = 0;
let failed = 0;
const failures = [];
let _sectionStart = 0;
let _sectionFailed = 0;

function ok(label, condition, detail = '') {
  if (condition) {
    passed++;
    return;
  }
  failed++;
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ''}`);
}

function section(title) {
  if (_sectionStart) console.log(`   (${passed - _sectionStart} passed, ${failed - _sectionFailed} failed)`);
  _sectionStart = passed;
  _sectionFailed = failed;
  console.log(`\n${title}`);
}

const sale = (date, total) => ({ timestamp: date.toISOString(), total });

/* ------------------------------------------------------------------ *
 * 1 · day = the 24 hours of THAT day
 * ------------------------------------------------------------------ */

section('1 · اليوم = ساعات ذلك اليوم (24 محورًا)');

const day = new Date(2026, 0, 7); // أربعاء 7 يناير 2026، محليًا
const daySales = [
  sale(new Date(2026, 0, 7, 9, 15), 100),
  sale(new Date(2026, 0, 7, 9, 50), 50),   // نفس الساعة تتجمع
  sale(new Date(2026, 0, 7, 14, 0), 200),
  sale(new Date(2026, 0, 6, 10, 0), 999),  // أمس — يجب أن يُستبعد
  sale(new Date(2026, 0, 8, 10, 0), 999),  // غدًا — يجب أن يُستبعد
];
const d = trendSeries(daySales, 'day', day);

ok('المحاور 24 ساعة', d.labels.length === 24, `got ${d.labels.length}`);
ok('مجموع اليوم = فواتير ذلك اليوم فقط', d.total === 350, `got ${d.total}`);
ok('ساعة 9 ص فيها 150', d.values[9] === 150, `got ${d.values[9]}`);
ok('ساعة 2 م فيها 200', d.values[14] === 200, `got ${d.values[14]}`);
ok('ساعة 10 ص صفر (فواتيرها ليوم آخر)', d.values[10] === 0, `got ${d.values[10]}`);

/* ------------------------------------------------------------------ *
 * 2 · week = the 7 days ending at ref
 * ------------------------------------------------------------------ */

section('2 · الأسبوع = أيامه السبعة حتى اليوم');

const weekSales = [
  sale(new Date(2026, 0, 1, 12, 0), 10),   // خميس
  sale(new Date(2026, 0, 5, 12, 0), 60),   // إثنين
  sale(new Date(2026, 0, 5, 18, 0), 40),   // إثنين مرة أخرى
  sale(new Date(2026, 0, 7, 12, 0), 250),  // الأربعاء (ref)
  sale(new Date(2026, 0, 8, 12, 0), 999),  // بعد الأسبوع — مستبعد
  sale(new Date(2025, 11, 31, 12, 0), 999), // قبل الأسبوع — مستبعد
];
const w = trendSeries(weekSales, 'week', day);

ok('المحاور 7 أيام', w.labels.length === 7, `got ${w.labels.length}`);
ok('المجموع = فواتير الأسبوع فقط', w.total === 360, `got ${w.total}`);
ok('آخر محور هو يوم الـ ref نفسه', w.values[6] === 250, `got ${w.values[6]}`);
ok('يوم الإثنين (قبل يومين) فيه 100', w.values[4] === 100, `got ${w.values[4]}`);
ok('أول الأسبوع (خميس 1/1) فيه 10', w.values[0] === 10, `got ${w.values[0]}`);
ok('أيام بلا فواتير = صفر', w.values[1] === 0 && w.values[2] === 0, `got ${w.values[1]},${w.values[2]}`);

/* ------------------------------------------------------------------ *
 * 3 · month = the days of that month
 * ------------------------------------------------------------------ */

section('3 · الشهر = أيامه (شهر ماضٍ كامل، والشهر الحالي حتى اليوم)');

const monthSales = [
  sale(new Date(2026, 1, 3, 12, 0), 120),   // 3 فبراير
  sale(new Date(2026, 1, 28, 12, 0), 80),   // 28 فبراير
  sale(new Date(2026, 1, 28, 20, 0), 20),   // 28 فبراير مرة أخرى
  sale(new Date(2026, 1, 15, 12, 0), 0),    // فاتورة صفرية تُحسب صفرًا
  sale(new Date(2026, 2, 1, 12, 0), 999),   // مارس — مستبعد
  sale(new Date(2026, 0, 31, 12, 0), 999),  // يناير — مستبعد
];
const m = trendSeries(monthSales, 'month', new Date(2026, 1, 10));

ok('فبراير 2026 = 28 يومًا (شهر ماضٍ كامل)', m.labels.length === 28, `got ${m.labels.length}`);
ok('آخر محور هو اليوم 28', m.labels[27] === '28', `got ${m.labels[27]}`);
ok('المجموع = فواتير الشهر فقط', m.total === 220, `got ${m.total}`);
ok('اليوم 3 فيه 120', m.values[2] === 120, `got ${m.values[2]}`);
ok('اليوم 28 فيه 100', m.values[27] === 100, `got ${m.values[27]}`);
ok('الأيام الفارغة صفر', m.values[0] === 0, `got ${m.values[0]}`);

const now = new Date();
const m2 = trendSeries(monthSales, 'month', now);
ok('الشهر الحالي محاوره حتى اليوم فقط', m2.labels.length === now.getDate(), `got ${m2.labels.length}`);

/* ------------------------------------------------------------------ *
 * 4 · three periods of the SAME sales give different totals
 * ------------------------------------------------------------------ */

section('4 · نفس الفواتير، ثلاث فترات، ثلاث إجماليات مختلفة');

const mixed = [
  sale(new Date(2026, 0, 7, 9, 0), 100),      // داخل اليوم والأسبوع والشهر
  sale(new Date(2026, 0, 5, 9, 0), 200),      // داخل الأسبوع والشهر
  sale(new Date(2026, 0, 15, 9, 0), 400),     // داخل الشهر فقط (خارج الأسبوع)
  sale(new Date(2025, 11, 20, 9, 0), 800),    // خارج الثلاثة
];
ok('اليوم = 100', trendSeries(mixed, 'day', day).total === 100);
ok('الأسبوع = 300', trendSeries(mixed, 'week', day).total === 300);
ok('الشهر = 700', trendSeries(mixed, 'month', day).total === 700);

console.log(`   (${passed - _sectionStart} passed, ${failed - _sectionFailed} failed)`);
console.log('\n========================================================');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('========================================================');
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed ? 1 : 0);
