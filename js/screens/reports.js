/**
 * Reports — date-ranged KPIs, charts and CSV / PDF export.
 *
 * PDF export uses the browser's print pipeline (a dedicated print stylesheet)
 * rather than a library, because jsPDF cannot shape Arabic text correctly —
 * printing gives a pixel-perfect Arabic document and works fully offline.
 */
import { icon } from '../icons.js';
import { printPage } from '../native.js';
import {
  el, fromHTML, clear, moneyHTML, num, numInt, isoDate, dayKeyOf, startOfDay, endOfDay,
  addDays, fmtDate, fmtTime, downloadText, toCSV, wait,
} from '../utils.js';
import { listProducts, listSales, getSettings } from '../db.js';
import {
  salesBetween, revenue, orderCount, profit, avgBasket, unitsSold, discountGiven,
  bestSellers, categoryTotals, paymentBreakdown,
} from '../analytics.js';
import { barChart, doughnutChart, destroyCharts } from '../charts.js';
import { pageHead, emptyState, sectionTitle, toast } from '../components.js';
import { openInvoiceSheet } from '../invoice-sheet.js';
import { navigate } from '../router.js';

/** Never draw more buckets than this — a 3-year custom range would melt the canvas. */
const MAX_BUCKETS = 120;

const PRESETS = [
  { id: 'today', label: 'اليوم' },
  { id: 'yesterday', label: 'أمس' },
  { id: '7', label: 'آخر ٧ أيام' },
  { id: '30', label: 'آخر ٣٠ يوم' },
  { id: 'month', label: 'هذا الشهر' },
  { id: 'custom', label: 'مخصص' },
];

let range = { preset: '7', from: null, to: null };

export function render() {
  const root = el('div.screen', { id: 'screen-reports' });

  root.appendChild(
    pageHead({
      title: 'التقارير',
      sub: 'أداء المبيعات والأرباح خلال فترة محددة',
      actions: [
        el('button.btn.btn--soft', { type: 'button', onClick: () => exportCSV() }, fromHTML(icon('download')), el('span', { text: 'CSV' })),
        el('button.btn.btn--primary', { type: 'button', onClick: () => exportPDF() }, fromHTML(icon('printer')), el('span', { text: 'PDF' })),
      ],
    })
  );

  const now = new Date();
  range.from = startOfDay(addDays(now, -6));
  range.to = endOfDay(now);

  root.appendChild(
    el(
      'div.range-row',
      { id: 'range-row' },
      el(
        'div.chip-row',
        {},
        ...PRESETS.map((p) =>
          el(`button.chip${range.preset === p.id ? '.is-active' : ''}`, {
            type: 'button',
            text: p.label,
            dataset: { preset: p.id },
            onClick: () => setPreset(p.id),
          })
        )
      ),
      el(
        'div.range-inputs',
        { id: 'range-inputs', hidden: range.preset !== 'custom' },
        fromHTML(icon('calendar')),
        el('input', { type: 'date', id: 'date-from', value: isoDate(range.from), onchange: (e) => onCustom('from', e.target.value) }),
        el('span', { text: '→' }),
        el('input', { type: 'date', id: 'date-to', value: isoDate(range.to), onchange: (e) => onCustom('to', e.target.value) })
      )
    )
  );

  root.appendChild(el('div.kpi-grid', { id: 'report-kpis' }));
  root.appendChild(el('div', { id: 'report-body' }));

  paint(root);
  return root;
}

/* ------------------------------------------------------------------ *
 * Range handling
 * ------------------------------------------------------------------ */

function setPreset(id) {
  range.preset = id;
  const now = new Date();
  switch (id) {
    case 'today':
      range.from = startOfDay(now);
      range.to = endOfDay(now);
      break;
    case 'yesterday':
      range.from = startOfDay(addDays(now, -1));
      range.to = endOfDay(addDays(now, -1));
      break;
    case '7':
      range.from = startOfDay(addDays(now, -6));
      range.to = endOfDay(now);
      break;
    case '30':
      range.from = startOfDay(addDays(now, -29));
      range.to = endOfDay(now);
      break;
    case 'month':
      range.from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      range.to = endOfDay(now);
      break;
    default:
      return refreshChips();
  }
  refreshChips();
  paint();
}

