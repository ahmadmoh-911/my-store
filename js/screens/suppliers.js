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
  listSupplierPayments, createSupplierPayment,
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

  /* Two figures the owner checks before anything else, side by side:
     how much is owed in total, and how many suppliers it is owed to. One card
     with one number hid half the question — "is this one big debt or ten small
     ones?" only has two answers, so both are on screen. */
  const owed = el('div.sup-summary', { id: 'sup-owed', style: 'margin-bottom:14px' });
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
      const owedCount = [...bal.values()].filter((b) => b.remaining > 0.005).length;

      // Tapping the "suppliers with a balance" tile narrows the list to exactly
      // the ones that owe — a number you can act on, not just read. Tapping it
      // again puts the whole list back, so the tile is a toggle and not a trap.
      let owedFocused = false;
      function focusOwed(balances) {
        owedFocused = !owedFocused;
        if (!owedFocused) {
          for (const card of host.querySelectorAll('.cust-card')) {
            card.classList.remove('is-owed-focus');
            card.classList.remove('is-dimmed');
          }
          owed.querySelectorAll('.sup-kpi').forEach((k) => k.classList.remove('is-on'));
          return;
        }
        const ids = new Set([...balances.entries()].filter(([, b]) => b.remaining > 0.005).map(([id]) => id));
        for (const card of host.querySelectorAll('.cust-card')) {
          const on = ids.has(card.dataset.id);
          card.classList.toggle('is-owed-focus', on);
          card.classList.toggle('is-dimmed', !on);
        }
        owed.querySelectorAll('.sup-kpi').forEach((k, i) => k.classList.toggle('is-on', i === 1));
        // optional call: older WebViews (and jsdom) have no scrollIntoView
        host.querySelector('.cust-card.is-owed-focus')?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      }

      const countEl = root.querySelector('#sup-count');
      if (countEl) countEl.textContent = String(suppliers.length);

      clear(owed);
      owed.appendChild(
        el(
          'div.stat.stat--slim.sup-kpi',
          {},
          el('div.stat__top', {}, el('div.stat__icon.stat__icon--sm.stat__icon--brass', {}, fromHTML(icon('wallet'))), el('div.stat__label', { text: 'إجمالي المبلغ المستحق للموردين' })),
          el('div.stat__value', {}, el('span', { html: moneyHTML(totalOwed, settings.currency) }))
        )
      );
      owed.appendChild(
        el(
          'div.stat.stat--slim.sup-kpi',
          { role: 'button', tabindex: '0', onClick: () => focusOwed(bal), onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && focusOwed(bal) },
          el('div.stat__top', {}, el('div.stat__icon.stat__icon--sm.stat__icon--danger', {}, fromHTML(icon('users'))), el('div.stat__label', { text: 'عدد الموردين الذين لهم رصيد' })),
          el('div.stat__value', {}, el('span', { text: String(owedCount) }), el('small', { text: 'مورد' }))
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
        const repaint = () => paint();
        const stmt = () => openStatement(s, b, repaint);

        // The three things that actually happen with a supplier, all reachable
        // from the list: record what was paid, record what was bought, or read
        // the whole account. The card itself still opens the full file.
        const acts = el(
          'div.sup-row__acts',
          {},
          el('button.pill-btn.pill-btn--sm.pill-btn--ok', {
            type: 'button',
            onClick: (e) => { e.stopPropagation(); openPaymentEditor(s, null, repaint); },
          }, fromHTML(icon('cash')), el('span', { text: 'تسجيل دفعة جديدة' })),
          el('button.pill-btn.pill-btn--sm.pill-btn--add2', {
            type: 'button',
            onClick: (e) => { e.stopPropagation(); openInvoiceEditor(s, null, repaint); },
          }, fromHTML(icon('fileText')), el('span', { text: 'تسجيل فاتورة جديدة' })),
          el('button.pill-btn.pill-btn--sm.pill-btn--edit', {
            type: 'button',
            onClick: (e) => { e.stopPropagation(); stmt(); },
          }, fromHTML(icon('receipt')), el('span', { text: 'كشف حساب' }))
        );

        host.appendChild(
          el(
            'div.cust-card.cust-card--wide.fade-up',
            {
              style: `animation-delay:${Math.min(i * 40, 260)}ms`,
              dataset: { id: s.id },
            },
            el(
              'div.cust-card__hit',
              {
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
            ),
            acts
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

    /* The same three actions as the list row. Delete is not one of them — it
       lives at the bottom of the statement sheet instead, so the primary
       actions stay the three things that happen with a supplier weekly. */
    host.appendChild(
      el(
        'div.sup-actions',
        {},
        el('button.btn.btn--ok', { type: 'button', onClick: () => openPaymentEditor(s, null, rebuild) }, fromHTML(icon('wallet')), el('span', { text: 'تسجيل دفعة جديدة' })),
        el('button.btn.btn--primary', { type: 'button', onClick: () => openInvoiceEditor(s, null, rebuild) }, fromHTML(icon('fileText')), el('span', { text: 'تسجيل فاتورة جديدة' })),
        el('button.btn.btn--soft', { type: 'button', onClick: () => openStatement(s, b, rebuild) }, fromHTML(icon('receipt')), el('span', { text: 'كشف حساب' }))
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
        // The whole card opens the invoice. Previously the only way in was a
        // 5px-padded "عرض" word inside a flex-shrink:0 corner, so on a phone the
        // row looked tappable and did nothing when tapped — which is exactly
        // how "the invoice section does not respond" reads. edit/delete keep
        // their own buttons and stopPropagation so they do not double-fire.
        const open = () => viewInvoice(inv, cur);
        const row = el(
          'div.row.row--tap.fade-up',
          {
            style: `animation-delay:${Math.min(i * 45, 300)}ms`,
            role: 'button',
            tabindex: '0',
            'aria-label': inv.invoiceNo ? `عرض فاتورة ${inv.invoiceNo}` : 'عرض فاتورة شراء',
            onClick: open,
            onkeydown: (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                open();
              }
            },
          },
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
            el(
              'div',
              { style: 'display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end' },
              inv.payStatus === 'full'
                ? el('span.badge.badge--ok', { text: 'مسددة' })
                : inv.payStatus === 'partial'
                  ? el('span.badge.badge--low', { text: `متبقي ${num((inv.total || 0) - (inv.paid || 0))}` })
                  : el('span.badge.badge--muted', { text: 'على الحساب' }),
              inv.discount > 0 ? el('span.tiny', { style: 'color:var(--success)', text: `خصم ${num(inv.discount)}` }) : null,
              el(
                'div',
                { style: 'display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end' },
                el('button.card-head__action', { type: 'button', text: 'عرض', onClick: (e) => { e.stopPropagation(); open(); } }),
                el('button.card-head__action', { type: 'button', text: 'تعديل', onClick: (e) => { e.stopPropagation(); openInvoiceEditor(s, inv, rebuild); } }),
                el('button.card-head__action', { type: 'button', text: 'حذف', onClick: (e) => { e.stopPropagation(); removeInvoice(inv, rebuild); } })
              )
            )
          )
        );
        wrap.appendChild(row);
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
              el(
                'div',
                { style: 'display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end' },
                // openPaymentEditor() already accepts an existing payment and
                // writes through createSupplierPayment({ id: pay?.id, ... }), so
                // editing one needs no new code — only a way in.
                el('button.card-head__action', { type: 'button', text: 'تعديل', onClick: () => openPaymentEditor(s, p, rebuild) }),
                el('button.card-head__action', { type: 'button', text: 'حذف', onClick: () => removePayment(p, rebuild) })
              )
            )
          )
        );
      });
      host.appendChild(wrap);
    }
  }

  rebuild();
  return root;
}

