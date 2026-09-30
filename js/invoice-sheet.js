/**
 * Invoice details and editing.
 *
 * One sheet that reads as a receipt first — what was sold, for how much, how it
 * was paid — and turns into an editor on demand. Editing writes through
 * db.updateSale(), which moves inventory by the difference between the old and
 * new quantities, so fixing a mis-keyed line puts the stock back rather than
 * counting it twice.
 */
import { icon } from './icons.js';
import { el, fromHTML, clear, moneyHTML, fmtDate } from './utils.js';
import { openSheet, confirmDialog, toast } from './components.js';
import { updateSale, refundSale, getSettings } from './db.js';

const PAYMENTS = [
  { id: 'cash', label: 'نقداً' },
  { id: 'card', label: 'بطاقة' },
  { id: 'transfer', label: 'تحويل' },
];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function totalsOf(items, discountType, discountValue) {
  const subtotal = items.reduce((t, it) => t + it.qty * it.price, 0);
  const v = Number(discountValue) || 0;
  const discount = discountType === 'percent'
    ? round2((subtotal * Math.min(v, 100)) / 100)
    : Math.min(round2(v), subtotal);
  return { subtotal: round2(subtotal), discount, total: round2(subtotal - discount) };
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
    discountValue: Number(sale.discountValue) || 0,
    paymentMethod: sale.paymentMethod || 'cash',
    note: sale.note || '',
  };
  let editing = false;
  let currency = 'ILS';

  const body = el('div.inv');
  const foot = el('div.inv-foot');

  const sheet = openSheet({ title: `فاتورة ${sale.receiptNo || ''}`, body, foot });

  getSettings().then((s) => {
    currency = s.currency || 'ILS';
    paint();
  });

  paint();
  return sheet;

  /* ---------------------------------------------------------------- */

  function paint() {
    clear(body);
    clear(foot);
    const t = totalsOf(draft.items, draft.discountType, draft.discountValue);

    if (!editing) body.appendChild(readOnly(t));
    else body.appendChild(editor(t));

    if (editing) {
      foot.appendChild(
        el('button.btn.btn--ghost', { type: 'button', onClick: () => { editing = false; paint(); } },
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

  /* --- read-only view ---------------------------------------------- */

  function readOnly(t) {
    return el(
      'div',
      {},
      el(
        'div.inv-meta',
        {},
        el('div.inv-meta__cell', {}, el('span.tiny.muted', { text: 'التاريخ' }), el('span', { text: fmtDate(new Date(sale.timestamp), true) })),
        el('div.inv-meta__cell', {}, el('span.tiny.muted', { text: 'الدفع' }),
          el('span', { text: PAYMENTS.find((p) => p.id === draft.paymentMethod)?.label || draft.paymentMethod }))
      ),
      el(
        'div.inv-items',
        {},
        ...draft.items.map((it) =>
          el(
            'div.inv-item',
            {},
            el('div.inv-item__main', {},
              el('div.inv-item__name', { text: it.name }),
              el('div.inv-item__meta', { text: [it.size, it.color].filter(Boolean).join(' · ') || '—' })),
            el('div.inv-item__qty', { text: `×${it.qty}` }),
            el('div.inv-item__sum', { html: moneyHTML(it.qty * it.price, currency) })
          )
        )
      ),
      // `html`, not `text`: the fixed-amount branch embeds moneyHTML's markup
      // (a <span class="cur"> currency chip) and textContent would print it raw.
      t.discount > 0.004
        ? el('div.inv-note', {}, fromHTML(icon('tag')), el('span', {
            html: `خصم ${draft.discountType === 'percent' ? `${draft.discountValue}%` : moneyHTML(draft.discountValue, currency)}`,
          }))
        : null,
      el(
        'div.inv-totals',
        {},
        el('div.inv-total', {}, el('span', { text: 'المجموع' }), el('span', { html: moneyHTML(t.subtotal, currency) })),
        t.discount > 0.004 ? el('div.inv-total.inv-total--off', {}, el('span', { text: 'الخصم' }), el('span', { html: `-${moneyHTML(t.discount, currency)}` })) : null,
        el('div.inv-total.inv-total--grand', {}, el('span', { text: 'الإجمالي' }), el('span', { html: moneyHTML(t.total, currency) }))
      ),
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
            onInput: (e) => { it.price = Number(e.target.value) || 0; refreshTotalsOnly(); },
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
            el('button', { type: 'button', class: draft.discountType === 'percent' ? 'is-active' : '', text: 'نسبة %', onClick: () => { draft.discountType = 'percent'; paint(); } })
          )),
        el('div.inv-field', {},
          el('label.inv-field__label', { text: 'قيمة الخصم' }),
          el('input.input', {
            type: 'number', step: draft.discountType === 'percent' ? '1' : '0.01', min: '0',
            inputmode: 'decimal', value: String(draft.discountValue),
            onInput: (e) => { draft.discountValue = Number(e.target.value) || 0; refreshTotalsOnly(); },
          })),
        el('div.inv-field', {},
          el('label.inv-field__label', { text: 'طريقة الدفع' }),
          el('select.input', {
            onChange: (e) => { draft.paymentMethod = e.target.value; paint(); },
          }, ...PAYMENTS.map((p) => el('option', { value: p.id, selected: p.id === draft.paymentMethod, text: p.label }))))
      ),
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
      host.appendChild(el('div.inv-total', {}, el('span', { text: 'المجموع' }), el('span', { html: moneyHTML(t.subtotal, currency) })));
      if (t.discount > 0.004) {
        host.appendChild(el('div.inv-total.inv-total--off', {}, el('span', { text: 'الخصم' }), el('span', { html: `-${moneyHTML(t.discount, currency)}` })));
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
    // that was not available when it was written.
    it.qty = Math.max(0, next);
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
