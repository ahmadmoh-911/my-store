/**
 * Suppliers — the purchases side of the shop.
 *
 * Route: `#/suppliers` (list + balances) or `#/supplier/<id>` (ledger).
 *
 * Nothing in this screen touches products: a supplier bill is money we owe, not
 * stock coming in. Products are only ever changed by createSale / refundSale.
 * That is a deliberate boundary — the shop may buy from a supplier in cash and
 * enter the items on paper, and nothing about that should disturb the inventory
 * until the owner explicitly enters a purchase against it.
 */
import { icon } from '../icons.js';
import {
  el, fromHTML, clear, moneyHTML, num, debounce, initials, fmtDate, sum, isoDate,
} from '../utils.js';
import {
  listSuppliers, saveSupplier, deleteSupplier,
  listSupplierInvoices, createSupplierInvoice, deleteSupplierInvoice,
  listSupplierPayments, createSupplierPayment, deleteSupplierPayment,
  allSupplierBalances, supplierBalance, getSettings, PAYMENT_METHODS,
} from '../db.js';
import {
  pageHead, emptyState, openModal, confirmDialog, toast, sectionTitle, loadingRow,
} from '../components.js';
import { navigate } from '../router.js';

export function render(params = []) {
  const id = params[0] && !['new', 'add'].includes(params[0]) ? params[0] : null;
  return id ? renderDetail(id) : renderList();
}

const methodLabel = (m) => PAYMENT_METHODS[m] || PAYMENT_METHODS.cash;

/* ------------------------------------------------------------------ *
 * List — every supplier with what we still owe them
 * ------------------------------------------------------------------ */

