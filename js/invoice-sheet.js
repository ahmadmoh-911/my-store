/**
 * Invoice details and editing.
 *
 * One sheet that reads as a receipt first — what was sold, for how much, how it
 * was paid — and turns into an editor on demand. Editing writes through
 * db.updateSale(), which moves inventory by the difference between the old and
 * new quantities, so fixing a mis-keyed line puts the stock back rather than
 * counting it twice.
 *
 * ── Why this view was rebuilt ────────────────────────────────────────────
 * It used to render with no stylesheet at all. `.inv`, `.inv-meta`, `.inv-item`
 * and `.inv-totals` had no rules anywhere in the app, so a list of `<div>`s
 * stacked with no separation on the sheet's dark backdrop and the text ran into
 * the text below it: unreadable, and impossible to check a number against. The
 * same theme, cards, borders and dividers as everything else in the app are used
 * here now, laid out the way a paper receipt is: who and when at the top, a card
 * per line, and the money in one block at the bottom.
 */
import { icon } from './icons.js';
import { el, fromHTML, clear, moneyHTML, fmtDate, fmtTime } from './utils.js';
import { openSheet, confirmDialog, toast } from './components.js';
import { updateSale, refundSale, getSettings, listProducts } from './db.js';
import { saleTotals } from './money.js';

const PAYMENTS = [
  { id: 'cash', label: 'نقداً' },
  { id: 'card', label: 'بطاقة' },
  { id: 'transfer', label: 'تحويل' },
];

/** Any number at or above zero. A price typed as "-5" is 0, not minus five. */
const nonNeg = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function totalsOf(items, discountType, discountValue, priceIncrease = 0) {
  // Exact shared arithmetic (js/money.js) — what the sheet previews is
  // therefore to the agora what "حفظ" will store, never a cent apart.
  const t = saleTotals(items, discountType, discountValue, priceIncrease);
  return { subtotal: t.subtotal, discount: t.discount, increase: t.priceIncrease, total: t.total };
}

/**
 * @param {Object} sale    the sale as stored
 * @param {Object} opts    { onChanged: () => void, onRefund: () => void }
 */