function miniStat(label, html) {
  return el('div.sup-head__stat', {}, el('div.tiny.muted', { text: label }), el('div', { html }));
}

/* ------------------------------------------------------------------ *
 * كشف حساب — one supplier's account, in order
 *
 * Invoices and payments merged into a single running balance, oldest first,
 * each on its own row with its own date and amount. The old inline view put
 * two separate lists on screen with no running total, so "how much do we owe
 * him now" had to be worked out by hand. Here it is simply the last line.
 * ------------------------------------------------------------------ */

function openStatement(supplier, knownBalance, onDone) {
  const host = el('div.stmt');
  const m = openModal({
    title: `كشف حساب — ${supplier.name}`,
    body: host,
    size: '',
    onClose: () => {},
    foot: [
      el('button.btn.btn--danger-soft', { type: 'button', text: 'حذف المورد', onClick: async () => { m.close(); await removeSupplierNow(); } }),
      el('button.btn.btn--primary', { type: 'button', text: 'إغلاق', onClick: () => m.close() }),
    ],
  });

  host.appendChild(loadingRow());

  // Deleting a supplier is reachable from here rather than from a fourth
  // button on the row — it is the only action here that destroys data.
  async function removeSupplierNow() {
    const yes = await confirmDialog({
      title: 'حذف المورد؟',
      message: 'سيُحذف المورد مع كل فواتيره ودفعاته. المخزن لن يتأثر إطلاقاً.',
      confirmLabel: 'حذف',
      danger: true,
    });
    if (!yes) {
      m.close();
      return;
    }
    m.close();
    // deleteSupplier cascades to this supplier's invoices and payments in one
    // transaction, so there is nothing left for the screen to clean up by hand.
    await deleteSupplier(supplier.id);
    toast('تم حذف المورد', 'ok');
    navigate('suppliers');
    onDone && onDone();
  }

  (async () => {
    const [invoices, payments, settings] = await Promise.all([
      listSupplierInvoices(),
      listSupplierPayments(),
      getSettings(),
    ]);
    if (!host.isConnected) return;

    const cur = settings.currency;
    const b = supplierBalance(supplier, invoices, payments);

    // One timeline: invoices add to what we owe, payments take off. Oldest
    // first so the running balance reads like a bank statement.
    const events = [
      ...invoices
        .filter((i) => i.supplierId === supplier.id)
        .map((i) => ({ at: i.date, kind: 'invoice', ref: i })),
      ...payments
        .filter((p) => p.supplierId === supplier.id)
        .map((p) => ({ at: p.date, kind: 'payment', ref: p })),
    ].sort((a, c) => String(a.at).localeCompare(String(c.at)));

    clear(host);

    host.appendChild(
      el(
        'div.stmt-summary',
        {},
        miniStat('رصيد افتتاحي', moneyHTML(b.opening, cur)),
        miniStat('إجمالي الفواتير', moneyHTML(b.billed, cur)),
        miniStat('إجمالي المدفوع', moneyHTML(b.paid, cur))
      )
    );
    host.appendChild(
      el(
        'div.stmt-closing',
        { class: b.remaining > 0.005 ? 'is-owed' : b.remaining < -0.005 ? 'is-credit' : 'is-clear' },
        el('div.tiny', { text: b.remaining > 0.005 ? 'المتبقي على المتجر' : b.remaining < -0.005 ? 'دفعة مقدمة للمورد' : 'الحساب مسدد بالكامل' }),
        el('div.amount.amount--lg', { html: moneyHTML(Math.abs(b.remaining), cur) })
      )
    );

    if (!events.length) {
      host.appendChild(emptyState({ iconName: 'receipt', title: 'لا حركات على هذا الحساب', text: 'سجّل فاتورة أو دفعة ليظهر كشف الحساب.', small: true }));
      return;
    }

    let running = b.opening;
    const rows = el('div.stmt-rows');
    for (const ev of events) {
      if (ev.kind === 'invoice') {
        running += ev.ref.total || 0;
        rows.appendChild(
          el(
            'div.stmt-row.stmt-row--inv',
            {},
            el('div.stmt-row__icon', { html: icon('fileText') }),
            el(
              'div.stmt-row__main',
              {},
              el('div.stmt-row__title', { text: ev.ref.invoiceNo ? `فاتورة ${ev.ref.invoiceNo}` : 'فاتورة شراء' }),
              el('div.stmt-row__sub', {
                text: `${fmtDate(ev.at)} · ${sum(ev.ref.items || [], (i) => Number(i.qty) || 0)} قطعة` +
                  (ev.ref.payStatus === 'full' ? ' · مسددة' : ev.ref.payStatus === 'partial' ? ` · مدفوعة ${num(ev.ref.paid || 0)}` : ''),
              })
            ),
            el(
              'div.stmt-row__end',
              {},
              el('div.stmt-row__amt.is-plus', { html: `+ ${moneyHTML(ev.ref.total, cur)}` }),
              el('div.stmt-row__bal', { text: `الرصيد ${num(running)}` })
            )
          )
        );
      } else {
        running -= ev.ref.amount || 0;
        rows.appendChild(
          el(
            'div.stmt-row.stmt-row--pay',
            {},
            el('div.stmt-row__icon', { html: icon('wallet') }),
            el(
              'div.stmt-row__main',
              {},
              el('div.stmt-row__title', { text: methodLabel(ev.ref.method) }),
              el('div.stmt-row__sub', { text: `${fmtDate(ev.at)}${ev.ref.note ? ` · ${ev.ref.note}` : ''}` })
            ),
            el(
              'div.stmt-row__end',
              {},
              el('div.stmt-row__amt.is-minus', { html: `− ${moneyHTML(ev.ref.amount, cur)}` }),
              el('div.stmt-row__bal', { text: `الرصيد ${num(running)}` })
            )
          )
        );
      }
    }
    host.appendChild(rows);
    host.appendChild(
      el('p.tiny.muted', { style: 'margin-top:12px', text: 'الرصيد = الرصيد الافتتاحي + كل الفواتير − كل الدفعات. فاتورة المورد هنا لا تُغيّر المخزون.' })
    );
    void knownBalance;
  })();
}