function renderList() {
  const root = el('div.screen', { id: 'screen-suppliers' });
  let query = '';

  root.appendChild(
    pageHead({
      title: 'الموردون',
      sub: 'فواتير الشراء والدفعات والأرصدة',
      badge: el('span.count', { id: 'sup-count', text: '…' }),
      actions: [
        el('button.btn.btn--primary', { type: 'button', onClick: () => openEditor(null, () => paint()) }, fromHTML(icon('truck')), el('span', { text: 'مورد جديد' })),
      ],
    })
  );

  /* outstanding total across every supplier */
  const owed = el('div.card.card--pad.sup-total', { id: 'sup-owed', style: 'margin-bottom:14px' }, loadingRow());
  root.appendChild(owed);

  root.appendChild(
    el(
      'div.search',
      { style: 'margin-bottom:14px' },
      fromHTML(icon('search')),
      el('input', {
        type: 'search',
        placeholder: 'ابحث باسم المورد أو رقم الجوال…',
        oninput: debounce((e) => {
          query = e.target.value.trim().toLowerCase();
          paint();
        }, 160),
      })
    )
  );

  const host = el('div', { id: 'sup-list' });
  root.appendChild(host);

  // Two paints can overlap (typing in the search box while a save finishes).
  // Without a token the slower one appends its cards on top of the newer list,
  // duplicating rows; with it, only the newest paint is allowed to write.
  let paintToken = 0;

  async function paint() {
    // No `isConnected` check here on purpose. This screen is built before the
    // router mounts it, so a check above the first await is always false and
    // the list never loaded at all — it sat on its "…" badge forever. Every
    // other screen checks connectivity *after* awaiting, once it is mounted;
    // that is what discards a paint whose screen was swapped out mid-load.
    const token = ++paintToken;
    clear(host);
    host.appendChild(loadingRow());

    const [suppliers, invoices, payments, settings] = await Promise.all([
      listSuppliers(), listSupplierInvoices(), listSupplierPayments(), getSettings(),
    ]);
    if (token !== paintToken || !host.isConnected) return;

    try {
      const bal = allSupplierBalances(suppliers, invoices, payments);
      const invCount = new Map();
      for (const i of invoices) invCount.set(i.supplierId, (invCount.get(i.supplierId) || 0) + 1);

      const totalOwed = sum([...bal.values()], (b) => Math.max(0, b.remaining));

      const countEl = root.querySelector('#sup-count');
      if (countEl) countEl.textContent = String(suppliers.length);

      clear(owed);
      owed.appendChild(
        el(
          'div.sup-total__row',
          {},
          el(
            'div',
            {},
            el('div.tiny', { style: 'opacity:.8', text: 'إجمالي المبالغ المستحقة للموردين' }),
            el('div.amount.amount--lg', { html: moneyHTML(totalOwed, settings.currency) })
          ),
          el('div.sup-total__tag', { text: `${suppliers.length} مورد` })
        )
      );

      const list = suppliers
        .filter((s) => !query || s.name.toLowerCase().includes(query) || (s.phone || '').includes(query))
        .sort((a, b) => {
          // Heaviest debt first — that is the list the owner actually needs.
          const d = (bal.get(b.id)?.remaining || 0) - (bal.get(a.id)?.remaining || 0);
          return d || (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '');
        });

      clear(host);

      if (!suppliers.length) {
        host.appendChild(
          emptyState({
            iconName: 'truck',
            title: 'لا يوجد موردون بعد',
            text: 'أضف مورديك لتسجّل فواتير الشراء والدفعات ومتابعة ما عليك لهم.',
            action: el('button.btn.btn--primary', { type: 'button', onClick: () => openEditor(null, () => paint()) }, fromHTML(icon('truck')), el('span', { text: 'إضافة مورد' })),
          })
        );
        return;
      }

      if (!list.length) {
        host.appendChild(emptyState({ iconName: 'search', title: 'لا نتائج', text: 'جرّب اسماً أو رقماً آخر.', small: true }));
        return;
      }

      list.forEach((s, i) => {
        const b = bal.get(s.id) || { billed: 0, paid: 0, remaining: 0 };
        host.appendChild(
          el(
            'div.cust-card.fade-up',
            {
              style: `animation-delay:${Math.min(i * 40, 260)}ms`,
              tabindex: '0',
              role: 'button',
              onClick: () => navigate(`supplier/${s.id}`),
              onkeydown: (e) => e.key === 'Enter' && navigate(`supplier/${s.id}`),
            },
            el('span.avatar', { text: initials(s.name) }),
            el(
              'div.cust-card__main',
              {},
              el('div.cust-card__name.truncate', { text: s.name }),
              el('div.cust-card__phone', { text: s.phone || 'بدون رقم' }),
              el('div.cust-card__meta', {
                text: (invCount.get(s.id) || 0)
                  ? `${invCount.get(s.id)} فاتورة شراء`
                  : 'لا فواتير بعد',
              })
            ),
            el(
              'div.row__end',
              {},
              el('div.row__price', { html: moneyHTML(b.remaining, settings.currency) }),
              el('span.tiny.muted', { text: b.remaining > 0.005 ? 'مستحق' : b.remaining < -0.005 ? 'دفعة مقدمة' : 'مسدد' })
            ),
            fromHTML(icon('chevronLeft'))
          )
        );
      });
    } catch (err) {
      // A throw used to leave the list frozen on its loading row with no
      // explanation, which read as "my supplier vanished". Say what happened.
      console.error('[suppliers] paint failed', err);
      clear(host);
      host.appendChild(
        emptyState({
          iconName: 'alertCircle',
          title: 'تعذّر تحديث القائمة',
          text: 'حدث خطأ أثناء قراءة الموردين. المورد المحفوظ لم يُفقد — أعد المحاولة.',
          action: el('button.btn.btn--soft', { type: 'button', onClick: () => paint() }, fromHTML(icon('refresh')), el('span', { text: 'إعادة المحاولة' })),
        })
      );
    }
  }

  paint();
  return root;
}

/* ------------------------------------------------------------------ *
 * Detail — one supplier's ledger
 * ------------------------------------------------------------------ */

