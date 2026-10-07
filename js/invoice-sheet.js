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

const PAYMENTS = [
  { id: 'cash', label: 'نقداً' },
  { id: 'card', label: 'بطاقة' },
  { id: 'transfer', label: 'تحويل' },
];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Any number at or above zero. A price typed as "-5" is 0, not minus five. */
const nonNeg = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function totalsOf(items, discountType, discountValue, priceIncrease = 0) {
  const subtotal = items.reduce((t, it) => t + it.qty * it.price, 0);
  const v = nonNeg(discountValue);
  const discount = discountType === 'percent'
    ? round2((subtotal * Math.min(v, 100)) / 100)
    : Math.min(round2(v), subtotal);
  const increase = nonNeg(priceIncrease);
  return { subtotal: round2(subtotal), discount, increase, total: round2(subtotal - discount + increase) };
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
          fromHTML(icon('refresh')), el('span', { text: 'استرجاع' }))
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
        ...draft.items.map((it) =>
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
              el('div.inv-cell.inv-cell--sum', {}, el('span.inv-cell__k', { text: 'الإجمالي' }), el('b.inv-cell__v', { html: moneyHTML(it.qty * it.price, currency) }))
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
        el('div.inv-total.inv-total--grand', {}, el('span', { text: 'الإجمالي' }), el('span', { html: moneyHTML(t.total, currency) }))
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
        el('div.inv-field', {},
          el('label.inv-field__label', { text: 'نوع الخصم' }),
          el('div.seg', {},
            el('button', { type: 'button', class: draft.discountType === 'fixed' ? 'is-active' : '', text: 'مبلغ', onClick: () => { draft.discountType = 'fixed'; paint(); } }),
            el('button', { type: 'button', class: draft.discountType === 'percent' ? 'is-active' : '', text: 'نسبة %', onClick: () => { draft.discountType = 'percent'; paint(); } }))),
        el('div.inv-field', {},
          el('label.inv-field__label', { text: 'قيمة الخصم' }),
          el('input.input', {
            type: 'number', step: draft.discountType === 'percent' ? '1' : '0.01', min: '0',
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
    const t = totalsOf(draft.items, draft.discountType, draft.discountValue);

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
    const ok = await confirmDialog({
      title: 'استرجاع الفاتورة',
      message: 'سيتم حذف الفاتورة وإرجاع الكميات إلى المخزون.',
      confirmLabel: 'استرجاع',
      danger: true,
    });
    if (!ok) return;
    try {
      await refundSale(sale.id);
      sheet.close();
      toast('تم استرجاع الفاتورة', 'ok');
      opts.onRefund && opts.onRefund();
    } catch (err) {
      console.error('[invoice] refund failed', err);
      toast('تعذّر الاسترجاع', 'err');
    }
  }

  async function save() {
    const payload = {
      items: draft.items,
      discountType: draft.discountType,
      discountValue: draft.discountValue,
      paymentMethod: draft.paymentMethod,
      note: draft.note,
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