function refreshChips() {
  const row = document.getElementById('screen-reports');
  if (!row) return;
  row.querySelectorAll('#range-row .chip').forEach((c) =>
    c.classList.toggle('is-active', c.dataset.preset === range.preset)
  );
  const box = row.querySelector('#range-inputs');
  if (box) box.hidden = range.preset !== 'custom';
}

function onCustom(which, value) {
  if (!value) return;
  const d = new Date(`${value}T00:00:00`);
  if (which === 'from') range.from = startOfDay(d);
  else range.to = endOfDay(d);
  if (range.from > range.to) [range.from, range.to] = [range.to, range.from];
  paint();
}

const daysIn = () => Math.max(1, Math.round((endOfDay(range.to) - startOfDay(range.from)) / 86400000) + 1);

/**
 * One bucket per day, oldest first. Very long ranges are clipped to the most
 * recent MAX_BUCKETS days so the chart stays legible (and the loop bounded).
 */
function dailyBuckets(sales) {
  const total = daysIn();
  const clipped = total > MAX_BUCKETS;
  const days = clipped ? MAX_BUCKETS : total;

  const byDay = new Map();
  for (const s of sales) {
    const key = dayKeyOf(s.timestamp);
    byDay.set(key, (byDay.get(key) || 0) + s.total);
  }

  const labels = [];
  const values = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = addDays(range.to, -i);
    labels.push(`${d.getDate()}/${d.getMonth() + 1}`);
    values.push(byDay.get(isoDate(d)) || 0);
  }
  return { labels, values, clipped, total };
}

/* ------------------------------------------------------------------ *
 * Paint
 * ------------------------------------------------------------------ */

let snapshot = null; // {sales, products, settings}
let paintToken = 0;