function renderDetail(id) {
  const root = el('div.screen', { id: 'screen-supplier-detail' });

  root.appendChild(
    pageHead({
      title: 'ملف المورد',
      back: () => navigate('suppliers'),
      actions: [
        el('button.btn.btn--soft', { type: 'button', onClick: () => openEditor(id, () => rebuild()) }, fromHTML(icon('pencil')), el('span', { text: 'تعديل' })),
      ],
    })
  );

  const host = el('div');
  root.appendChild(host);

  async function rebuild() {
    // connectivity is checked after the await, not before - see render() above
    clear(host);
    host.appendChild(loadingRow());

    const [suppliers, invoices, payments, settings] = await Promise.all([
      listSuppliers(), listSupplierInvoices(), listSupplierPayments(), getSettings(),
    ]);
    if (!root.isConnected) return;

    const s = suppliers.find((x) => x.id === id);
    if (!s) {
      clear(host);
      host.appendChild(
        emptyState({
          iconName: 'truck',
          title: 'المورد غير موجود',
          text: 'ربما تم حذفه.',
          action: el('button.btn.btn--primary', { type: 'button', text: 'العودة', onClick: () => navigate('suppliers') }),
        })
      );
      return;
    }

    const b = supplierBalance(s, invoices, payments);
    const cur = settings.currency;
    const mine = invoices.filter((i) => i.supplierId === id).sort((a, b2) => b2.date.localeCompare(a.date));
    const paid = payments.filter((p) => p.supplierId === id).sort((a, b2) => b2.date.localeCompare(a.date));

    clear(host);

    /* header + balance */
    host.appendChild(
      el(
        'div.card.card--pad.sup-head',
        {},
        el(
          'div.sup-head__top',
          {},
          el('span.avatar.avatar--lg', { text: initials(s.name) }),
          el(
            'div',
            { style: 'flex:1;min-width:170px' },
            el('h2', { style: 'font-size:22px', text: s.name }),
            s.phone
              ? el('a', { href: `tel:${s.phone}`, class: 'cust-card__phone', style: 'display:block;margin-top:3px;direction:ltr;text-align:start', text: s.phone })
              : el('div.tiny.muted', { text: 'بدون رقم جوال' }),
            s.notes ? el('div.tiny', { style: 'color:var(--ink-2);margin-top:6px', text: s.notes }) : null,
            el('div.tiny.muted', { style: 'margin-top:6px', text: `مورد منذ ${fmtDate(s.createdAt)}` })
          )
        ),
        el(
          'div.sup-head__balance',
          { class: b.remaining > 0.005 ? 'is-owed' : b.remaining < -0.005 ? 'is-credit' : 'is-clear' },
          el('div.tiny', { text: b.remaining > 0.005 ? 'المتبقي عليك' : b.remaining < -0.005 ? 'رصيد للمورد' : 'الحساب مسدد' }),
          el('div.amount.amount--lg', { html: moneyHTML(Math.abs(b.remaining), cur) })
        ),
        el(
          'div.sup-head__stats',
          {},
          miniStat('إجمالي الفواتير', moneyHTML(b.billed, cur)),
          miniStat('المدفوع', moneyHTML(b.paid, cur)),
          miniStat('رصيد افتتاحي', moneyHTML(b.opening, cur))
        )
      )
    );

    /* actions */
    host.appendChild(
      el(
        'div.sup-actions',
        {},
        el('button.btn.btn--primary', { type: 'button', onClick: () => openInvoiceEditor(s, null, rebuild) }, fromHTML(icon('fileText')), el('span', { text: 'فاتورة جديدة' })),
        el('button.btn.btn--ok', { type: 'button', onClick: () => openPaymentEditor(s, null, rebuild) }, fromHTML(icon('wallet')), el('span', { text: 'تسجيل دفعة' })),
        el('button.btn.btn--danger-soft', { type: 'button', onClick: removeSupplier }, fromHTML(icon('trash')), el('span', { text: 'حذف' }))
      )
    );

    /* invoices */
    host.appendChild(
      sectionTitle('فواتير الشراء', {
        iconName: 'receipt',
        count: mine.length,
        action: el('button.card-head__action', { type: 'button', text: '+ جديد', onClick: () => openInvoiceEditor(s, null, rebuild) }),
      })
    );

    if (!mine.length) {
      host.appendChild(emptyState({ iconName: 'receipt', title: 'لا توجد فواتير', text: 'سجّل أول فاتورة شراء من هذا المورد.', small: true }));
    } else {
      const wrap = el('div');
      mine.forEach((inv, i) => {
        wrap.appendChild(
          el(
            'div.row.fade-up',
            { style: `animation-delay:${Math.min(i * 45, 300)}ms` },
            el(
              'div.row__main',
              {},
              el('div.row__title', { text: inv.invoiceNo ? `فاتورة ${inv.invoiceNo}` : 'فاتورة شراء' }),
              el('div.row__sub', { text: `${fmtDate(inv.date, true)} · ${inv.items.length} صنف` }),
              el(
                'div',
                { style: 'display:flex;gap:5px;flex-wrap:wrap;margin-top:6px' },
                ...inv.items.slice(0, 3).map((it) => el('span.badge.badge--muted', { text: `${num(it.qty)}× ${it.name}` })),
                inv.items.length > 3 ? el('span.badge.badge--muted', { text: `+${inv.items.length - 3}` }) : null
              )
            ),
            el(
              'div.row__end',
              {},
              el('div.row__price', { html: moneyHTML(inv.total, cur) }),
              inv.discount > 0 ? el('span.tiny', { style: 'color:var(--success)', text: `خصم ${num(inv.discount)}` }) : null,
              el('div', { style: 'display:flex;gap:4px' },
                el('button.card-head__action', { type: 'button', text: 'عرض', onClick: () => viewInvoice(inv, cur) }),
                el('button.card-head__action', { type: 'button', text: 'تعديل', onClick: () => openInvoiceEditor(s, inv, rebuild) }),
                el('button.card-head__action', { type: 'button', text: 'حذف', onClick: () => removeInvoice(inv, rebuild) })
              )
            )
          )
        );
      });
      host.appendChild(wrap);
    }

    /* payments */
    host.appendChild(
      sectionTitle('الدفعات', {
        iconName: 'wallet',
        count: paid.length,
        action: el('button.card-head__action', { type: 'button', text: '+ جديد', onClick: () => openPaymentEditor(s, null, rebuild) }),
      })
    );

    if (!paid.length) {
      host.appendChild(emptyState({ iconName: 'wallet', title: 'لا توجد دفعات', text: 'سجّل ما تدفعه لهذا المورد ليتحدّث رصيده.', small: true }));
    } else {
      const wrap = el('div');
      paid.forEach((p, i) => {
        wrap.appendChild(
          el(
            'div.row.fade-up',
            { style: `animation-delay:${Math.min(i * 45, 300)}ms` },
            el(
              'div.row__main',
              {},
              el('div.row__title', { text: methodLabel(p.method) }),
              el('div.row__sub', { text: fmtDate(p.date, true) + (p.note ? ` · ${p.note}` : '') })
            ),
            el(
              'div.row__end',
              {},
              el('div.row__price', { html: moneyHTML(p.amount, cur) }),
              el('button.card-head__action', { type: 'button', text: 'حذف', onClick: () => removePayment(p, rebuild) })
            )
          )
        );
      });
      host.appendChild(wrap);
    }
  }

  async function removeSupplier() {
    const yes = await confirmDialog({
      title: 'حذف المورد؟',
      message: 'سيُحذف المورد مع كل فواتيره ودفعاته. المخزن لن يتأثر إطلاقاً.',
      confirmLabel: 'حذف',
      danger: true,
    });
    if (!yes) return;
    const [inv, pay] = await Promise.all([listSupplierInvoices(), listSupplierPayments()]);
    for (const i of inv.filter((x) => x.supplierId === id)) await deleteSupplierInvoice(i.id);
    for (const p of pay.filter((x) => x.supplierId === id)) await deleteSupplierPayment(p.id);
    await deleteSupplier(id);
    toast('تم حذف المورد', 'ok');
    navigate('suppliers');
  }

  rebuild();
  return root;
}

