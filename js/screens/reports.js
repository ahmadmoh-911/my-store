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
  addDays, fmtDate, fmtTime, downloadText, toCSV, wait, sum,
} from '../utils.js';
import { listProducts, listSales, listPurchases, listRefunds, storeLedger, getSettings } from '../db.js';
import {
  salesBetween, netRevenue, netProfit, orderCount, profit, avgBasket, unitsSold, discountGiven,
  bestSellers, categoryTotals, paymentBreakdown, refundsTotal,
} from '../analytics.js';
import { barChart, doughnutChart, destroyCharts } from '../charts.js';
import { pageHead, emptyState, sectionTitle, toast, saleRow } from '../components.js';
import { openInvoiceSheet } from '../invoice-sheet.js';
import { trendSeries, rangeBuckets } from '../reports-math.js';
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

let range = { preset: 'today', from: null, to: null };

/**
 * The invoice list is the screen's job; the charts are the extra. Reports used
 * to open on "آخر ٧ أيام" and bury the invoices under four chart cards, so an
 * owner looking for today's sales had to scroll past a trend graph, two
 * doughnuts and a best-sellers ranking to find them. The range now opens on
 * today, the invoices come first, and the analysis sits behind one tap.
 */
let showAnalysis = false;

export function render() {
  const root = el('div.screen', { id: 'screen-reports' });

  root.appendChild(
    pageHead({
      title: 'التقارير',
      sub: 'فواتير المبيعات وأداءها خلال فترة محددة',
      actions: [
        el('button.btn.btn--soft', { type: 'button', onClick: () => exportCSV() }, fromHTML(icon('download')), el('span', { text: 'CSV' })),
        el('button.btn.btn--primary', { type: 'button', onClick: () => exportPDF() }, fromHTML(icon('printer')), el('span', { text: 'PDF' })),
      ],
    })
  );

  const now = new Date();
  range.from = startOfDay(now);
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

/* ------------------------------------------------------------------ *
 * مسار المبيعات — the series behind both trend charts.
 *
 * The pure math (trendSeries / rangeBuckets) lives in js/reports-math.js so
 * node tests can hold the numbers to account without the screen or router.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Paint
 * ------------------------------------------------------------------ */

let snapshot = null; // {sales, products, settings, refunds}
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

  const [allSales, products, settings, allPurchases, allRefunds] = await Promise.all([
    listSales(),
    listProducts(),
    getSettings(),
    listPurchases(),
    listRefunds(),
  ]);
  if (token !== paintToken || !body.isConnected) return;

  const sales = salesBetween(allSales, range.from, range.to);
  const refundsInRange = allRefunds.filter((r) => new Date(r.refundDate) >= range.from && new Date(r.refundDate) <= range.to);
  snapshot = { sales, products, settings, refunds: refundsInRange, allSales, allPurchases };

  const cur = settings.currency;
  const rev = netRevenue(sales, refundsInRange);
  const pr = netProfit(sales, refundsInRange);
  const orders = orderCount(sales);
  const basket = avgBasket(sales);

  // The store balance is deliberately NOT one of these cards. Everything below
  // is a measure of trading inside the selected range; the balance is a measure
  // of money the shop actually holds, and it is derived from ALL sales and ALL
  // restock purchases — not from the range being looked at.
  const ledger = storeLedger(allSales, allPurchases, settings, allRefunds);

  clear(kpis);
  kpis.appendChild(storeBalanceCard(ledger, cur));
  const cards = [
    { label: 'صافي المبيعات', value: rev, money: true, icon: 'trendingUp', tone: '' },
    { label: 'صافي الربح', value: pr, money: true, icon: 'coins', tone: 'emerald' },
    { label: 'عدد العمليات', value: orders, icon: 'receipt', tone: 'brass' },
    { label: 'متوسط السلة', value: basket, money: true, icon: 'bag', tone: '' },
    { label: 'إجمالي المرتجعات', value: refundsTotal(refundsInRange), money: true, icon: 'trendingDown', tone: 'rose' },
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

  /* --- sales / invoice history — the screen's reason for existing ------ */
  // Reports is where an owner looks for "where are my invoices", so the list
  // comes FIRST and reads the same `sales` already filtered to the selected
  // range. It opens the very same openInvoiceSheet() the Dashboard uses — no
  // second invoice screen and no new storage: editing or refunding here goes
  // through db.updateSale / db.refundSale exactly as before.
  const history = sales.slice().sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  const HISTORY_PAGE = 25;

  const repaint = () => {
    const r = document.getElementById('screen-reports');
    if (r && r.isConnected) paint(r);
  };

  const historyCard = el(
    'div.card.card--pad',
    { id: 'report-history' },
    el(
      'div.card-head',
      {},
      fromHTML(icon('receipt')),
      el('h3', { text: 'سجل الفواتير' }),
      el('span.tiny.muted', { text: `${history.length} فاتورة` })
    )
  );

  if (!history.length) {
    historyCard.appendChild(
      emptyState({
        iconName: 'receipt',
        title: 'لا توجد فواتير في هذه الفترة',
        text: 'جرّب توسيع نطاق التاريخ أو أجرِ عملية بيع من نقطة البيع.',
        small: true,
        action: el('button.btn.btn--primary', { type: 'button', onClick: () => navigate('pos') }, fromHTML(icon('cart')), el('span', { text: 'فتح نقطة البيع' })),
      })
    );
  } else {
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
  }
  body.appendChild(historyCard);

  /* --- everything else, behind one tap --------------------------------- */
  const toggle = el('button.card-head__action.card-head__action--block', {
    type: 'button',
    text: showAnalysis ? 'إخفاء التحليلات' : 'عرض التحليلات البيانية',
    onClick: () => {
      showAnalysis = !showAnalysis;
      const r = document.getElementById('screen-reports');
      if (r && r.isConnected) paint(r);
    },
  });

  body.appendChild(
    el(
      'div.card-head',
      { style: 'margin-top:20px;margin-bottom:0' },
      fromHTML(icon('chart')),
      el('h3', { text: 'تحليلات الفترة' })
    )
  );
  body.appendChild(el('div', { style: 'margin-top:10px' }, toggle));

  if (!showAnalysis) return;

  const analysis = el('div', { id: 'report-analysis' });
  body.appendChild(analysis);

  if (!sales.length) return;

  /* --- sales-path bar chart ------------------------------------------ */
  // Buckets adapt to the range: one day → its 24 hours, a week → 7 days,
  // a month → the month's own days (rangeBuckets above).
  const { labels, values, clipped, total: span, mode } = rangeBuckets(sales, range.from, range.to);

  analysis.appendChild(
    el(
      'div.card.chart-card',
      { style: 'margin-bottom:16px' },
      el(
        'div.card-head',
        {},
        fromHTML(icon('chart')),
        el('h3', { text: 'مسار المبيعات' }),
        el('span.rate-line', {}, fromHTML(icon('coins')), el('span', { html: moneyHTML(rev, cur) }))
      ),
      el('div.chart-box', {}, el('canvas', { id: 'rep-daily' })),
      el(
        'div.chart-foot',
        {},
        el('span', {
          text: mode === 'hours'
            ? `٢٤ ساعة · ${unitsSold(sales)} قطعة مباعة`
            : clipped
              ? `آخر ${values.length} يوم من ${span} · ${unitsSold(sales)} قطعة مباعة`
              : `${span} يوم · ${unitsSold(sales)} قطعة مباعة`,
        }),
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

  if (cols.children.length) analysis.appendChild(cols);

  /* --- best sellers --------------------------------------------------- */
  if (top.length) {
    analysis.appendChild(
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
  }

  /* --- category ranking (when the doughnut is hidden) ------------------ */
  if (cats.length === 1) {
    analysis.appendChild(
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
 * One sale in the history list. Delegates to the shared components.saleRow() so
 * a sale reads identically here and on the Dashboard — one field per line — and
 * opens the shared openInvoiceSheet(), which handles edit and refund via
 * db.updateSale / db.refundSale and calls `refresh` afterwards so the report
 * re-reads the corrected numbers.
 *
 * The previous row also printed the clock twice: `fmtDate(ts, true)` already
 * ends in the time, and `fmtTime(ts)` was appended after a "·".
 */
function invoiceRow(sale, cur, refresh) {
  return saleRow(sale, cur, (s) => openInvoiceSheet(s, { onChanged: refresh, onRefund: refresh }));
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
    ['تقرير مبيعات مفصل'],
    ['من', isoDate(range.from), 'إلى', isoDate(range.to)],
    ['إجمالي المبيعات', revenue(sales), 'صافي الربح', profit(sales), 'العمليات', orderCount(sales), 'الكمية المباعة', unitsSold(sales)],
    [],
    ['رقم الفاتورة', 'التاريخ', 'المنتج', 'التصنيف', 'المقاس', 'اللون', 'الكمية', 'سعر البيع', 'سعر التكلفة', 'إيراد السطر', 'تكلفة السطر', 'ربح السطر', 'خصم الفاتورة', 'إجمالي الفاتورة', 'الدفع'],
  ];

  for (const s of sales) {
    for (const it of s.items) {
      const p = byId.get(it.productId);
      const cost = Number(it.costPrice) || 0;
      const revenueLine = it.qty * it.price;
      const costLine = it.qty * cost;
      const profitLine = revenueLine - costLine;
      rows.push([
        s.receiptNo,
        new Date(s.timestamp).toLocaleString('ar-SA'),
        it.name,
        p ? p.category : '',
        it.size || '',
        it.color || '',
        it.qty,
        it.price,
        cost,
        revenueLine.toFixed(2),
        costLine.toFixed(2),
        profitLine.toFixed(2),
        s.discount || 0,
        s.total,
        { cash: 'نقود', card: 'بطاقة', transfer: 'تحويل' }[s.paymentMethod] || '',
      ]);
    }
  }

  rows.push([]);
  const totalProfit = sales.reduce((sum, s) => {
    return sum + s.items.reduce((ls, it) => ls + (it.qty * (it.price - (Number(it.costPrice) || 0))), 0);
  }, 0);
  rows.push(['الإجمالي', '', '', '', '', '', unitsSold(sales), '', '', '', '', totalProfit.toFixed(2), '', revenue(sales), '']);

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
  const { sales, products, settings, allSales, allPurchases, refunds } = snapshot;
  const cur = settings.currency;
  const byId = new Map(products.map((p) => [p.id, p]));

  const returnsInRange = (refunds || [])
    .filter((r) => new Date(r.refundDate) >= range.from && new Date(r.refundDate) <= range.to);

  // Build inventory rows (same logic as reports screen)
  const inventoryByCat = new Map();
  for (const p of products) {
    const cat = p.category || 'غير مصنف';
    const stock = p.variants?.reduce((s, v) => s + (Number(v.quantity) || 0), 0) || 0;
    // Average cost from remaining lots (FIFO layers) — same as storeBalanceCard
    let avgCost = 0;
    if (p.variants?.length) {
      let totalQty = 0, totalCost = 0;
      for (const v of p.variants) {
        const q = Number(v.quantity) || 0;
        const c = Number(v.costPrice) || 0;
        if (q > 0) { totalQty += q; totalCost += q * c; }
      }
      avgCost = totalQty > 0 ? totalCost / totalQty : 0;
    } else {
      avgCost = Number(p.costPrice) || 0;
    }
    const val = stock * avgCost;
    const curVal = inventoryByCat.get(cat) || { qty: 0, value: 0, costSum: 0, costCount: 0 };
    curVal.qty += stock;
    curVal.value += val;
    curVal.costSum += avgCost * stock;
    curVal.costCount += stock;
    inventoryByCat.set(cat, curVal);
  }
  const inventoryRows = [...inventoryByCat.entries()].map(([cat, d]) => ({
    cat,
    qty: d.qty,
    avgCost: d.costCount > 0 ? d.costSum / d.costCount : 0,
    value: d.value,
    status: d.qty <= 5 ? 'منخفض (تنبيه)' : d.qty <= 15 ? 'قليل' : 'متوفر'
  }));

  // Build HTML document as string (standalone, no app UI)
  const periodLabel = (() => {
    switch (range.preset) {
      case 'today': return 'يومي';
      case 'yesterday': return 'يومي';
      case '7': return 'أسبوعي';
      case '30': return 'شهري';
      case 'month': return 'شهري';
      default: return 'مخصص';
    }
  })();

  const now = new Date();
  const generatedAt = `${fmtDate(now, true)} ${fmtTime(now)}`;

  // Escape HTML helper
  const esc = (s) => String(s).replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"').replace(/'/g, '&apos;');

  // Table row helper
  const tr = (cells, cls = '') => `<tr${cls ? ` class="${cls}"` : ''}>${cells.map(c => typeof c === 'string' ? `<td>${c}</td>` : `<td style="${c.style || ''}">${c.html}</td>`).join('')}</tr>`;
  const th = (text) => `<th>${esc(text)}</th>`;
  const td = (html, align = 'start', color) => ({ html: esc(html), style: `text-align:${align};padding:5px 6px;border:1px solid #e8ddd0;vertical-align:middle${color ? `;color:${color}` : ''}` });

  // Section 1: Executive Summary
  const grossSales = revenue(sales);
  const totalDiscount = discountGiven(sales);
  const netSales = netRevenue(sales, refunds || []);
  const totalRefunded = refundsTotal(refunds || []);
  const cogs = grossSales - profit(sales);
  const netProfitValue = netProfit(sales, refunds || []);
  const orderCnt = orderCount(sales);

  const section1 = `
    <table class="report-table">
      <thead><tr>${th('المؤشر الرئيسي')}${th('القيمة')}</tr></thead>
      <tbody>
        ${tr([td('إجمالي المبيعات (Gross Sales)'), td(moneyHTML(grossSales, cur), 'end')])}
        ${tr([td('إجمالي الخصومات الممنوحة'), td(moneyHTML(totalDiscount, cur), 'end')])}
        ${tr([td('إجمالي المرتجعات'), td(moneyHTML(totalRefunded, cur), 'end', totalRefunded > 0 ? '#c0392b' : '')])}
        ${tr([td('صافي المبيعات (Net Sales = المبيعات - المرتجعات - الخصومات)'), td(moneyHTML(netSales, cur), 'end')])}
        ${tr([td('إجمالي تكلفة البضاعة المباعة (COGS)'), td(moneyHTML(cogs, cur), 'end')])}
        ${tr([td('صافي الربح (Net Profit = صافي المبيعات - التكلفة - أثر المرتجعات)'), td(moneyHTML(netProfitValue, cur), 'end', netProfitValue >= 0 ? '#1e7a3a' : '#c0392b')])}
        ${tr([td('عدد الفواتير المكتملة'), td(String(orderCnt), 'center')])}
        ${tr([td('عدد المرتجعات'), td(String((refunds || []).length), 'center')])}
        ${tr([td('إجمالي بنود الفواتير'), td(String(sales.reduce((a, s) => a + s.items.length, 0)), 'center')])}
      </tbody>
    </table>
  `;

  // Section 2: Invoice Details (no payment method column)
  let section2Rows = '';
  for (const s of sales) {
    for (let i = 0; i < s.items.length; i++) {
      const it = s.items[i];
      const p = byId.get(it.productId);
      const variantStr = (it.size !== '—' || it.color !== '—') ? ` · ${esc(it.size)}/${esc(it.color)}` : '';
      section2Rows += tr([
        td(i === 0 ? esc(s.receiptNo) : '', 'center'),
        td(i === 0 ? `${fmtDate(s.timestamp)} ${fmtTime(s.timestamp)}` : '', 'center'),
        td(i === 0 ? (p ? esc(p.category) : 'عميل نقدي') : ''),
        td(`${esc(it.name)} (×${it.qty})${variantStr}`),
        td(moneyHTML(it.qty * it.price, cur), 'end'),
        td(s.isRefund ? 'مرتجع' : 'مكتملة', 'center', s.isRefund ? '#c0392b' : '#1e7a3a')
      ], i % 2 === 0 ? 'alt' : '');
    }
  }
  const section2 = `
    <table class="report-table">
      <thead><tr>${th('رقم الفاتورة')}${th('التاريخ والوقت')}${th('اسم العميل / التصنيف')}${th('البنود والكميات')}${th('إجمالي الفاتورة')}${th('الحالة')}</tr></thead>
      <tbody>${section2Rows}</tbody>
    </table>
  `;

  // Section 3: Line-item Profit Breakdown
  let section3Rows = '';
  for (const s of sales) {
    for (let i = 0; i < s.items.length; i++) {
      const it = s.items[i];
      const cost = Number(it.costPrice) || 0;
      const lineRev = it.qty * it.price;
      const lineCost = it.qty * cost;
      const lineProfit = lineRev - lineCost;
      const variantStr = (it.size !== '—' || it.color !== '—') ? ` · ${esc(it.size)}/${esc(it.color)}` : '';
      section3Rows += tr([
        td(i === 0 ? esc(s.receiptNo) : '', 'center'),
        td(`${esc(it.name)}${variantStr}`),
        td(String(it.qty), 'center'),
        td(moneyHTML(it.price, cur), 'end'),
        td(moneyHTML(lineRev, cur), 'end'),
        td(moneyHTML(lineCost, cur), 'end'),
        td(moneyHTML(lineProfit, cur), 'end', lineProfit >= 0 ? '#1e7a3a' : '#c0392b')
      ], i % 2 === 0 ? 'alt' : '');
    }
  }
  const section3 = `
    <table class="report-table">
      <thead><tr>${th('رقم الفاتورة')}${th('الصنف (مع المقاس/اللون)')}${th('الكمية')}${th('سعر البيع/قطعة')}${th('إجمالي السعر')}${th('التكلفة الفعلية (FIFO)')}${th('الربح الصافي')}</tr></thead>
      <tbody>${section3Rows}</tbody>
    </table>
  `;

  // Section 4: Returns
  let section4 = '';
  if (returnsInRange.length) {
    let section4Rows = '';
    for (const s of returnsInRange) {
      for (let i = 0; i < s.items.length; i++) {
        const it = s.items[i];
        const variantStr = (it.size !== '—' || it.color !== '—') ? ` · ${esc(it.size)}/${esc(it.color)}` : '';
        section4Rows += tr([
          td(i === 0 ? esc(s.receiptNo) : '', 'center'),
          td(i === 0 ? esc(s.originalSaleId || '—') : '', 'center'),
          td(i === 0 ? `${fmtDate(s.timestamp)} ${fmtTime(s.timestamp)}` : '', 'center'),
          td(`${esc(it.name)}${variantStr}`),
          td(String(it.qty), 'center'),
          td(moneyHTML(it.qty * it.price, cur), 'end'),
          td(i === 0 ? esc({ cash: 'نقداً من الصندوق', card: 'إلغاء بطاقة', transfer: 'تحويل عكسي' }[s.paymentMethod] || '—') : '', 'center')
        ], i % 2 === 0 ? 'alt' : '');
      }
    }
    section4 = `
      <table class="report-table">
        <thead><tr>${th('رقم سند المرتجع')}${th('الفاتورة الأصلية')}${th('التاريخ')}${th('الصنف المرتجع')}${th('الكمية')}${th('مبلغ الاسترجاع')}${th('طريقة رد المبلغ')}</tr></thead>
        <tbody>${section4Rows}</tbody>
      </table>
    `;
  } else {
    section4 = '<div class="empty-section">لا توجد مرتجعات في هذه الفترة</div>';
  }

  // Section 5: Inventory (no low-stock column if no threshold in app)
  let section5Rows = '';
  for (let i = 0; i < inventoryRows.length; i++) {
    const r = inventoryRows[i];
    section5Rows += tr([
      td(esc(r.cat)),
      td(`${numInt(r.qty)} قطعة`, 'center'),
      td(moneyHTML(r.avgCost, cur), 'end'),
      td(moneyHTML(r.value, cur), 'end'),
      td(esc(r.status), 'center', r.status.includes('تنبيه') ? '#c0392b' : r.status.includes('قليل') ? '#e67e22' : '#1e7a3a')
    ], i % 2 === 0 ? 'alt' : '');
  }
  const section5 = `
    <table class="report-table">
      <thead><tr>${th('التصنيف / الصنف')}${th('الكمية الحالية')}${th('متوسط التكلفة/قطعة')}${th('إجمالي قيمة المخزون')}${th('حالة التنبيه')}</tr></thead>
      <tbody>${section5Rows}</tbody>
    </table>
  `;

  // Build complete HTML document
  const logoDataUri = settings.logo ? esc(settings.logo) : '';
  const storeName = esc(settings.storeName || 'متجر ساهر');
  const periodStr = `${fmtDate(range.from)} — ${fmtDate(range.to)} (${periodLabel})`;

  const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<title>تقرير ${storeName} — ${periodStr}</title>
<style>
  @page { size: A4; margin: 12mm; }
  @media print {
    @page { margin: 12mm; }
    thead { display: table-header-group; }
    tbody { display: table-row-group; }
    tr { page-break-inside: avoid; }
    .no-print { display: none !important; }
    .page-break { page-break-before: always; }
  }
  * { box-sizing: border-box; }
  body { font-family: "Cairo", "Tahoma", "Arial", sans-serif; color: #1a1616; line-height: 1.5; margin: 0; padding: 0; background: white; font-size: 10px; }
  .page { padding: 0; }
  .report-header { border-bottom: 3px solid #6b1d2f; padding: 16px 0 12px; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
  .report-header__left h1 { font-size: 20px; color: #6b1d2f; margin: 0 0 4px; font-weight: 800; }
  .report-header__left .store { font-size: 12px; color: #5e4a4e; }
  .report-header__left .period { font-size: 11px; color: #7a6a6e; margin-top: 2px; }
  .report-header__right { width: 64px; height: 64px; border-radius: 12px; background: linear-gradient(135deg,#6b1d2f,#8b2d3f); color: #fff; display: grid; place-items: center; font-size: 24px; flex-shrink: 0; }
  .report-header__right img { width: 64px; height: 64px; border-radius: 12px; object-fit: cover; }
  .section { margin: 16px 0 24px; page-break-inside: auto; }
  .section-title { font-size: 15px; color: #6b1d2f; font-weight: 800; border-bottom: 2px solid #6b1d2f; padding-bottom: 6px; margin: 0 0 10px; }
  .report-table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 9px; }
  .report-table th, .report-table td { padding: 5px 6px; border: 1px solid #e8ddd0; vertical-align: middle; }
  .report-table th { background: #6b1d2f; color: white; font-weight: 700; font-size: 9px; text-align: center; }
  .report-table tr.alt td { background: #fafaf9; }
  .empty-section { padding: 16px; text-align: center; color: #8f787c; font-size: 11px; }
  .report-footer { margin-top: 24px; padding-top: 16px; border-top: 2px dashed #d4c8b8; text-align: center; color: #8f787c; font-size: 9px; }
  .page-number { position: running(pageNum); }
  @page { @bottom-center { content: counter(page) " / " counter(pages); font-size: 8px; color: #8f787c; } }
</style>
</head>
<body>
  <div class="page">
    <div class="report-header">
      <div class="report-header__left">
        <h1>تقرير ${storeName}</h1>
        <div class="store">${storeName}</div>
        <div class="period">الفترة: ${esc(periodStr)}</div>
      </div>
      <div class="report-header__right">${logoDataUri ? `<img src="${logoDataUri}" alt="logo">` : 'س'}</div>
    </div>

    <div class="section">
      <div class="section-title">1. الملخص العام (Executive Summary)</div>
      ${section1}
    </div>

    <div class="section page-break">
      <div class="section-title">2. تفاصيل الفواتير (Sales & Invoices Detail)</div>
      ${section2}
    </div>

    <div class="section page-break">
      <div class="section-title">3. تفاصيل البنود والربحية (Line-Item & Profit Breakdown)</div>
      ${section3}
    </div>

    <div class="section page-break">
      <div class="section-title">4. المرتجعات (Returns Report)</div>
      ${section4}
    </div>

    <div class="section page-break">
      <div class="section-title">5. المخزون (Inventory & Stock Valuation)</div>
      ${section5}
    </div>

    <div class="report-footer">
      <div>تم إنشاء التقرير في ${esc(generatedAt)}</div>
      <div style="margin-top:4px">${storeName} · نظام ساهر لإدارة المتاجر</div>
    </div>
  </div>
</body>
</html>`;

  // Print using the new native.js API that accepts custom HTML
  printPage({ html, jobName: `تقرير ${storeName} — ${periodStr}` }).catch((err) => {
    console.warn('[print] failed', err);
    toast('تعذّر فتح نافذة الطباعة', 'err');
  });
}

function section(title, subtitle) {
  return el(
    'div',
    { style: 'margin:24px;padding:0 24px' },
    el('h2', { style: 'font-size:20px;color:#6b1d2f;margin:0 0 4px;font-weight:800;border-bottom:2px solid #6b1d2f;padding-bottom:6px', text: title }),
    subtitle ? el('div', { style: 'font-size:12px;color:#8f787c;margin-bottom:12px', text: subtitle }) : null
  );
}

function row(label, value, color) {
  return el('tr', {},
    td(label),
    td(value, 'end', color)
  );
}

function injectPrintStyles() {
  if (document.getElementById('report-print-styles')) return;
  const style = document.createElement('style');
  style.id = 'report-print-styles';
  style.textContent = `
    @page { size: A4; margin: 12mm; }
    @media print {
      .report-table { page-break-inside: auto; }
      .report-table tr { page-break-inside: avoid; page-break-after: auto; }
      .report-table thead { display: table-header-group; }
      .report-table tbody { display: table-row-group; }
      body { background: white !important; margin: 0; }
      #print-root > div { padding: 0 !important; max-width: none !important; margin: 0 !important; }
      @page { margin: 10mm; }
    }
    .report-table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    .report-table th, .report-table td { padding: 6px 8px; border: 1px solid #e8ddd0; vertical-align: middle; }
    .report-table th { background: #6b1d2f; color: white; font-weight: 700; font-size: 10px; text-align: center; }
    .report-table td { font-size: 10px; color: #1a1616; }
    .report-table tr:hover td { background: #fdf8f3; }
  `;
  document.head.appendChild(style);
}

const th = (t) => el('th', { style: 'text-align:center;padding:6px 8px;background:#6b1d2f;color:white;font-weight:700;font-size:10px;border:1px solid #e8ddd0', text: t });
const td = (t, align = 'start', color) =>
  el('td', { style: `text-align:${align};padding:5px 6px;border:1px solid #e8ddd0;vertical-align:middle${color ? `;color:${color}` : ''}`, html: t });

function storeBalanceCard(ledger, cur) {
  const line = (label, value, sign) =>
    el('div.balance-line', {}, el('span.balance-line__label', { text: label }), el('span.balance-line__value', { html: `${sign}${moneyHTML(value, cur)}` }));
  const node = el(
    'div.card.balance-card',
    {},
    el('div.balance-card__head', {}, el('div.stat__icon.stat__icon--brass', {}, fromHTML(icon('wallet'))),
      el('div', { style: 'min-width:0' },
        el('div.balance-card__label', { text: 'الرصيد العام للمتجر' }),
        el('div.balance-card__value', { html: moneyHTML(ledger.balance, cur) }),
        el('div.balance-card__note', { text: 'المال الموجود فعلياً في المتجر — مستقل تماماً عن إجمالي المبيعات' })
      )
    ),
    el('div.balance-card__rows', {},
      line('الرصيد الافتتاحي', ledger.opening, ledger.opening > 0 ? '+' : ''),
      line('إجمالي المبيعات (كل الفواتير)', ledger.salesTotal, '+'),
      line('مشتريات تجديد الكمية', ledger.purchasesTotal, '−')
    ),
    ledgerTrace(ledger, cur),
    el('button.balance-card__more', { type: 'button', onClick: () => navigate('settings') },
      fromHTML(icon('pencil')),
      el('span', { text: 'تعديل الرصيد الافتتاحي من الإعدادات' })
    )
  );
  return node;
}

function ledgerTrace(ledger, cur) {
  const host = el('div.ledger-trace');
  const list = el('div.ledger-trace__list', { hidden: true });
  const toggle = el(
    'button.ledger-trace__toggle',
    {
      type: 'button',
      'aria-expanded': 'false',
      onClick: () => {
        const open = list.hidden;
        list.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        toggle.classList.toggle('is-open', open);
        toggle.querySelector('span').textContent = open
          ? `إخفاء حركة الرصيد (${ledger.entries.length})`
          : `عرض حركة الرصيد (${ledger.entries.length})`;
      },
    },
    fromHTML(icon('receipt')),
    el('span', { text: `عرض حركة الرصيد (${ledger.entries.length})` })
  );
  const newestFirst = [...ledger.entries].reverse();
  const CAP = 40;
  for (const e of newestFirst.slice(0, CAP)) {
    list.appendChild(
      el(
        'div.ledger-row',
        {},
        el('div.ledger-row__icon.ledger-row__icon--' + e.type, {}, fromHTML(icon(e.type === 'opening' ? 'wallet' : e.type === 'restock' ? 'truck' : 'receipt'))),
        el('div.ledger-row__main', {},
          el('div.ledger-row__title', { text: e.label }),
          el('div.ledger-row__date', { text: e.date ? fmtDate(e.date) : 'قبل أول استخدام للتطبيق' })
        ),
        el('div.ledger-row__num', {},
          el('span.ledger-row__amt' + (e.sign < 0 ? '.is-minus' : ''), { html: `${e.sign < 0 ? '−' : '+'}${moneyHTML(e.amount, cur)}` }),
          el('span.ledger-row__bal', { text: `الرصيد ${num(e.balance, 0)}` })
        )
      )
    );
  }
  if (newestFirst.length > CAP) {
    list.appendChild(el('p.tiny.muted', { style: 'padding:9px 4px 2px', text: `و ${newestFirst.length - CAP} حركة أقدم.` }));
  }
  host.appendChild(toggle);
  host.appendChild(list);
  return host;
}

export function destroy() {
  destroyCharts();
}

export default { render, destroy };
function reportSectionTitle(text, iconName) {
  return el(
    'div',
    { style: 'margin:28px 0 10px;padding-bottom:6px;border-bottom:2px solid #6b1d2f;display:flex;align-items:center;gap:8px' },
    fromHTML(icon(iconName)),
    el('h2', { style: 'font-size:18px;color:#6b1d2f;margin:0;font-weight:700', text })
  );
}

function kpiCard(label, value, iconName, color) {
  return el(
    'div',
    { style: 'background:#faf7f2;border:1px solid #eae0d2;border-radius:12px;padding:16px;display:flex;flex-direction:column;align-items:center;gap:6px' },
    el('div', { style: `width:36px;height:36px;border-radius:10px;background:${color}20;display:grid;place-items:center;color:${color}`, html: icon(iconName) }),
    el('div', { style: 'font-size:11px;color:#8f787c;font-weight:600;text-align:center', text: label }),
    el('div', { style: 'font-size:18px;font-weight:800;color:#1a1616', html: value })
  );
}

function statRow(label, value, color) {
  return el('div', { style: 'text-align:center' },
    el('div', { style: 'font-size:11px;color:#8f787c;font-weight:600', text: label }),
    el('div', { style: `font-size:16px;font-weight:700;color:${color};margin-top:2px`, html: moneyHTML(value, cur) })
  );
}


/**
 * "الرصيد العام للمتجر" — the shop's cash position, in its own card above the
 * range's trading figures and deliberately a different shape from them.
 *
 * It is derived, never a stored counter:
 *
 *   opening balance + every completed sale − every restock purchase
 *
 * A refund deletes its sale, so the credit reverses on its own; editing a sale
 * moves the figure with it. Total Sales stays exactly what it is — a completely
 * separate number that says nothing about the money in the till.
 */

/**
 * The movement list behind the number.
 *
 * Every row is a record that exists in the database — an opening balance, a
 * restock, or a completed sale. There is no invented "expenses" category,
 * because the app has no expense records to show. A refunded sale does not
 * appear as a reversal: refunding deletes the sale, so its absence from
 * the list IS the reversal, and the running balance above already reflects it.
 */