async function paint(screenRoot) {
  const token = ++paintToken;
  const root = screenRoot || document.getElementById('screen-reports');
  const kpis = root?.querySelector('#report-kpis');
  const body = root?.querySelector('#report-body');
  if (!kpis || !body) return;

  clear(kpis);
  clear(body);
  body.appendChild(el('div.loading-row', {}, el('i.spinner.spinner--ink'), el('span', { text: 'جارٍ إعداد التقرير…' })));

  const [allSales, products, settings] = await Promise.all([listSales(), listProducts(), getSettings()]);
  if (token !== paintToken || !body.isConnected) return;

  const sales = salesBetween(allSales, range.from, range.to);
  snapshot = { sales, products, settings };

  const cur = settings.currency;
  const rev = revenue(sales);
  const pr = profit(sales);
  const orders = orderCount(sales);
  const basket = avgBasket(sales);

  clear(kpis);
  const cards = [
    { label: 'إجمالي المبيعات', value: rev, money: true, icon: 'trendingUp', tone: '' },
    { label: 'صافي الربح', value: pr, money: true, icon: 'coins', tone: 'emerald' },
    { label: 'عدد العمليات', value: orders, icon: 'receipt', tone: 'brass' },
    { label: 'متوسط السلة', value: basket, money: true, icon: 'bag', tone: '' },
  ];
  cards.forEach((c, i) => {
    const node = el(
      'div.stat.fade-up',
      { style: 'animation-delay:' + i * 55 + 'ms' },
      el('div.stat__top', {}, el(`div.stat__icon${c.tone ? '.stat__icon--' + c.tone : ''}`, {}, fromHTML(icon(c.icon))), el('div.stat__label', { text: c.label })),
      // `html`, not `text`: the money branch returns moneyHTML's currency chip.
      // Both branches are safe here — numInt emits digits/separators only, and
      // moneyHTML already escapes the currency code.
      el('div.stat__value', {}, el('span', { html: c.money ? moneyHTML(c.value, cur) : numInt(c.value) }))
    );
    kpis.appendChild(node);
    const span = node.querySelector('.stat__value span');
    // count money up too
    span.animate([{ opacity: 0.35, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }], { duration: 520, easing: 'cubic-bezier(.16,1,.3,1)' });
  });

  clear(body);

  if (!sales.length) {
    body.appendChild(
      emptyState({
        iconName: 'chart',
        title: 'لا توجد مبيعات في هذه الفترة',
        text: 'جرّب توسيع نطاق التاريخ أو أجرِ بعض العمليات أولاً.',
        action: el('button.btn.btn--primary', { type: 'button', onClick: () => navigate('pos') }, fromHTML(icon('cart')), el('span', { text: 'فتح نقطة البيع' })),
      })
    );
    return;
  }

  /* --- daily bar chart ---------------------------------------------- */
  const { labels, values, clipped, total: span } = dailyBuckets(sales);

  body.appendChild(
    el(
      'div.card.chart-card',
      { style: 'margin-bottom:16px' },
      el(
        'div.card-head',
        {},
        fromHTML(icon('chart')),
        el('h3', { text: 'المبيعات اليومية' }),
        el('span.rate-line', {}, fromHTML(icon('coins')), el('span', { html: moneyHTML(rev, cur) }))
      ),
      el('div.chart-box', {}, el('canvas', { id: 'rep-daily' })),
      el(
        'div.chart-foot',
        {},
        el('span', { text: clipped ? `آخر ${values.length} يوم من ${span} · ${unitsSold(sales)} قطعة مباعة` : `${span} يوم · ${unitsSold(sales)} قطعة مباعة` }),
        el('span', { text: `خصومات ${num(discountGiven(sales))} ${cur}` })
      )
    )
  );

  /* --- breakdowns ---------------------------------------------------- */
  const cats = categoryTotals(sales, products);
  const pays = paymentBreakdown(sales);
  const top = bestSellers(sales, 6);

  const cols = el('div.report-cols');

  if (cats.length > 1) {
    cols.appendChild(
      el(
        'div.card.chart-card',
        {},
        el('div.card-head', {}, fromHTML(icon('layers')), el('h3', { text: 'المبيعات حسب التصنيف' })),
        el('div.chart-box.chart-box--sm', {}, el('canvas', { id: 'rep-cats' }))
      )
    );
  }

  if (pays.length > 1) {
    cols.appendChild(
      el(
        'div.card.chart-card',
        {},
        el('div.card-head', {}, fromHTML(icon('wallet')), el('h3', { text: 'طرق الدفع' })),
        el('div.chart-box.chart-box--sm', {}, el('canvas', { id: 'rep-pays' }))
      )
    );
  }

  body.appendChild(cols);

  /* --- best sellers --------------------------------------------------- */
  body.appendChild(
    el(
      'div.card.chart-card',
      { style: 'margin-top:16px' },
      el('div.card-head', {}, fromHTML(icon('star')), el('h3', { text: 'المنتجات الأكثر مبيعاً' })),
      el(
        'div.rank-list',
        {},
        ...top.map((p, i) =>
          el(
            'div.rank',
            { style: `animation-delay:${i * 55}ms` },
            el('span.rank__n', { text: String(i + 1) }),
            el(
              'div.rank__main',
              {},
              el('div.rank__name', { text: p.name }),
              el('div.bar.rank__bar', {}, el('i', { style: `width:${Math.max(7, (p.revenue / top[0].revenue) * 100)}%` }))
            ),
            el('div.rank__val', {}, el('span', { html: moneyHTML(p.revenue, cur) }), el('small', { text: `${p.qty} قطعة` }))
          )
        )
      )
    )
  );

  /* --- category ranking (when the doughnut is hidden) ------------------ */
  if (cats.length === 1) {
    body.appendChild(
      el(
        'div.card.card--pad',
        { style: 'margin-top:16px' },
        sectionTitle('تصنيف المبيعات', { iconName: 'tag' }),
        el(
          'div.rank-list',
          {},
          ...cats.map((c) =>
            el(
              'div.rank',
              {},
              el('span.rank__n', { text: '1' }),
              el('div.rank__main', {}, el('div.rank__name', { text: c.name })),
              el('div.rank__val', { html: moneyHTML(c.value, cur) })
            )
          )
        )
      )
    );
  }

  /* --- sales / invoice history --------------------------------------- */
  // Reports is where an owner looks for "where are my invoices", so the list
  // lives here rather than only on the Dashboard. It reads the same `sales`
  // already filtered to the selected range, and opens the very same
  // openInvoiceSheet() sheet the Dashboard uses — no second invoice screen and
  // no new storage: editing or refunding here goes through db.updateSale /
  // db.refundSale exactly as before.
  const history = sales.slice().sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  const HISTORY_PAGE = 25;

  const repaint = () => {
    const r = document.getElementById('screen-reports');
    if (r && r.isConnected) paint(r);
  };

  const historyCard = el(
    'div.card.card--pad',
    { id: 'report-history', style: 'margin-top:16px' },
    el(
      'div.card-head',
      {},
      fromHTML(icon('receipt')),
      el('h3', { text: 'سجل الفواتير' }),
      el('span.tiny.muted', { text: `${history.length} فاتورة` })
    )
  );

  const historyList = el('div.inv-list');
  for (const s of history.slice(0, HISTORY_PAGE)) historyList.appendChild(invoiceRow(s, cur, repaint));
  historyCard.appendChild(historyList);

  if (history.length > HISTORY_PAGE) {
    let shown = HISTORY_PAGE;
    historyCard.appendChild(
      el('button.card-head__action.card-head__action--block', {
        type: 'button',
        text: `عرض المزيد (${history.length - shown} فاتورة)`,
        onClick: (e) => {
          shown = Math.min(shown + HISTORY_PAGE, history.length);
          clear(historyList);
          for (const s of history.slice(0, shown)) historyList.appendChild(invoiceRow(s, cur, repaint));
          if (shown >= history.length) e.currentTarget.remove();
          else e.currentTarget.textContent = `عرض المزيد (${history.length - shown} فاتورة)`;
        },
      })
    );
  }
  body.appendChild(historyCard);

  /* --- draw ----------------------------------------------------------- */
  destroyCharts();
  await wait(30);
  if (!document.getElementById('rep-daily')) return;

  barChart(document.getElementById('rep-daily'), { labels, values, currency: cur });
  if (cats.length > 1 && document.getElementById('rep-cats')) {
    doughnutChart(document.getElementById('rep-cats'), {
      labels: cats.map((c) => c.name),
      values: cats.map((c) => c.value),
      currency: cur,
    });
  }
  if (pays.length > 1 && document.getElementById('rep-pays')) {
    doughnutChart(document.getElementById('rep-pays'), {
      labels: pays.map((p) => p.name),
      values: pays.map((p) => p.value),
      currency: cur,
    });
  }
}