function miniStat(label, html) {
  return el('div.sup-head__stat', {}, el('div.tiny.muted', { text: label }), el('div', { html }));
}

/* ------------------------------------------------------------------ *
 * Invoice preview
 * ------------------------------------------------------------------ */

function viewInvoice(inv, cur) {
  openModal({
    title: inv.invoiceNo ? `فاتورة ${inv.invoiceNo}` : 'فاتورة شراء',
    body: el(
      'div',
      {},
      el('div.totals__row', {}, el('span', { text: 'التاريخ' }), el('span', { text: fmtDate(inv.date, true) })),
      inv.note ? el('div.totals__row', {}, el('span', { text: 'ملاحظات' }), el('span', { text: inv.note })) : null,
      el('div.divider'),
      ...inv.items.map((it) =>
        el(
          'div.row',
          { style: 'margin-bottom:8px' },
          el('div.row__main', {}, el('div.row__title', { text: it.name })),
          el('div.row__end', {}, el('div.row__price', { html: moneyHTML(it.qty * it.price, cur) }), el('span.tiny.muted', { text: `${num(it.qty)} × ${num(it.price)}` }))
        )
      ),
      el('div.divider'),
      el('div.totals__row', {}, el('span', { text: 'المجموع الفرعي' }), el('span', { html: moneyHTML(inv.subtotal, cur) })),
      inv.discount > 0 ? el('div.totals__row.totals__row--save', {}, el('span', { text: 'الخصم' }), el('span', { html: `− ${moneyHTML(inv.discount, cur)}` })) : null,
      el('div.totals__grand', {}, el('span', { style: 'font-weight:700', text: 'الإجمالي' }), el('span.amount', { html: moneyHTML(inv.total, cur) }))
    ),
    onClose: () => {},
  });
}