/* ------------------------------------------------------------------ *
 * Invoice preview
 * ------------------------------------------------------------------ */

function viewInvoice(inv, cur) {
  const m = openModal({
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
      el('div.totals__grand', {}, el('span', { style: 'font-weight:700', text: 'الإجمالي' }), el('span.amount', { html: moneyHTML(inv.total, cur) })),
      el('div.divider'),
      el(
        'div.stmt-settle__grid',
        {},
        el('div.stmt-cell', {}, el('span.tiny.muted', { text: 'المدفوع' }), el('b', { html: moneyHTML(inv.paid || 0, cur) })),
        el('div.stmt-cell.is-owed', {}, el('span.tiny.muted', { text: 'المتبقي للمورد' }), el('b', { html: moneyHTML((inv.total || 0) - (inv.paid || 0), cur) }))
      )
    ),
    onClose: () => {},
    // a full-width close target: the header ✕ alone is a 20px tap on a phone,
    // and this modal can grow past the screen with a long invoice
    foot: [el('button.btn.btn--primary', { type: 'button', text: 'إغلاق', onClick: () => m.close() })],
  });
  return m;
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

  // How the bill is being settled. Written as a real payment record when money
  // actually moved, and as nothing at all when the whole bill is carried on
  // the supplier's account — which is the same thing as saying "we owe it".
  const PAY_STATUS = [
    { id: 'carried', label: 'مُرحَّل على رصيد المورد', hint: 'لا يوجد دفع الآن — المبلغ كله يبقى مستحقاً للمورد' },
    { id: 'partial', label: 'دفعة جزئية', hint: 'ادفع جزءاً الآن والباقي يبقى على الحساب' },
    { id: 'full', label: 'مدفوعة بالكامل', hint: 'ادفع الفاتورة كاملة الآن' },
  ];
  let payStatus = inv?.payStatus || 'carried';
  let paidInput = el('input.input.input--money', { type: 'number', step: '0.01', min: '0', placeholder: '0', disabled: true });
  const paidField = el('div.field', { hidden: payStatus !== 'partial' }, el('label.field__label', { text: 'المبلغ المدفوع الآن' }), paidInput);
  const statusHost = el('div.opt-wrap');
  const statusHint = el('p.tiny.muted', { style: 'margin-top:8px' });

  function paintStatus() {
    clear(statusHost);
    for (const st of PAY_STATUS) {
      statusHost.appendChild(
        el(`button.opt${payStatus === st.id ? '.is-on' : ''}`, {
          type: 'button',
          text: st.label,
          onClick: () => {
            payStatus = st.id;
            paidInput.disabled = st.id !== 'partial';
            paidField.hidden = st.id !== 'partial';
            paintStatus();
            recalc();
          },
        })
      );
    }
    statusHint.textContent = PAY_STATUS.find((s) => s.id === payStatus)?.hint || '';
    if (payStatus === 'partial' && !paidInput.value) {
      paidInput.value = String(Math.round(invoiceTotal() * 100) / 100);
    }
  }

  const linesHost = el('div.sup-lines');
  const totalEl = el('div.totals__grand', {}, el('span', { style: 'font-weight:700', text: 'الإجمالي' }), el('span.amount', { html: moneyHTML(0, 'ILS') }));
  const settledEl = el('div.stmt-settle');
  let currency = 'ILS';
  let lines = [];

  if (inv) {
    noInput.value = inv.invoiceNo || '';
    dateInput.value = isoDate(inv.date);
    discountInput.value = inv.discount || '';
    noteInput.value = inv.note || '';
    paidInput.value = inv.paid || '';
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
            el('span.tiny.muted', { text: `${num(ln.qty || 0)} قطعة × ${num(ln.price || 0)} = ${num((ln.qty || 0) * (ln.price || 0))}` }),
            el('button.card-head__action', { type: 'button', text: 'حذف', onClick: () => { lines.splice(i, 1); paintLines(); recalc(); } })
          )
        )
      );
    });
    recalc();
  }

  const invoiceTotal = () =>
    Math.max(0, lines.reduce((t, l) => t + (Number(l.qty) || 0) * (Number(l.price) || 0), 0) - (Number(discountInput.value) || 0));

  /** The part of the bill actually handed over now, clamped to the bill. */
  const paidNow = () => {
    if (payStatus === 'full') return invoiceTotal();
    if (payStatus === 'partial') return Math.min(invoiceTotal(), Math.max(0, Number(paidInput.value) || 0));
    return 0;
  };

  function recalc() {
    const total = invoiceTotal();
    const paid = paidNow();
    totalEl.lastElementChild.innerHTML = moneyHTML(total, currency);

    // The three numbers an invoice has to answer, always visible: what it is
    // worth, how much of it moved, and what is left on the supplier's account.
    clear(settledEl);
    settledEl.appendChild(
      el('div.stmt-settle__grid', {},
        el('div.stmt-cell', {}, el('span.tiny.muted', { text: 'إجمالي الفاتورة' }), el('b', { html: moneyHTML(total, currency) })),
        el('div.stmt-cell', {}, el('span.tiny.muted', { text: 'المدفوع' }), el('b', { html: moneyHTML(paid, currency) })),
        el('div.stmt-cell.is-owed', {}, el('span.tiny.muted', { text: 'المتبقي للمورد' }), el('b', { html: moneyHTML(total - paid, currency) })))
    );
  }

  discountInput.addEventListener('input', recalc);
  paidInput.addEventListener('input', recalc);

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
    el('div.field', {}, el('label.field__label', {}, el('span', { text: 'حالة السداد' }), el('span.field__hint', { text: 'ما الذي سيُدفع من الفاتورة الآن' })), statusHost, paidField, statusHint),
    el('div.field', {}, el('label.field__label', { text: 'ملاحظات' }), noteInput),
    totalEl,
    settledEl,
    el('p.tiny.muted', { text: 'هذه الفاتورة لا تغيّر المخزن — الكميات والأسعار تعمل فقط هنا. لإضافة بضاعة إلى المخزن استخدم «تجديد الكمية».', style: 'margin-top:8px' })
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
  paintStatus();

  async function save() {
    const clean = lines
      .map((l) => ({ name: String(l.name || '').trim(), qty: Number(l.qty) || 0, price: Number(l.price) || 0 }))
      .filter((l) => l.name && l.qty > 0);
    if (!clean.length) {
      toast('أضف صنفاً واحداً على الأقل', 'warn');
      return;
    }
    const date = new Date(dateInput.value || Date.now()).toISOString();
    const paid = Math.round(paidNow() * 100) / 100;

    try {
      const invoiceId = await createSupplierInvoice({
        id: inv?.id,
        supplierId: supplier.id,
        invoiceNo: noInput.value.trim(),
        date,
        items: clean,
        discount: Number(discountInput.value) || 0,
        note: noteInput.value.trim(),
        payStatus,
        paid,
      });

      // The money that actually moved is a real payment row, so the supplier
      // balance and the statement both read it without any special-casing.
      // On an edit that row already exists and is REPLACED — saving the same
      // invoice twice must never pay it twice.
      if (inv?.id) {
        const stale = (await listSupplierPayments()).filter((p) => p.invoiceId === inv.id);
        for (const p of stale) await deleteSupplierPayment(p.id);
      }
      if (paid > 0) {
        await createSupplierPayment({
          supplierId: supplier.id,
          amount: paid,
          method: 'cash',
          date,
          invoiceId,
          note: `${payStatus === 'full' ? 'تسديد' : 'دفعة جزئية'} فاتورة ${noInput.value.trim() || ''}`.trim(),
        });
      }
    } catch (err) {
      console.error('[suppliers] invoice save failed', err);
      toast('تعذّر حفظ الفاتورة', 'err');
      return;
    }

    m.close();
    onDone && onDone();
    const left = Math.round((invoiceTotal() - paid) * 100) / 100;
    toast(
      left > 0 ? `تم تسجيل الفاتورة — المتبقي للمورد ${left}` : 'تم تسجيل الفاتورة وتسديدها',
      'ok'
    );
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