/* ------------------------------------------------------------------ *
 * Invoice history row
 * ------------------------------------------------------------------ */

/**
 * One sale in the history list. Uses the same `.inv-row` markup as the
 * Dashboard's day list so the existing stylesheet applies unchanged, and opens
 * the shared openInvoiceSheet() — which handles edit and refund via
 * db.updateSale / db.refundSale and calls `refresh` afterwards so the report
 * re-reads the corrected numbers.
 */
function invoiceRow(sale, cur, refresh) {
  const items = sale.items || [];
  return el(
    'button.inv-row',
    { type: 'button', onClick: () => openInvoiceSheet(sale, { onChanged: refresh, onRefund: refresh }) },
    el('span.inv-row__no', { text: sale.receiptNo || '—' }),
    el(
      'span.inv-row__meta',
      {},
      el('span', { text: `${items.length} صنف` }),
      el('span.tiny.muted', { text: `${fmtDate(new Date(sale.timestamp), true)} · ${fmtTime(new Date(sale.timestamp))}` })
    ),
    el('span.inv-row__sum', { html: moneyHTML(sale.total, cur) })
  );
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

async function exportCSV() {
  if (!snapshot || !snapshot.sales.length) {
    toast('لا توجد بيانات لتصديرها', 'warn');
    return;
  }
  const { sales, products, settings } = snapshot;
  const cur = settings.currency;
  const byId = new Map(products.map((p) => [p.id, p]));

  const rows = [
    ['تقرير مبيعات'],
    ['من', isoDate(range.from), 'إلى', isoDate(range.to)],
    ['الإجمالي', revenue(sales), 'الربح', profit(sales), 'العمليات', orderCount(sales)],
    [],
    ['رقم الفاتورة', 'التاريخ', 'المنتج', 'التصنيف', 'المقاس', 'اللون', 'الكمية', 'سعر البيع', 'التكلفة', 'إجمالي السطر', 'خصم الفاتورة', 'إجمالي الفاتورة', 'الدفع'],
  ];

  for (const s of sales) {
    for (const it of s.items) {
      const p = byId.get(it.productId);
      rows.push([
        s.receiptNo,
        new Date(s.timestamp).toLocaleString('ar-SA'),
        it.name,
        p ? p.category : '',
        it.size || '',
        it.color || '',
        it.qty,
        it.price,
        it.costPrice || 0,
        (it.qty * it.price).toFixed(2),
        s.discount || 0,
        s.total,
        { cash: 'نقود', card: 'بطاقة', transfer: 'تحويل' }[s.paymentMethod] || '',
      ]);
    }
  }

  rows.push([]);
  rows.push(['الإجمالي', '', '', '', '', '', unitsSold(sales), '', '', '', '', revenue(sales), '']);

  const saved = await downloadText(
    toCSV(rows),
    `saher-report_${isoDate(range.from)}_${isoDate(range.to)}.csv`,
    'text/csv;charset=utf-8'
  );
  toast(saved ? 'تم تصدير ملف CSV' : 'تعذّر تصدير ملف CSV', saved ? 'ok' : 'err');
}

function exportPDF() {
  if (!snapshot || !snapshot.sales.length) {
    toast('لا توجد بيانات لتصديرها', 'warn');
    return;
  }
  const { sales, products, settings } = snapshot;
  const cur = settings.currency;
  const byId = new Map(products.map((p) => [p.id, p]));
  const cats = categoryTotals(sales, products);
  const top = bestSellers(sales, 8);

  const tableRows = sales
    .flatMap((s) =>
      s.items.map((it) => ({
        receipt: s.receiptNo,
        date: fmtDate(s.timestamp, true),
        name: it.name,
        cat: (byId.get(it.productId) || {}).category || '',
        qty: it.qty,
        total: it.qty * it.price,
        payment: { cash: 'نقود', card: 'بطاقة', transfer: 'تحويل' }[s.paymentMethod] || '',
      }))
    )
    .slice(0, 400);

  const root = document.getElementById('print-root');
  clear(root);

  const wrap = el('div', { style: 'font-family:var(--font);color:#211d1d' });
  wrap.appendChild(
    el(
      'div',
      { style: 'display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:2px solid #6b1d2f;padding-bottom:12px;margin-bottom:16px' },
      el(
        'div',
        {},
        el('h1', { style: 'font-size:22px;color:#6b1d2f;margin:0', text: 'تقرير المبيعات' }),
        el('div', { style: 'font-size:13px;color:#5e4a4e;margin-top:4px', text: `${settings.storeName} · من ${fmtDate(range.from)} إلى ${fmtDate(range.to)}` })
      ),
      settings.logo
        ? el('img', { src: settings.logo, style: 'width:56px;height:56px;border-radius:14px;object-fit:cover' })
        : el('div', { style: 'width:56px;height:56px;border-radius:14px;background:#6b1d2f;color:#fff;display:grid;place-items:center', html: icon('hanger') })
    )
  );

  wrap.appendChild(
    el(
      'div',
      { style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px' },
      kpiBox('إجمالي المبيعات', moneyHTML(revenue(sales), cur)),
      kpiBox('صافي الربح', moneyHTML(profit(sales), cur)),
      kpiBox('العمليات', numInt(orderCount(sales))),
      kpiBox('متوسط السلة', moneyHTML(avgBasket(sales), cur))
    )
  );

  if (cats.length) {
    wrap.appendChild(
      el(
        'div',
        { style: 'margin-bottom:16px' },
        el('h2', { style: 'font-size:16px;margin-bottom:7px', text: 'حسب التصنيف' }),
        el(
          'table',
          { style: 'width:100%;border-collapse:collapse;font-size:13px' },
          el('thead', {}, el('tr', {}, th('التصنيف'), th('الإجمالي'))),
          el('tbody', {}, ...cats.map((c) => el('tr', {}, td(c.name), td(moneyHTML(c.value, cur), 'end'))))
        )
      )
    );
  }

  if (top.length) {
    wrap.appendChild(
      el(
        'div',
        { style: 'margin-bottom:16px' },
        el('h2', { style: 'font-size:16px;margin-bottom:7px', text: 'الأكثر مبيعاً' }),
        el(
          'table',
          { style: 'width:100%;border-collapse:collapse;font-size:13px' },
          el('thead', {}, el('tr', {}, th('#'), th('المنتج'), th('الكمية'), th('الإيراد'))),
          el('tbody', {}, ...top.map((p, i) => el('tr', {}, td(String(i + 1)), td(p.name), td(numInt(p.qty)), td(moneyHTML(p.revenue, cur), 'end'))))
        )
      )
    );
  }

  wrap.appendChild(
    el(
      'div',
      {},
      el('h2', { style: 'font-size:16px;margin-bottom:7px', text: `التفاصيل (${tableRows.length} سطر)` }),
      el(
        'table',
        { style: 'width:100%;border-collapse:collapse;font-size:12px' },
        el('thead', {}, el('tr', {}, th('الفاتورة'), th('التاريخ'), th('المنتج'), th('التصنيف'), th('الكمية'), th('الإجمالي'), th('الدفع'))),
        el(
          'tbody',
          {},
          ...tableRows.map((r) =>
            el('tr', {}, td(r.receipt), td(r.date), td(r.name), td(r.cat), td(numInt(r.qty)), td(moneyHTML(r.total, cur), 'end'), td(r.payment))
          )
        )
      )
    )
  );

  wrap.appendChild(
    el('div', { style: 'margin-top:20px;padding-top:10px;border-top:1px dashed #c9b8a8;font-size:12px;color:#8f787c;text-align:center', text: `تم الإنشاء ${fmtDate(new Date(), true)} · ${settings.storeName}` })
  );

  root.appendChild(wrap);
  setTimeout(() => printPage().catch((err) => {
    console.warn('[print] failed', err);
    toast('تعذّر فتح نافذة الطباعة', 'err');
  }), 80);
}

const th = (t) => el('th', { style: 'text-align:start;padding:6px 8px;background:#f3ece2;font-weight:700;font-size:12px;border-bottom:1px solid #e0d5c6', text: t });
const td = (t, align = 'start') =>
  el('td', { style: `text-align:${align};padding:6px 8px;border-bottom:1px solid #efe7dc`, html: t });
const kpiBox = (label, value) =>
  el('div', { style: 'padding:11px;background:#faf7f2;border:1px solid #eae0d2;border-radius:10px' },
    el('div', { style: 'font-size:11px;color:#8f787c;font-weight:600', text: label }),
    el('div', { style: 'font-size:17px;font-weight:700;margin-top:3px', html: value }));

export function destroy() {
  destroyCharts();
}

export default { render, destroy };
