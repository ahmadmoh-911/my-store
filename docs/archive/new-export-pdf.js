function exportPDF() {
  if (!snapshot || !snapshot.sales.length) {
    toast('لا توجد بيانات لتصديرها', 'warn');
    return;
  }
  const { sales, products, settings, allSales, allPurchases } = snapshot;
  const cur = settings.currency;
  const byId = new Map(products.map((p) => [p.id, p]));

  const rev = revenue(sales);
  const pr = profit(sales);
  const orders = orderCount(sales);
  const basket = avgBasket(sales);
  const units = unitsSold(sales);
  const disc = discountGiven(sales);
  const cats = categoryTotals(sales, products);
  const top = bestSellers(sales, 15);
  const pays = paymentBreakdown(sales);

  const returnsInRange = allSales
    .filter((s) => s.isRefund === true && new Date(s.timestamp) >= range.from && new Date(s.timestamp) <= range.to);

  const purchasesInRange = allPurchases.filter((pu) => {
    const d = new Date(pu.date);
    return d >= range.from && d <= range.to;
  });

  const inventoryByCat = new Map();
  for (const p of products) {
    const cat = p.category || 'غير مصنف';
    const stock = p.variants?.reduce((s, v) => s + (Number(v.quantity) || 0), 0) || 0;
    const avgCost = p.variants?.reduce((s, v) => s + (Number(v.quantity) || 0) * (Number(p.costPrice) || 0), 0) / (stock || 1);
    const val = stock * (Number(p.costPrice) || 0);
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

  const root = document.getElementById('print-root');
  clear(root);

  const wrap = el('div', { style: 'font-family:var(--font),Cairo,sans-serif;color:#1a1616;line-height:1.5;max-width:900px;margin:0 auto;padding:0;background:white' });

  // ===== HEADER =====
  wrap.appendChild(
    el(
      'div',
      { style: 'border-bottom:3px solid #6b1d2f;padding:20px 24px;background:#faf7f2' },
      el(
        'div',
        { style: 'display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap' },
        el(
          'div',
          {},
          el('h1', { style: 'font-size:26px;color:#6b1d2f;margin:0 0 4px;font-weight:800', text: 'لوحة التقارير الشاملة (Manager Dashboard & Reports)' }),
          el('div', { style: 'font-size:13px;color:#5e4a4e', text: settings.storeName || 'متجر ساهر' }),
          el('div', { style: 'font-size:12px;color:#7a6a6e;margin-top:2px', text: `الفترة: ${fmtDate(range.from)} — ${fmtDate(range.to)}` })
        ),
        settings.logo
          ? el('img', { src: settings.logo, style: 'width:64px;height:64px;border-radius:12px;object-fit:cover' })
          : el('div', { style: 'width:64px;height:64px;border-radius:12px;background:linear-gradient(135deg,#6b1d2f,#8b2d3f);color:#fff;display:grid;place-items:center;font-size:24px', html: icon('hanger') })
      )
    )
  );

  // ===== SECTION 1: EXECUTIVE SUMMARY =====
  wrap.appendChild(section('1. تقرير الملخص العام (Executive Summary)', 'يقدم نظرة سريعة وشاملة عن أداء المحل خلال الفترة المحددة'));
  wrap.appendChild(
    el(
      'table',
      { class: 'report-table', style: 'margin:16px 24px 32px;width:calc(100% - 48px)' },
      el('thead', {}, el('tr', {}, th('المؤشر الرئيسي'), th('القيمة / الوصف'))),
      el('tbody', {},
        row('إجمالي المبيعات (Gross Sales)', moneyHTML(revenue(sales), cur)),
        row('إجمالي الخصومات الممنوحة', moneyHTML(discountGiven(sales), cur)),
        row('صافي المبيعات (Net Sales)', moneyHTML(revenue(sales) - discountGiven(sales), cur)),
        row('إجمالي تكلفة البضاعة المباعة (COGS)', moneyHTML(revenue(sales) - profit(sales), cur)),
        row('صافي الأرباح (Net Profit)', moneyHTML(profit(sales), cur), profit(sales) >= 0 ? '#1e7a3a' : '#c0392b'),
        row('عدد الفواتير المُصدرة', numInt(orderCount(sales))),
        row('إجمالي الحركات الشرائية للعملاء', numInt(sales.length))
      )
    )
  );

  // ===== SECTION 2: SALES & INVOICES DETAIL =====
  wrap.appendChild(section('2. تقرير تفاصيل الفواتير وحركة البيع (Sales & Invoices Detail Report)', 'جدول تفصيلي يوضح كل فاتورة على حدة مع تفاصيلها الكاملة'));
  wrap.appendChild(
    el(
      'div',
      { style: 'overflow-x:auto;padding:0 24px' },
      el(
        'table',
        { class: 'report-table', style: 'width:calc(100% - 48px)' },
        el('thead', {}, el('tr', {}, th('رقم الفاتورة'), th('التاريخ والوقت'), th('اسم العميل'), th('البنود والكميات'), th('إجمالي الفاتورة'), th('طريقة الدفع'), th('الحالة'))),
        el('tbody', {}, ...sales.flatMap((s) =>
          s.items.map((it, i) => {
            const p = byId.get(it.productId);
            return el('tr', { style: i % 2 === 0 ? 'background:#fafaf9' : '' },
              td(s.receiptNo),
              td(`${fmtDate(s.timestamp)} ${fmtTime(s.timestamp)}`),
              td(p ? p.category : 'عميل نقدي'),
              td(`${it.name} (×${it.qty})${it.size !== '—' || it.color !== '—' ? ` · ${it.size}/${it.color}` : ''}`),
              td(moneyHTML(it.qty * it.price, cur), 'end'),
              td({ cash: 'نقود', card: 'بطاقة', transfer: 'تحويل' }[s.paymentMethod] || ''),
              td(s.isRefund ? 'مرتجع' : 'مكتملة', 'center', s.isRefund ? '#c0392b' : '#1e7a3a')
            );
          })
        ))
      )
    )
  );

  // ===== SECTION 3: LINE-ITEM & PROFIT BREAKDOWN =====
  wrap.appendChild(section('3. تقرير تفاصيل بنود الفاتورة والربحية (Line-Item & Profit Breakdown)', 'تفاصيل كل قطعة تم بيعها داخل الفواتير، تكلفتها، وسعر بيعها، والربح المحقق'));
  wrap.appendChild(
    el(
      'div',
      { style: 'overflow-x:auto;padding:0 24px' },
      el(
        'table',
        { class: 'report-table', style: 'width:calc(100% - 48px)' },
        el('thead', {}, el('tr', {}, th('رقم الفاتورة'), th('اسم المنتج / الصنف'), th('الكمية'), th('سعر البيع للقطعة'), th('إجمالي السعر'), th('التكلفة الفعلية (FIFO)'), th('الربح الصافي'))),
        el('tbody', {}, ...sales.flatMap((s) =>
          s.items.map((it, i) => {
            const p = byId.get(it.productId);
            const cost = Number(it.costPrice) || 0;
            const lineRev = it.qty * it.price;
            const lineCost = it.qty * cost;
            return el('tr', { style: i % 2 === 0 ? 'background:#fafaf9' : '' },
              td(s.receiptNo),
              td(`${it.name}${it.size !== '—' || it.color !== '—' ? ` · ${it.size}/${it.color}` : ''}`),
              td(numInt(it.qty), 'center'),
              td(moneyHTML(it.price, cur), 'end'),
              td(moneyHTML(lineRev, cur), 'end'),
              td(moneyHTML(lineCost, cur), 'end'),
              td(moneyHTML(lineRev - lineCost, cur), 'end', lineRev - lineCost >= 0 ? '#1e7a3a' : '#c0392b')
            );
          })
        ))
      )
    )
  );

  // ===== SECTION 4: RETURNS REPORT =====
  wrap.appendChild(section('4. تقرير المرتجعات (Returns Report)', 'تفاصيل السلع المرتجعة، وأثرها المالي'));
  if (returnsInRange.length) {
    wrap.appendChild(
      el(
        'div',
        { style: 'overflow-x:auto;padding:0 24px' },
        el(
          'table',
          { class: 'report-table', style: 'width:calc(100% - 48px)' },
          el('thead', {}, el('tr', {}, th('رقم سند المرتجع'), th('الفاتورة الأصلية'), th('التاريخ'), th('الصنف المرتجع'), th('الكمية'), th('مبلغ الاسترجاع'), th('طريقة رد المبلغ'))),
          el('tbody', {}, ...returnsInRange.flatMap((s) =>
            s.items.map((it, i) => el('tr', { style: i % 2 === 0 ? 'background:#fafaf9' : '' },
              td(s.receiptNo),
              td(s.originalSaleId || '—'),
              td(`${fmtDate(s.timestamp)} ${fmtTime(s.timestamp)}`),
              td(`${it.name}${it.size !== '—' || it.color !== '—' ? ` · ${it.size}/${it.color}` : ''}`),
              td(numInt(it.qty), 'center'),
              td(moneyHTML(it.qty * it.price, cur), 'end'),
              td({ cash: 'نقداً من الصندوق', card: 'إلغاء بطاقة', transfer: 'تحويل عكسي' }[s.paymentMethod] || '—')
            ))
          ))
        )
      )
    );
  } else {
    wrap.appendChild(el('div', { style: 'padding:24px;text-align:center;color:#8f787c' }, 'لا توجد مرتجعات في هذه الفترة'));
  }

  // ===== SECTION 5: INVENTORY & STOCK VALUATION =====
  wrap.appendChild(section('5. تقرير المخزون وحركة البضائع (Inventory & Stock Valuation)', 'ملخص حالة المحل من حيث البضاعة المتبقية وقيمتها الإجمالية'));
  wrap.appendChild(
    el(
      'table',
      { class: 'report-table', style: 'margin:16px 24px 32px;width:calc(100% - 48px)' },
      el('thead', {}, el('tr', {}, th('التصنيف / الصنف'), th('الكمية الحالية بالمخزون'), th('متوسط التكلفة للقطعة'), th('إجمالي قيمة المخزون'), th('حالة التنبيه'))),
      el('tbody', {}, ...inventoryRows.map((r, i) => el('tr', { style: i % 2 === 0 ? 'background:#fafaf9' : '' },
        td(r.cat),
        td(`${numInt(r.qty)} قطعة`, 'center'),
        td(moneyHTML(r.avgCost, cur), 'end'),
        td(moneyHTML(r.value, cur), 'end'),
        td(r.status, 'center', r.status.includes('تنبيه') ? '#c0392b' : r.status.includes('قليل') ? '#e67e22' : '#1e7a3a')
      )))
    )
  );

  // ===== FOOTER =====
  wrap.appendChild(
    el(
      'div',
      { style: 'margin-top:32px;padding:20px 24px;border-top:2px dashed #d4c8b8;text-align:center;color:#8f787c;font-size:12px;background:#faf7f2' },
      el('div', { text: `تم إنشاء التقرير في ${fmtDate(new Date(), true)}` }),
      el('div', { style: 'margin-top:4px', text: `${settings.storeName} · نظام ساهر لإدارة المتاجر` })
    )
  );

  root.appendChild(wrap);

  // Inject print styles - NO BLANK PAGES
  injectPrintStyles();

  setTimeout(() => printPage().catch((err) => {
    console.warn('[print] failed', err);
    toast('تعذّر فتح نافذة الطباعة', 'err');
  }), 80);
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