async function removeInvoice(inv, rebuild) {
  const yes = await confirmDialog({ title: 'حذف الفاتورة؟', message: `ستُحذف فاتورة ${inv.invoiceNo || 'الشراء'} وسيتحدّث رصيد المورد.`, confirmLabel: 'حذف', danger: true });
  if (!yes) return;
  await deleteSupplierInvoice(inv.id);
  toast('تم حذف الفاتورة', 'ok');
  rebuild();
}

async function removePayment(p, rebuild) {
  const yes = await confirmDialog({ title: 'حذف الدفعة؟', message: 'سيتحدّث رصيد المورد بعد الحذف.', confirmLabel: 'حذف', danger: true });
  if (!yes) return;
  await deleteSupplierPayment(p.id);
  toast('تم حذف الدفعة', 'ok');
  rebuild();
}

/* ------------------------------------------------------------------ *
 * New / edit invoice
 * ------------------------------------------------------------------ */

function openInvoiceEditor(supplier, inv, onDone) {
  const noInput = el('input.input', { type: 'text', placeholder: 'رقم فاتورة المورد', style: 'direction:ltr;text-align:right' });
  const dateInput = el('input.input', { type: 'date', value: isoDate(inv ? inv.date : new Date()) });
  const discountInput = el('input.input.input--money', { type: 'number', step: '0.01', min: '0', placeholder: '0' });
  const noteInput = el('input.input', { type: 'text', placeholder: 'ملاحظات اختيارية…' });

  const linesHost = el('div.sup-lines');
  const totalEl = el('div.totals__grand', {}, el('span', { style: 'font-weight:700', text: 'الإجمالي' }), el('span.amount', { html: moneyHTML(0, 'ILS') }));
  let currency = 'ILS';
  let lines = [];

  if (inv) {
    noInput.value = inv.invoiceNo || '';
    dateInput.value = isoDate(inv.date);
    discountInput.value = inv.discount || '';
    noteInput.value = inv.note || '';
    lines = inv.items.map((it) => ({ ...it }));
  }

  function paintLines() {
    clear(linesHost);
    if (!lines.length) {
      linesHost.appendChild(el('p.tiny.muted', { text: 'أضف صنفاً واحداً على الأقل.', style: 'padding:10px 0' }));
    }
    lines.forEach((ln, i) => {
      const name = el('input.input', { type: 'text', value: ln.name, placeholder: 'اسم الصنف', oninput: (e) => { ln.name = e.target.value; } });
      const qty = el('input.input', { type: 'number', step: '1', min: '1', value: ln.qty || 1, style: 'text-align:center', oninput: (e) => { ln.qty = Number(e.target.value) || 0; recalc(); } });
      const price = el('input.input.input--money', { type: 'number', step: '0.01', min: '0', value: ln.price || 0, oninput: (e) => { ln.price = Number(e.target.value) || 0; recalc(); } });

      linesHost.appendChild(
        el(
          'div.sup-line',
          {},
          el(
            'div.sup-line__row',
            {},
            el('div', { style: 'flex:2;min-width:0' }, name),
            qty,
            price
          ),
          el('div.sup-line__foot', {},
            el('span.tiny.muted', { text: `${num(ln.qty || 0)} × ${num(ln.price || 0)} = ${num((ln.qty || 0) * (ln.price || 0))}` }),
            el('button.card-head__action', { type: 'button', text: 'حذف', onClick: () => { lines.splice(i, 1); paintLines(); recalc(); } })
          )
        )
      );
    });
    recalc();
  }

  function recalc() {
    const sub = lines.reduce((t, l) => t + (Number(l.qty) || 0) * (Number(l.price) || 0), 0);
    const total = Math.max(0, sub - (Number(discountInput.value) || 0));
    totalEl.lastElementChild.innerHTML = moneyHTML(total, currency);
  }

  discountInput.addEventListener('input', recalc);

  const body = el(
    'div',
    {},
    el('div.field', {}, el('label.field__label', { text: 'رقم الفاتورة' }), noInput),
    el('div.field', {}, el('label.field__label', { text: 'التاريخ' }), dateInput),
    el(
      'div.sup-line__head',
      {},
      el('span.tiny', { style: 'font-weight:600', text: 'الأصناف' }),
      el('button.btn.btn--sm.btn--soft', { type: 'button', onClick: () => { lines.push({ name: '', qty: 1, price: 0 }); paintLines(); } }, fromHTML(icon('plus')), el('span', { text: 'صنف' }))
    ),
    linesHost,
    el('div.field', {}, el('label.field__label', { text: 'خصم على الفاتورة' }), discountInput),
    el('div.field', {}, el('label.field__label', { text: 'ملاحظات' }), noteInput),
    totalEl,
    el('p.tiny.muted', { text: 'هذه الفاتورة لا تغيّر المخزن — الكميات والأسعار تعمل فقط هنا.', style: 'margin-top:8px' })
  );

  const m = openModal({
    title: inv ? 'تعديل فاتورة شراء' : 'فاتورة شراء جديدة',
    body,
    onClose: () => {},
    foot: [
      el('button.btn', { type: 'button', text: 'إلغاء', onClick: () => m.close() }),
      el('button.btn.btn--primary', { type: 'button', text: 'حفظ', onClick: save }),
    ],
  });

  getSettings().then((set) => {
    currency = set.currency;
    recalc();
  });
  paintLines();

  async function save() {
    const clean = lines
      .map((l) => ({ name: String(l.name || '').trim(), qty: Number(l.qty) || 0, price: Number(l.price) || 0 }))
      .filter((l) => l.name && l.qty > 0);
    if (!clean.length) {
      toast('أضف صنفاً واحداً على الأقل', 'warn');
      return;
    }
    await createSupplierInvoice({
      id: inv?.id,
      supplierId: supplier.id,
      invoiceNo: noInput.value.trim(),
      date: new Date(dateInput.value || Date.now()).toISOString(),
      items: clean,
      discount: Number(discountInput.value) || 0,
      note: noteInput.value.trim(),
    });
    m.close();
    onDone && onDone();
    toast(inv ? 'تم تحديث الفاتورة' : 'تم تسجيل فاتورة الشراء', 'ok');
  }
}