export function openInvoiceSheet(sale, opts = {}) {
  // a working copy — nothing touches the stored sale until "حفظ"
  const draft = {
    items: (sale.items || []).map((it) => ({ ...it })),
    discountType: sale.discountType || 'fixed',
    discountValue: Math.max(0, Number(sale.discountValue) || 0),
    priceIncrease: Math.max(0, Number(sale.priceIncrease) || 0),
    paymentMethod: sale.paymentMethod || 'cash',
    note: sale.note || '',
  };
  // What the invoice said when the sheet opened. Cancelling an edit puts this
  // back, because the receipt below is drawn from `draft`: without it, backing
  // out of an edit would leave the owner looking at figures that were never saved
  // and that match neither the record nor anything on paper.
  const pristine = {
    items: draft.items.map((it) => ({ ...it })),
    discountType: draft.discountType,
    discountValue: draft.discountValue,
    priceIncrease: draft.priceIncrease,
    paymentMethod: draft.paymentMethod,
    note: draft.note,
  };
  /** Throws the working copy away and starts again from what is on record. */
  function discardEdits() {
    draft.items = pristine.items.map((it) => ({ ...it }));
    draft.discountType = pristine.discountType;
    draft.discountValue = pristine.discountValue;
    draft.priceIncrease = pristine.priceIncrease;
    draft.paymentMethod = pristine.paymentMethod;
    draft.note = pristine.note;
  }
  let editing = false;
  let currency = 'ILS';
  /** productId → product, so each line can show the picture of what was sold. */
  let images = new Map();

  const body = el('div.inv');
  const foot = el('div.inv-foot');

  const sheet = openSheet({ title: `فاتورة ${sale.receiptNo || ''}`, body, foot });

  Promise.all([getSettings(), listProducts()]).then(([s, products]) => {
    currency = s.currency || 'ILS';
    images = new Map((products || []).map((p) => [p.id, p.image || '']));
    paint();
  });

  paint();
  return sheet;

  /* ---------------------------------------------------------------- */

  function paint() {
    clear(body);
    clear(foot);
    const t = totalsOf(draft.items, draft.discountType, draft.discountValue, draft.priceIncrease);

    if (!editing) body.appendChild(readOnly(t));
    else body.appendChild(editor(t));

    if (editing) {
      foot.appendChild(
        el('button.btn.btn--ghost', { type: 'button', onClick: () => { discardEdits(); editing = false; paint(); } },
          fromHTML(icon('x')), el('span', { text: 'إلغاء' }))
      );
      foot.appendChild(
        el('button.btn.btn--primary', { type: 'button', onClick: save }, fromHTML(icon('check')), el('span', { text: 'حفظ التعديل' }))
      );
    } else {
      foot.appendChild(
        el('button.btn.btn--ghost', { type: 'button', onClick: onRefund },
          fromHTML(icon('refresh')), el('span', { text: 'استرجاع كامل' }))
      );
      foot.appendChild(
        el('button.btn.btn--ghost', { type: 'button', onClick: onPartialRefund },
          fromHTML(icon('refresh')), el('span', { text: 'استرجاع جزئي' }))
      );
      foot.appendChild(
        el('button.btn.btn--primary', { type: 'button', onClick: () => { editing = true; paint(); } },
          fromHTML(icon('pencil')), el('span', { text: 'تعديل' }))
      );
    }
  }

  /** The picture for a line, or a neutral placeholder if the product is gone. */
  function thumb(it) {
    const src = images.get(it.productId);
    return src
      ? el('img.inv-item__img', { src, alt: '', loading: 'lazy' })
      : el('span.inv-item__img.inv-item__img--none', { 'aria-hidden': 'true' }, fromHTML(icon('hanger')));
  }

  /* --- read-only view ---------------------------------------------- */

  function readOnly(t) {
    const when = new Date(sale.timestamp);
    const payLabel = PAYMENTS.find((p) => p.id === draft.paymentMethod)?.label || draft.paymentMethod;

    // Calculate profit per line if costPrice is available
    const itemsWithProfit = draft.items.map((it) => {
      const cost = Number(it.costPrice) || 0;
      const revenue = it.qty * it.price;
      const totalCost = it.qty * cost;
      const profit = revenue - totalCost;
      return { ...it, cost, revenue, totalCost, profit };
    });

    const totalProfit = itemsWithProfit.reduce((sum, it) => sum + it.profit, 0);

    return el(
      'div',
      {},
      /* header — what this invoice is, before anything else */
      el(
        'div.inv-head',
        {},
        el(
          'div.inv-head__top',
          {},
          el('span.inv-head__label', { text: 'فاتورة بيع' }),
          el('b.inv-head__no', { text: sale.receiptNo || '—' })
        ),
        el(
          'div.inv-head__facts',
          {},
          el('span.inv-head__fact', {}, fromHTML(icon('receipt')), el('span', { text: fmtDate(when, true) })),
          el('span.inv-head__fact', {}, fromHTML(icon('clock')), el('span', { text: fmtTime(when) })),
          el('span.inv-head__fact', {}, fromHTML(icon('cash')), el('span', { text: payLabel }))
        )
      ),

      /* one card per line: what, which variant, how many, at what price */
      el(
        'div.inv-items',
        {},
        ...itemsWithProfit.map((it) =>
          el(
            'div.inv-item',
            {},
            thumb(it),
            el(
              'div.inv-item__main',
              {},
              el('div.inv-item__name', { text: it.name }),
              el(
                'div.inv-item__meta',
                {},
                it.size ? el('span.size-pill', { style: 'height:21px;min-width:auto;font-size:10.5px', text: it.size }) : null,
                it.color ? el('span', { text: it.color }) : null,
                !it.size && !it.color ? el('span', { text: '—' }) : null
              )
            ),
            el(
              'div.inv-item__grid',
              {},
              el('div.inv-cell', {}, el('span.inv-cell__k', { text: 'الكمية' }), el('b.inv-cell__v', { text: String(it.qty) })),
              el('div.inv-cell', {}, el('span.inv-cell__k', { text: 'سعر الوحدة' }), el('b.inv-cell__v', { html: moneyHTML(it.price, currency) })),
              el('div.inv-cell', {}, el('span.inv-cell__k', { text: 'التكلفة' }), el('b.inv-cell__v', { html: moneyHTML(it.cost, currency) })),
              el('div.inv-cell.inv-cell--sum', {}, el('span.inv-cell__k', { text: 'الإيراد' }), el('b.inv-cell__v', { html: moneyHTML(it.revenue, currency) })),
              el('div.inv-cell.inv-cell--sum', {}, el('span.inv-cell__k', { text: 'الربح' }), el('b.inv-cell__v', { html: moneyHTML(it.profit, currency), style: it.profit >= 0 ? 'color:var(--emerald)' : 'color:var(--danger)' }))
            )
          )
        )
      ),

      /* the money, in one block */
      el(
        'div.inv-totals',
        {},
        el('div.inv-total', {}, el('span', { text: 'المجموع الفرعي' }), el('span', { html: moneyHTML(t.subtotal, currency) })),
        t.discount > 0.004
          ? el('div.inv-total.inv-total--off', {}, el('span', { text: `الخصم${draft.discountType === 'percent' ? ` (${draft.discountValue}%)` : ''}` }), el('span', { html: `−${moneyHTML(t.discount, currency)}` }))
          : null,
        t.increase > 0.004
          ? el('div.inv-total', { style: 'color:var(--emerald)' }, el('span', { text: 'إضافة' }), el('span', { html: `+${moneyHTML(t.increase, currency)}` }))
          : null,
        el('div.inv-total.inv-total--grand', {}, el('span', { text: 'الإجمالي' }), el('span', { html: moneyHTML(t.total, currency) })),
        el('div.inv-total.inv-total--grand', { style: 'color:var(--emerald);border-top:2px solid var(--emerald)' }, el('span', { text: 'صافي الربح' }), el('span', { html: moneyHTML(totalProfit, currency) }))
      ),

      /* `html`, not `text`: the fixed-amount branch embeds moneyHTML's markup
         (a <span class="cur"> currency chip) and textContent would print it raw. */
      draft.note ? el('div.inv-note', {}, fromHTML(icon('info')), el('span', { text: draft.note })) : null
    );
  }

  /* --- editor -------------------------------------------------------- */

  function editor(t) {
    const rows = el('div.inv-items');

    draft.items.forEach((it, idx) => {
      rows.appendChild(
        el(
          'div.inv-item.inv-item--edit',
          {},
          thumb(it),
          el('div.inv-item__main', {},
            el('div.inv-item__name', { text: it.name }),
            el('div.inv-item__meta', { text: [it.size, it.color].filter(Boolean).join(' · ') || '—' })),
          el(
            'div.inv-qty',
            {},
            el('button.cb-qty', { type: 'button', 'aria-label': 'إنقاص', onClick: () => setQty(idx, it.qty - 1) }, fromHTML(icon('minus'))),
            el('span.inv-qty__n', { text: String(it.qty) }),
            el('button.cb-qty', { type: 'button', 'aria-label': 'زيادة', onClick: () => setQty(idx, it.qty + 1) }, fromHTML(icon('plus')))
          ),
          el('input.inv-price', {
            type: 'number',
            step: '0.01',
            min: '0',
            inputmode: 'decimal',
            value: String(it.price),
            'aria-label': 'سعر الوحدة',
            onInput: (e) => { it.price = nonNeg(e.target.value); refreshTotalsOnly(); },
            // A refused value is shown as refused: an empty box, not a minus
            // sign the owner has to spot and delete themselves.
            onBlur: (e) => { e.target.value = String(nonNeg(e.target.value)); },
          }),
          el('div.inv-item__sum', { html: moneyHTML(it.qty * it.price, currency) }),
          el('button.inv-item__x', {
            type: 'button',
            'aria-label': 'حذف الصنف',
            onClick: () => { draft.items.splice(idx, 1); paint(); },
          }, fromHTML(icon('trash')))
        )
      );
    });

    if (!draft.items.length) {
      rows.appendChild(el('p.inv-warn', { text: 'لا توجد أصناف — الحفظ سيجعل الفاتورة بقيمة صفر.' }));
    }

    const totalsHost = el('div.inv-totals');

    return el(
      'div',
      {},
      rows,
      el(
        'div.inv-edit-opts',
        {},
        // الخصم مبلغ ثابت فقط في الفواتير الجديدة (قرار صاحب المتجر). لا مبدّل
        // نوع هنا. الفاتورة القديمة التي كُتبت بنسبة تبقى نسبةً عند تعديلها
        // (تُقرأ وتُعدَّل كما كانت)، فالحقل يتبع نوعها المخزَّن: نسبةً لو كانت
        // كذلك، ومبلغًا فيما عدا ذلك.
        el('div.inv-field', {},
          el('label.inv-field__label', { text: draft.discountType === 'percent' ? 'نسبة الخصم %' : 'قيمة الخصم' }),
          el('input.input', {
            type: 'number', step: '0.01', min: '0',
            inputmode: 'decimal', value: String(draft.discountValue),
            onInput: (e) => { draft.discountValue = nonNeg(e.target.value); refreshTotalsOnly(); },
            onBlur: (e) => { e.target.value = String(nonNeg(e.target.value)); },
          })),
        el('div.inv-field', {},
          el('label.inv-field__label', { text: 'طريقة الدفع' }),
          el('select.input', {
            onChange: (e) => { draft.paymentMethod = e.target.value; paint(); },
          }, ...PAYMENTS.map((p) => el('option', { value: p.id, selected: p.id === draft.paymentMethod, text: p.label }))))
      ),
        el('div.inv-field', {},
          el('label.inv-field__label', { text: 'إضافة للمبلغ' }),
          el('input.input', {
            type: 'number', step: '0.01', min: '0',
            inputmode: 'decimal', value: String(draft.priceIncrease),
            onInput: (e) => { draft.priceIncrease = nonNeg(e.target.value); refreshTotalsOnly(); },
            onBlur: (e) => { e.target.value = String(nonNeg(e.target.value)); },
          })),
        totalsHost
      );
  }
  /**
   * Recomputes the totals block in place. Used while typing a price or a
   * discount: a full repaint would steal focus mid-keystroke.
   */
  function refreshTotalsOnly() {
    const t = totalsOf(draft.items, draft.discountType, draft.discountValue, draft.priceIncrease);

    for (const host of body.querySelectorAll('.inv-totals')) {
      clear(host);
      host.appendChild(el('div.inv-total', {}, el('span', { text: 'المجموع الفرعي' }), el('span', { html: moneyHTML(t.subtotal, currency) })));
      if (t.discount > 0.004) {
        host.appendChild(el('div.inv-total.inv-total--off', {}, el('span', { text: 'الخصم' }), el('span', { html: `−${moneyHTML(t.discount, currency)}` })));
      }
      host.appendChild(el('div.inv-total.inv-total--grand', {}, el('span', { text: 'الإجمالي' }), el('span', { html: moneyHTML(t.total, currency) })));
    }

    body.querySelectorAll('.inv-item--edit').forEach((row, i) => {
      const it = draft.items[i];
      if (!it) return;
      const sum = row.querySelector('.inv-item__sum');
      if (sum) sum.innerHTML = moneyHTML(it.qty * it.price, currency);
    });
  }

  function setQty(idx, next) {
    const it = draft.items[idx];
    if (!it) return;
    // No ceiling here: the point of editing a sale is often to record a quantity
    // that was not available when it was written. A floor of 1 still applies —
    // zero is not a line, it is the absence of one.
    it.qty = Math.max(1, Math.round(next) || 1);
    paint();
  }

  async function onRefund() {
    // Full refund: every line, every piece. The original sale stays intact for
    // audit; a separate refund record is created.
    const ok = await confirmDialog({
      title: 'استرجاع الفاتورة بالكامل',
      message: 'سيتم تسجيل استرجاع كامل للفاتورة وإرجاع الكميات إلى المخزون. الفاتورة الأصلية تبقى محفوظة للتتبع.',
      confirmLabel: 'تأكيد الاسترجاع الكامل',
      danger: true,
    });
    if (!ok) return;
    try {
      await refundSale(sale.id, {
        idempotencyKey: `refund-${sale.id}-full-${Date.now()}`,
      });
      sheet.close();
      toast('تم تسجيل استرجاع الفاتورة بالكامل', 'ok');
      opts.onRefund && opts.onRefund();
    } catch (err) {
      console.error('[invoice] refund failed', err);
      toast('تعذّر الاسترجاع', 'err');
    }
  }

  /** Partial refund: choose which lines and quantities to return. */
  async function onPartialRefund() {
    const items = draft.items || [];
    if (items.length === 0) {
      toast('لا توجد أصناف للاسترجاع', 'warn');
      return;
    }

    const host = el('div', { style: 'display:flex;flex-direction:column;gap:12px' });
    const inputs = items.map((it, idx) => {
      const row = el('div', { style: 'display:flex;flex-direction:column;gap:6px' }, [
        el('div', { style: 'display:flex;justify-content:space-between;gap:8px' }, [
          el('span', { text: `${it.name} (${it.qty} × ${moneyHTML(it.price, 'ILS')})` }),
          el('span', { text: `المتوفر: ${it.qty}`, style: 'font-size:0.85rem;color:#666' }),
        ]),
        el('input', {
          type: 'number',
          min: '0',
          max: String(it.qty),
          value: String(it.qty),
          style: 'width:80px;padding:6px;font-size:1rem',
        }),
      ]);
      row.querySelector('input').dataset.idx = String(idx);
      return row;
    });
    host.append(...inputs);

    const confirmed = await confirmDialog({
      title: 'استرجاع جزئي',
      message: host,
      confirmLabel: 'تأكيد الاسترجاع الجزئي',
      danger: true,
    });
    if (!confirmed) return;

    const refundItems = [];
    let anyRequested = false;
    for (let i = 0; i < items.length; i++) {
      const input = host.querySelector(`input[data-idx='${i}']`);
      const qty = Math.round(Number(input?.value) || 0);
      if (qty > 0) {
        refundItems.push({ productId: items[i].productId, size: items[i].size, color: items[i].color, qty });
        anyRequested = true;
      }
    }

    if (!anyRequested) {
      toast('يجب اختيار كمية واحدة على الأقل', 'warn');
      return;
    }

    try {
      await refundSale(sale.id, {
        items: refundItems,
        idempotencyKey: `refund-${sale.id}-partial-${Date.now()}`,
      });
      sheet.close();
      toast('تم تسجيل الاسترجاع الجزئي', 'ok');
      opts.onRefund && opts.onRefund();
    } catch (err) {
      console.error('[invoice] partial refund failed', err);
      toast('تعذّر الاسترجاع الجزئي', 'err');
    }
  }

  async function save() {
    const payload = {
      items: draft.items,
      discountType: draft.discountType,
      discountValue: draft.discountValue,
      paymentMethod: draft.paymentMethod,
      note: draft.note,
      priceIncrease: draft.priceIncrease,
    };
    try {
      await updateSale(sale.id, payload);
      sheet.close();
      toast('تم حفظ تعديل الفاتورة', 'ok');
      opts.onChanged && opts.onChanged();
    } catch (err) {
      console.error('[invoice] save failed', err);
      toast('تعذّر حفظ التعديل', 'err');
    }
  }
}

export default { openInvoiceSheet };