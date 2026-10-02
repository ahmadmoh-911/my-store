/**
 * Dashboard — the landing screen.
 * Shows today's performance, inventory health, the sales trend and quick actions.
 */
import { icon } from '../icons.js';
import { el, fromHTML, clear, countUp, num, numInt, moneyHTML, fmtDate, fmtDayName, addDays, startOfDay } from '../utils.js';
import { stockOf } from '../db.js';
import {
  loadAll, salesOn, revenue, orderCount, avgBasket,
  pctChange, dailySeries, hourlySeries, lowStockProducts,
} from '../analytics.js';
import { lineChart, destroyCharts } from '../charts.js';
import { emptyState, openSheet, toast, saleRow } from '../components.js';
import { openInvoiceSheet } from '../invoice-sheet.js';
import { openRestockPicker } from '../restock.js';
import { navigate } from '../router.js';

let trendWindow = 7; // days shown in the trend chart (7 / 30, or 1 for today)

/**
 * The day the numbers describe. Defaults to today, and the arrows walk it
 * backwards and forwards — an owner checking yesterday's takings should not
 * have to leave the home screen to do it.
 */
let viewDate = new Date();

const isToday = (d) => startOfDay(d).getTime() === startOfDay(new Date()).getTime();

export function render() {
  // `render()` is the router's entry point — it runs only when the Dashboard is
  // newly navigated to, not on the in-screen repaints. `viewDate` lives at
  // module scope, so without this the day the owner walked to (setDay) survived
  // leaving the screen and a sale made afterwards landed under the wrong date.
  // In-screen day navigation goes through setDay() → boot(), which is untouched.
  viewDate = new Date();

  const root = el('div.screen', { id: 'screen-dashboard' });

  // --- skeleton shell: the layout appears instantly, numbers fill in ---
  const statsHost = el('div.stat-grid', { id: 'dash-stats' });

  // After the KPI row the dashboard is exactly two things: the sales trend and
  // the day's invoices. The stock-alert column, the best-sellers block and the
  // stock-by-category chart were three more places to look for something the
  // owner was not asking about.
  const body = el(
    'div',
    {},
    el(
      'div.card.chart-card',
      {},
      el(
        'div.card-head',
        {},
        el('h3', { text: 'مسار المبيعات' }),
        el(
          'div.seg',
          { id: 'trend-seg' },
          ...[
            [1, 'اليوم'],
            [7, 'الأسبوع'],
            [30, 'الشهر'],
          ].map(([v, label]) =>
            el('button', {
              type: 'button',
              text: label,
              class: v === trendWindow ? 'is-active' : '',
              onClick: () => switchTrend(v),
              dataset: { win: String(v) },
            })
          )
        )
      ),
      el(
        'div',
        { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px' },
        el('span.rate-line', { id: 'trend-total', html: '…' }),
        el('span.tiny.muted', { id: 'trend-range', text: '' })
      ),
      el('div.chart-box', {}, el('canvas', { id: 'trend-chart' })),
      el(
        'div.chart-foot',
        {},
        el('span', { id: 'trend-note', text: '' }),
        el('button.card-head__action', { type: 'button', text: 'التقرير الكامل', onClick: () => navigate('reports') })
      )
    ),
    el('div.card', { id: 'dash-invoices', style: 'margin-top:16px' })
  );

  root.appendChild(el('div', { id: 'dash-hero', class: 'hero skeleton', style: 'height:150px' }));
  root.appendChild(el('div', { id: 'dash-daynav' }));
  root.appendChild(statsHost);
  root.appendChild(el('div', { id: 'dash-quick', class: 'quick-actions' }));
  root.appendChild(body);

  boot(root);
  return root;
}

/* ------------------------------------------------------------------ *
 * Async fill
 * ------------------------------------------------------------------ */

async function boot(root) {
  const { products, sales, settings } = await loadAll();
  // Callers pass `document.getElementById(...)`, which is null the moment the
  // user leaves the dashboard — e.g. the restock picker's onDone firing after a
  // sheet was opened from somewhere else. Nothing to repaint, so just stop.
  if (!root || !root.isConnected) return;

  const cur = settings.currency;
  renderHero(root, products, sales, settings);
  renderDayNav(root);
  renderStats(root, sales, products, settings);
  renderQuick(root);
  renderDayInvoices(root, sales, settings);

  destroyCharts();
  drawTrend(root, sales, cur);
}

/* --- day navigator -------------------------------------------------- */
function renderDayNav(root) {
  const host = root.querySelector('#dash-daynav');
  clear(host);

  const day = isToday(viewDate) ? 'اليوم' : fmtDate(viewDate);

  host.appendChild(
    el(
      'div.daynav',
      {},
      el('button.icon-btn', {
        type: 'button',
        'aria-label': 'اليوم التالي',
        disabled: isToday(viewDate) ? '' : null,
        onClick: () => setDay(1),
      }, fromHTML(icon('chevronLeft'))),
      el(
        'div.daynav__label',
        {},
        el('span.daynav__day', { text: day }),
        el('span.daynav__sub', { text: isToday(viewDate) ? new Date().toLocaleDateString('ar-EG', { weekday: 'long' }) : fmtDayName(viewDate) })
      ),
      isToday(viewDate)
        ? el('span.daynav__today', { text: 'اليوم' })
        : el('button.pill-btn.pill-btn--sm', { type: 'button', text: 'العودة لليوم', onClick: () => setDay(0, true) }),
      el('button.icon-btn', {
        type: 'button',
        'aria-label': 'اليوم السابق',
        onClick: () => setDay(-1),
      }, fromHTML(icon('chevronRight')))
    )
  );
}

function setDay(delta, toToday = false) {
  viewDate = toToday ? new Date() : addDays(viewDate, delta);
  // never let the owner walk into a future day that cannot have sales in it
  if (viewDate.getTime() > Date.now()) viewDate = new Date();
  const root = document.getElementById('screen-dashboard');
  if (root && root.isConnected) boot(root);
}

/* --- hero ---------------------------------------------------------- */
function renderHero(root, products, sales, settings) {
  const host = root.querySelector('#dash-hero');
  clear(host);
  host.classList.remove('skeleton');
  host.style.height = '';

  const now = new Date();
  // greet the shop owner, not the shop — falls back to the store name until an
  // owner name is filled in under Settings
  const who = (settings.ownerName || '').trim() || settings.storeName;

  host.appendChild(
    el(
      'div.hero__row',
      {},
      el(
        'div',
        { style: 'min-width:0' },
        el('div.hero__greet', { text: `مرحبا ${who}` }),
        el('div.hero__sub', { text: `${fmtDayName(now)} ${fmtDate(now)}` })
      )
    )
  );
}

/* --- stat cards ---------------------------------------------------- */
function renderStats(root, sales, products, settings) {
  const host = root.querySelector('#dash-stats');
  clear(host);
  const cur = settings.currency;

  // Every tile describes a different slice of the day, and each one opens that
  // slice — a stat you cannot act on is just decoration.
  const day = viewDate;
  const daySales = salesOn(sales, day);
  const prevSales = salesOn(sales, addDays(day, -1));

  const revDay = revenue(daySales);
  const revPrev = revenue(prevSales);
  const change = pctChange(revDay, revPrev);

  const threshold = Number(settings.lowStockThreshold) || 5;
  const lowList = lowStockProducts(products, threshold);
  const stockQty = products.reduce((t, p) => t + stockOf(p), 0);
  const label = isToday(day) ? 'اليوم' : fmtDate(day);

  const refresh = () => {
    const r = document.getElementById('screen-dashboard');
    if (r && r.isConnected) boot(r);
  };

  const cards = [
    {
      label: `مبيعات ${label}`,
      value: revDay,
      money: true,
      icon: 'trendingUp',
      tone: '',
      // the badge carries the number only; "عن اليوم السابق" is its own line
      // underneath, so a caption is never welded to a figure
      foot:
        change === null
          ? el('span.delta.delta--flat', { text: 'أول يوم' })
          : el(
              `span.delta.delta--${change >= 0 ? 'up' : 'down'}`,
              {},
              fromHTML(icon(change >= 0 ? 'trendingUp' : 'trendingDown')),
              el('span', { text: `${change >= 0 ? '+' : ''}${change.toFixed(1)}%` })
            ),
      note: 'عن اليوم السابق',
      extra: `${orderCount(daySales)} عملية بيع`,
      onClick: () => openDayInvoices(daySales, day, cur, refresh),
    },
    {
      label: `فواتير ${label}`,
      value: orderCount(daySales),
      icon: 'receipt',
      tone: 'brass',
      // `html`, not `text`: moneyHTML returns markup with a currency chip.
      foot: el('span', { html: `إجمالي ${moneyHTML(revDay, cur)}` }),
      extra: `متوسط السلة ${moneyHTML(avgBasket(daySales), cur)}`,
      onClick: () => openDayInvoices(daySales, day, cur, refresh),
    },
    {
      label: 'تنبيهات النواقص',
      value: lowList.length,
      unit: 'منتج',
      icon: 'alert',
      tone: 'danger',
      pulse: lowList.length > 0,
      foot: lowList.length
        ? el('span', { text: `الحد الأدنى ${threshold} قطع` })
        : el('span.delta.delta--up', { text: 'المخزون سليم' }),
      extra: `${products.length} منتج`,
      onClick: () => navigate('products'),
    },
    {
      label: 'إجمالي المخزون',
      value: stockQty,
      unit: 'قطعة',
      icon: 'package',
      tone: 'emerald',
      foot: el('span', { text: `${products.length} منتج` }),
      extra: `${products.filter((p) => stockOf(p) === 0).length} نفدت`,
      onClick: () => navigate('products'),
    },
  ];

  cards.forEach((c) => {
    const node = el(
      `div.stat${c.pulse ? '.pulse-soft' : ''}`,
      c.onClick
        ? {
            role: 'button',
            tabindex: '0',
            title: 'اضغط للتفاصيل',
            onClick: c.onClick,
            onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && c.onClick(),
          }
        : {}
    );
    node.appendChild(
      el(
        'div.stat__top',
        {},
        el(`div.stat__icon${c.tone ? '.stat__icon--' + c.tone : ''}`, {}, fromHTML(icon(c.icon))),
        el('div.stat__label', { text: c.label })
      )
    );
    // The unit belongs to the figure it measures, so it sits inside the value
    // field next to the number — not in the footer, where two other lines would
    // separate "584" from "قطعة" and make it read as a sentence of its own.
    // `unit` names a plain count; `money` falls back to the shop's currency.
    const unit = c.unit || (c.money ? cur : '');
    node.appendChild(
      el('div.stat__value', {}, el('span', { 'data-count': String(c.value), text: '0' }), unit ? el('small', { text: unit }) : null)
    );
    // One line per field: the primary badge, then its caption, then the
    // secondary figure. `html` on extra because "متوسط السلة" is built with
    // moneyHTML(); every value here is app-generated (counts and money), never
    // user input.
    node.appendChild(
      el(
        'div.stat__foot',
        {},
        c.foot,
        c.note ? el('span.stat__note', { text: c.note }) : null,
        c.extra ? el('span.stat__extra', { html: c.extra }) : null
      )
    );
    if (c.onClick) node.classList.add('stat--tap');
    host.appendChild(node);
    const target = node.querySelector('[data-count]');
    countUp(target, c.value, { duration: 900 });
  });
}

/* --- the selected day's invoices, on the home screen ---------------- */
function renderDayInvoices(root, sales, settings) {
  const host = root.querySelector('#dash-invoices');
  if (!host) return;
  clear(host);

  const daySales = salesOn(sales, viewDate).slice().sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  const cur = settings.currency;

  const refresh = () => {
    const r = document.getElementById('screen-dashboard');
    if (r && r.isConnected) boot(r);
  };

  // Its own day stepper, inside the section it changes: walking to yesterday's
  // invoices should not mean scrolling back to the top of the screen first.
  const today = isToday(viewDate);
  const stepper = el(
    'div.inv-daynav',
    {},
    el(
      'button.icon-btn.icon-btn--sm',
      {
        type: 'button',
        'aria-label': 'اليوم التالي',
        title: 'اليوم التالي',
        disabled: today ? '' : null,
        onClick: () => setDay(1),
      },
      fromHTML(icon('chevronLeft'))
    ),
    el('span.inv-daynav__label', {
      text: today ? 'اليوم' : `${fmtDayName(viewDate)} · ${fmtDate(viewDate)}`,
    }),
    el(
      'button.icon-btn.icon-btn--sm',
      { type: 'button', 'aria-label': 'اليوم السابق', title: 'اليوم السابق', onClick: () => setDay(-1) },
      fromHTML(icon('chevronRight'))
    )
  );

  host.appendChild(
    el(
      'div.card-head',
      {},
      el('h3', { text: today ? 'فواتير اليوم' : `فواتير ${fmtDate(viewDate)}` }),
      stepper,
      daySales.length ? el('span.tiny.muted', { text: `${daySales.length} فاتورة` }) : null
    )
  );

  if (!daySales.length) {
    host.appendChild(
      emptyState({
        iconName: 'receipt',
        title: isToday(viewDate) ? 'لا فواتير اليوم' : 'لا فواتير في هذا اليوم',
        text: 'ستظهر هنا فور إتمام أول عملية بيع.',
        small: true,
      })
    );
    return;
  }

  const list = el('div.inv-list');
  for (const s of daySales.slice(0, 8)) list.appendChild(invoiceRow(s, cur, refresh));
  host.appendChild(list);

  if (daySales.length > 8) {
    host.appendChild(
      el('button.card-head__action.card-head__action--block', {
        type: 'button',
        text: `عرض كل الفواتير (${daySales.length})`,
        onClick: () => openDayInvoices(daySales, viewDate, cur, refresh),
      })
    );
  }
}

/**
 * One day-invoice. Delegates to the shared components.saleRow() so the Dashboard
 * and Reports present a sale identically — and so the row has one field per
 * line instead of the four-values-on-one-line `.inv-row` it replaced.
 */
function invoiceRow(sale, cur, refresh) {
  return saleRow(sale, cur, (s) => openInvoiceSheet(s, { onChanged: refresh, onRefund: refresh }));
}

/** Full list of a day's invoices in a sheet — opened from a stat tile. */
function openDayInvoices(daySales, day, cur, refresh) {
  const list = daySales.slice().sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  const total = list.reduce((t, s) => t + (Number(s.total) || 0), 0);

  const body = el('div.inv-list');
  if (!list.length) {
    body.appendChild(emptyState({ iconName: 'receipt', title: 'لا فواتير', text: 'لا توجد فواتير في هذا اليوم.', small: true }));
  } else {
    for (const s of list) body.appendChild(invoiceRow(s, cur, refresh));
  }

  const sheet = openSheet({
    title: isToday(day) ? 'فواتير اليوم' : `فواتير ${fmtDate(day)}`,
    body,
    foot: el(
      'div.inv-sheet-total',
      {},
      el('span', { text: `${list.length} فاتورة` }),
      el('span', { html: moneyHTML(total, cur) })
    ),
  });
  return sheet;
}

/* --- quick actions ------------------------------------------------- */
function renderQuick(root) {
  const host = root.querySelector('#dash-quick');
  clear(host);
  // Every action carries a tone so the row does not read as five identical grey
  // slabs directly under four grey stat tiles.
  const actions = [
    { label: 'بيع جديد', icon: 'cart', to: 'pos', cls: 'quick--primary', onClick: null },
    // Opens the real restock flow: pick the product, then the variant, price,
    // supplier and date. It is a purchase, so it also debits the store balance.
    { label: 'تجديد الكمية', icon: 'package', to: null, cls: 'quick--emerald', onClick: () => openRestockPicker({ onDone: () => boot(document.getElementById('screen-dashboard')) }) },
    { label: 'إضافة منتج', icon: 'plus', to: 'product/new', cls: 'quick--brass', onClick: null },
    { label: 'مورد جديد', icon: 'truck', to: 'suppliers', cls: 'quick--info', onClick: null },
    { label: 'التقارير', icon: 'chart', to: 'reports', cls: 'quick--primary', onClick: null },
  ];
  actions.forEach((a) =>
    host.appendChild(
      el(
        `button.quick.${a.cls}`,
        { type: 'button', onClick: () => (a.onClick ? a.onClick() : navigate(a.to)) },
        el('span.quick__ico', {}, fromHTML(icon(a.icon))),
        el('span', { text: a.label })
      )
    )
  );
}

/* --- trend chart ---------------------------------------------------- */
function drawTrend(root, sales, cur) {
  const canvas = root.querySelector('#trend-chart');
  if (!canvas) return;

  let series;
  if (trendWindow === 1) {
    series = hourlySeries(sales);
    root.querySelector('#trend-range').textContent = 'ساعات اليوم';
    root.querySelector('#trend-note').textContent = 'صباحاً → مساءً';
  } else {
    series = dailySeries(sales, trendWindow);
    root.querySelector('#trend-range').textContent =
      trendWindow === 7 ? 'آخر ٧ أيام' : 'آخر ٣٠ يوم';
    root.querySelector('#trend-note').textContent = 'المبيعات اليومية';
  }

  const total = series.values.reduce((a, b) => a + b, 0);
  const avg = total / (series.values.length || 1);
  root.querySelector('#trend-total').innerHTML =
    `${icon('coins')} <span>${moneyHTML(total, cur)} إجمالي</span>`;
  root.querySelector('#trend-total').insertAdjacentHTML(
    'beforeend',
    ` <span style="color:var(--ink-3);font-weight:500">· متوسط ${num(Math.round(avg))}</span>`
  );

  lineChart(canvas, {
    labels: series.labels,
    values: series.values,
    currency: cur,
    color: '#6b1d2f',
  });
}

function switchTrend(win) {
  trendWindow = win;
  const root = document.getElementById('screen-dashboard');
  if (!root) return;
  root.querySelectorAll('#trend-seg button').forEach((b) => {
    b.classList.toggle('is-active', Number(b.dataset.win) === win);
  });
  // re-read data and redraw
  loadAll().then(({ sales, settings }) => {
    if (root.isConnected) drawTrend(root, sales, settings.currency);
  });
}

/** Called by the router when leaving — stops chart timers. */
export function destroy() {
  destroyCharts();
}

export default { render, destroy };