/* ------------------------------------------------------------------ *
 * New payment
 * ------------------------------------------------------------------ */

function openPaymentEditor(supplier, pay, onDone) {
  const amount = el('input.input.input--money', { type: 'number', step: '0.01', min: '0', placeholder: '0', style: 'font-size:22px;text-align:center' });
  const dateInput = el('input.input', { type: 'date', value: isoDate(pay ? pay.date : new Date()) });
  const noteInput = el('input.input', { type: 'text', placeholder: 'ملاحظات اختيارية…' });

  let method = pay?.method || 'cash';
  const seg = el('div.seg');
  Object.entries(PAYMENT_METHODS).forEach(([k, label]) => {
    seg.appendChild(
      el('button', {
        type: 'button',
        text: label,
        class: k === method ? 'is-active' : '',
        onClick: (e) => {
          method = k;
          [...seg.children].forEach((c) => (c.className = ''));
          e.currentTarget.className = 'is-active';
        },
      })
    );
  });

  if (pay) amount.value = pay.amount || '';
  if (pay) noteInput.value = pay.note || '';

  const body = el(
    'div',
    {},
    el('div.field', {}, el('label.field__label', {}, el('span', { text: 'المبلغ المدفوع' }), el('span.req', { text: '*' })), amount),
    el('div.field', {}, el('label.field__label', { text: 'التاريخ' }), dateInput),
    el('div.field', {}, el('label.field__label', { text: 'طريقة الدفع' }), seg),
    el('div.field', {}, el('label.field__label', { text: 'ملاحظات' }), noteInput)
  );

  const m = openModal({
    title: pay ? 'تعديل الدفعة' : 'تسجيل دفعة',
    body,
    onClose: () => {},
    foot: [
      el('button.btn', { type: 'button', text: 'إلغاء', onClick: () => m.close() }),
      el('button.btn.btn--ok', { type: 'button', text: 'حفظ', onClick: save }),
    ],
  });

  setTimeout(() => amount.focus(), 60);

  async function save() {
    const v = Math.abs(Number(amount.value) || 0);
    if (v <= 0) {
      toast('أدخل مبلغاً أكبر من صفر', 'warn');
      amount.focus();
      return;
    }
    await createSupplierPayment({
      id: pay?.id,
      supplierId: supplier.id,
      amount: v,
      method,
      date: new Date(dateInput.value || Date.now()).toISOString(),
      note: noteInput.value.trim(),
    });
    m.close();
    onDone && onDone();
    toast(pay ? 'تم تحديث الدفعة' : 'تم تسجيل الدفعة', 'ok');
  }
}

/* ------------------------------------------------------------------ *
 * Create / edit supplier
 * ------------------------------------------------------------------ */

function openEditor(id, onDone) {
  const nameInput = el('input.input', { type: 'text', placeholder: 'اسم المورد' });
  const phoneInput = el('input.input', { type: 'tel', inputmode: 'tel', placeholder: '05xxxxxxxx', class: 'input ltr', style: 'text-align:right' });
  const notesInput = el('textarea.textarea', { placeholder: 'ملاحظات اختيارية…', style: 'min-height:70px' });
  const openingInput = el('input.input.input--money', { type: 'number', step: '0.01', placeholder: '0' });

  const nameField = el('div.field', {}, el('label.field__label', {}, el('span', { text: 'الاسم' }), el('span.req', { text: '*' })), nameInput, el('div.field__error', {}, fromHTML(icon('alertCircle')), el('span', { text: 'الاسم مطلوب' })));
  const phoneField = el('div.field', {}, el('label.field__label', { text: 'رقم الجوال' }), phoneInput, el('div.field__error', {}, fromHTML(icon('alertCircle')), el('span', { text: 'رقم غير صالح' })));

  const body = el(
    'div',
    {},
    nameField,
    phoneField,
    el('div.field', {}, el('label.field__label', { text: 'رصيد افتتاحي (ما عليه من قبل)' }), openingInput),
    el('div.field', {}, el('label.field__label', { text: 'ملاحظات' }), notesInput)
  );

  if (id) {
    listSuppliers().then((all) => {
      const s = all.find((x) => x.id === id);
      if (s) {
        nameInput.value = s.name;
        phoneInput.value = s.phone || '';
        notesInput.value = s.notes || '';
        openingInput.value = s.openingBalance || '';
      }
    });
  }

  const m = openModal({
    title: id ? 'تعديل بيانات المورد' : 'مورد جديد',
    body,
    onClose: () => {},
    foot: [
      el('button.btn', { type: 'button', text: 'إلغاء', onClick: () => m.close() }),
      el('button.btn.btn--primary', { type: 'button', text: 'حفظ', onClick: save }),
    ],
  });

  setTimeout(() => nameInput.focus(), 60);

  async function save() {
    nameField.classList.remove('has-error');
    phoneField.classList.remove('has-error');

    const name = nameInput.value.trim();
    const phone = phoneInput.value.trim();

    if (name.length < 2) {
      nameField.classList.add('has-error');
      nameInput.focus();
      return;
    }
    if (phone && !/^[+\d][\d\s-]{5,}$/.test(phone)) {
      phoneField.classList.add('has-error');
      phoneInput.focus();
      return;
    }

    const existing = id ? (await listSuppliers()).find((x) => x.id === id) : null;
    // A failed write used to reject silently: the modal stayed open with no
    // message, so it looked like the save never happened. Report it instead,
    // and leave the form open so nothing the user typed is lost.
    try {
      await saveSupplier({
        id: existing?.id,
        name,
        phone,
        notes: notesInput.value.trim(),
        openingBalance: Number(openingInput.value) || 0,
        createdAt: existing?.createdAt,
      });
    } catch (err) {
      console.error('[suppliers] save failed', err);
      toast('تعذّر حفظ المورد — تأكد من المساحة المتاحة', 'err');
      return;
    }

    m.close();
    onDone && onDone();
    toast(id ? 'تم تحديث بيانات المورد' : 'تمت إضافة المورد', 'ok');
  }
}

export default { render };
