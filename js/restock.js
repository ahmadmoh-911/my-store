/**
 * "تجديد الكمية" — restocking.
 *
 * This is the ONLY path in the app that puts stock back on the shelf. It is
 * deliberately a purchase, not an edit: the owner says what arrived, from
 * whom, at what price and on what date, and in the same breath the store
 * balance is debited by the order total (see db.storeLedger). That is the
 * difference between a delivery and a supplier bill you type in afterwards
 * (suppliers.js), which records money owed and touches nothing in stock.
 *
 * Quantities are written to the EXACT size + colour variant named in the row.
 * A restock never folds into a neighbouring size, and a product with no size
 * or colour breakdown works exactly the same — it simply has one variant.
 */
import { icon } from './icons.js';
import { el, fromHTML, clear, numInt, moneyHTML, isoDate, sum } from './utils.js';
import { openSheet, emptyState, toast, celebrate } from './components.js';
import {
  listSuppliers, saveSupplier, createPurchase, listProducts, stockOf,
} from './db.js';

/** The rows the sheet edits: one per existing variant, or a single blank one. */
function variantRows(product) {
  const vars = product.variants || [];
  if (vars.length) {
    return vars.map((v) => ({
      size: v.size || '',
      color: v.color || '',
      current: Number(v.quantity) || 0,
      qty: 0,
    }));
  }
  // A product saved without a size/colour grid still needs somewhere to put the
  // new quantity — one nameless variant is the honest representation.
  return [{ size: '', color: '', current: 0, qty: 0 }];
}

const label = (size, color) =>
  [size || 'مقاس واحد', color || 'بدون لون'].filter(Boolean).join(' · ');

const money = (n) => moneyHTML(n, 'ILS');

/**
 * Opens the restock sheet for one product.
 *
 * @param {object} product
 * @param {{onDone?: Function}} [opts]
 */
export function openRestockSheet(product, { onDone } = {}) {
  if (!product) return;

  const rows = variantRows(product);
  const state = {
    unitCost: Number(product.costPrice) || 0,
    newPrice: '',
    date: isoDate(new Date()),
    supplierId: '',
    newSupplierName: '',
    newSupplierPhone: '',
    addingSupplier: false,
  };

  const totalHost = el('div.restock__total');
  let suppliers = [];
  let confirmBtn = null;

  /* --- body --------------------------------------------------------- */

  const variantHost = el('div.restock__variants');
  function paintVariants() {
    clear(variantHost);
    rows.forEach((r, i) => {
      const input = el('input.input.qty-input', {
        type: 'number',
        min: '0',
        step: '1',
        inputmode: 'numeric',
        placeholder: '0',
        value: r.qty ? String(r.qty) : '',
        'aria-label': `كمية ${label(r.size, r.color)}`,
        oninput: (e) => {
          const v = parseInt(e.target.value || '0', 10);
          rows[i].qty = Number.isFinite(v) && v > 0 ? v : 0;
          paintTotal();
        },
      });
      variantHost.appendChild(
        el(
          'div.restock__row',
          {},
          el(
            'div.restock__rowmain',
            {},
            el(
              'div.restock__rowname',
              {},
              r.size ? el('span.size-pill', { style: 'height:21px;min-width:auto;font-size:10.5px', text: r.size }) : null,
              r.color ? el('span', { text: r.color }) : null,
              !r.size && !r.color ? el('span', { text: 'بدون مقاس أو لون' }) : null
            ),
            el('div.restock__rowmeta', { text: `المتاح حالياً: ${r.current}` })
          ),
          input
        )
      );
    });
  }

  /* --- supplier ------------------------------------------------------ */

  const supplierHost = el('div.opt-wrap');
  function paintSuppliers() {
    clear(supplierHost);
    const chip = (on, text, click) =>
      el(`button.opt${on ? '.is-on' : ''}`, { type: 'button', onClick: click, text });

    supplierHost.appendChild(
      chip(!state.addingSupplier && !state.supplierId, 'بدون مورد', () => {
        state.supplierId = '';
        state.addingSupplier = false;
        paintSuppliers();
        paintNewSupplier();
      })
    );
    suppliers.forEach((s) =>
      supplierHost.appendChild(
        chip(!state.addingSupplier && state.supplierId === s.id, s.name, () => {
          state.supplierId = s.id;
          state.addingSupplier = false;
          paintSuppliers();
          paintNewSupplier();
        })
      )
    );
    supplierHost.appendChild(
      chip(state.addingSupplier, '+ مورد جديد', () => {
        state.addingSupplier = true;
        state.supplierId = '';
        paintSuppliers();
        paintNewSupplier();
      })
    );
  }

  const newSupplierBox = el('div.restock__newsupplier');
  function paintNewSupplier() {
    clear(newSupplierBox);
    newSupplierBox.hidden = !state.addingSupplier;
    if (!state.addingSupplier) return;
    newSupplierBox.appendChild(
      el(
        'div.grid-2',
        {},
        el(
          'div.field',
          {},
          el('label.field__label', { text: 'اسم المورد' }),
          el('input.input', {
            type: 'text',
            placeholder: 'مثال: مستودع النور',
            value: state.newSupplierName,
            oninput: (e) => (state.newSupplierName = e.target.value),
          })
        ),
        el(
          'div.field',
          {},
          el('label.field__label', { text: 'الهاتف (اختياري)' }),
          el('input.input', { type: 'tel', dir: 'ltr', placeholder: '0599…', value: state.newSupplierPhone,
            oninput: (e) => (state.newSupplierPhone = e.target.value) })
        )
      )
    );
  }

  /* --- totals -------------------------------------------------------- */

  function units() {
    return sum(rows, (r) => r.qty);
  }

  function paintTotal() {
    const u = units();
    const total = Math.round(state.unitCost * u * 100) / 100;
    clear(totalHost);
    totalHost.appendChild(
      el(
        'div.restock__totalline',
        {},
        el('span', { text: `${numInt(u)} قطعة × ${money(state.unitCost)}` }),
        el('b', { html: money(total) })
      )
    );
    if (confirmBtn) confirmBtn.disabled = u <= 0;
  }

  /* --- assemble ------------------------------------------------------ */

  const body = el(
    'div.restock',
    {},
    el(
      'div.restock__head',
      {},
      product.image
        ? el('img.thumb.thumb--lg', { src: product.image, alt: '' })
        : el('div.thumb.thumb--lg.thumb-ph', { html: icon('hanger') }),
      el(
        'div',
        { style: 'min-width:0' },
        el('b', { style: 'font-size:16px;display:block', text: product.name }),
        el('span.tiny.muted', {
          html: `المخزون الحالي: ${numInt(stockOf(product))} قطعة · سعر البيع ${money(product.price)}`,
        })
      )
    ),

    el(
      'div.field',
      {},
      el('label.field__label', { text: 'المقاس / اللون المطلوب تجديده' }),
      variantHost
    ),

    el(
      'div.grid-2',
      {},
      el(
        'div.field',
        {},
        el('label.field__label', { text: 'سعر شراء القطعة' }),
        el('input.input.input--money', {
          type: 'number',
          min: '0',
          step: '0.5',
          inputmode: 'decimal',
          value: state.unitCost || '',
          oninput: (e) => {
            const v = parseFloat(e.target.value);
            state.unitCost = Number.isFinite(v) && v >= 0 ? v : 0;
            paintTotal();
          },
        })
      ),
      el(
        'div.field',
        {},
        el('label.field__label', { text: 'سعر بيع جديد (اختياري)' }),
        el('input.input.input--money', {
          type: 'number',
          min: '0',
          step: '0.5',
          inputmode: 'decimal',
          placeholder: 'اتركه فارغاً للإبقاء',
          value: state.newPrice,
          oninput: (e) => (state.newPrice = e.target.value),
        })
      )
    ),

    el(
      'div.field',
      {},
      el('label.field__label', { text: 'المورد' }),
      supplierHost,
      newSupplierBox
    ),

    el(
      'div.field',
      {},
      el('label.field__label', { text: 'تاريخ الشراء' }),
      el('input.input', {
        type: 'date',
        value: state.date,
        oninput: (e) => (state.date = e.target.value || state.date),
      })
    ),

    totalHost,
    el('p.tiny.muted', {
      style: 'margin-top:10px',
      text: 'خصم قيمة الطلب من رصيد المتجر. تسجيل فاتورة المورد من شاشة الموردين لا يغيّر المخزون.',
    })
  );

  confirmBtn = el('button.btn.btn--primary.btn--block.btn--lg', {
    type: 'button',
    text: 'تأكيد وإضافة للمخزون',
    onClick: commit,
  });

  const sheet = openSheet({
    title: 'تجديد الكمية',
    body,
    foot: confirmBtn,
    onClose: () => document.body.removeEventListener('keydown', onEnter),
  });

  function onEnter(e) {
    if (e.key === 'Enter' && !confirmBtn.disabled && e.target.tagName === 'INPUT') {
      e.preventDefault();
      commit();
    }
  }
  document.body.addEventListener('keydown', onEnter);

  /* --- commit --------------------------------------------------------- */

  let busy = false;
  async function commit() {
    if (busy) return;
    const lines = rows.filter((r) => r.qty > 0).map((r) => ({ size: r.size, color: r.color, qty: r.qty }));
    if (!lines.length) {
      toast('اكتب الكمية أولاً', 'warn');
      return;
    }

    if (state.addingSupplier && !state.newSupplierName.trim()) {
      toast('اكتب اسم المورد', 'warn');
      return;
    }

    busy = true;
    const label0 = confirmBtn.textContent;
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'جارٍ الحفظ…';

    try {
      let supplierId = state.supplierId;
      let supplierName = '';
      if (state.addingSupplier) {
        // saveSupplier resolves with the record's key, not the record itself.
        supplierId = await saveSupplier({
          name: state.newSupplierName.trim(),
          phone: state.newSupplierPhone.trim(),
        });
        supplierName = state.newSupplierName.trim();
        suppliers.push({ id: supplierId, name: supplierName });
      } else {
        supplierName = suppliers.find((s) => s.id === supplierId)?.name || '';
      }

      const { record } = await createPurchase({
        productId: product.id,
        productName: product.name,
        supplierId,
        supplierName,
        date: state.date ? new Date(`${state.date}T12:00:00`).toISOString() : new Date().toISOString(),
        unitCost: state.unitCost,
        newPrice: state.newPrice === '' ? null : state.newPrice,
        lines,
      });

      sheet.close();
      celebrate({
        title: 'تم تجديد الكمية',
        sub: `${numInt(record.units)} قطعة · ${money(record.total)}`,
        confetti: false,
        ms: 1100,
      }).then(() => {
        toast(`أُضيف ${numInt(record.units)} قطعة إلى «${product.name}»`, 'ok');
        onDone && onDone(record);
      });
    } catch (err) {
      console.error('[restock] failed:', err);
      toast('تعذّر حفظ التجديد: ' + (err.message || err), 'err');
      busy = false;
      confirmBtn.disabled = false;
      confirmBtn.textContent = label0;
    }
  }

  // suppliers are fetched once, before the first paint of the picker
  listSuppliers().then((rowsIn) => {
    suppliers = rowsIn.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ar'));
    paintSuppliers();
  });
  paintSuppliers();
  paintNewSupplier();
  paintVariants();
  paintTotal();
}

/**
 * Product chooser used by the dashboard's "تجديد الكمية" shortcut: pick the
 * product first, then straight into the same sheet.
 */
export function openRestockPicker({ onDone } = {}) {
  const listHost = el('div.restock__list');

  const search = el('input.input', {
    type: 'search',
    placeholder: 'ابحث عن منتج…',
    oninput: () => paint(),
  });

  const sheet = openSheet({
    title: 'اختر منتجاً لتجديد كميته',
    body: el('div', {}, el('div.search', {}, fromHTML(icon('search')), search), el('div', { style: 'height:12px' }), listHost),
  });

  function paint() {
    const q = search.value.trim().toLowerCase();
    clear(listHost);
    listHost.appendChild(el('div.loading-row', {}, el('i.spinner.spinner--ink'), el('span', { text: 'جارٍ التحميل…' })));

    listProducts().then((products) => {
      if (!listHost.isConnected) return;
      clear(listHost);
      const rows = products.filter(
        (p) => !q || [p.name, p.sku, p.category].some((v) => v && String(v).toLowerCase().includes(q))
      );
      if (!rows.length) {
        listHost.appendChild(
          emptyState({
            iconName: 'package',
            title: q ? 'لا نتائج' : 'لا توجد منتجات بعد',
            text: q ? 'جرّب اسماً آخر.' : 'أضف منتجات من شاشة المخزن أولاً.',
            small: true,
          })
        );
        return;
      }
      rows.forEach((p) => {
        const stock = stockOf(p);
        listHost.appendChild(
          el(
            'button.restock__pick',
            { type: 'button', onClick: () => { sheet.close(); openRestockSheet(p, { onDone }); } },
            p.image
              ? el('img.restock__pickimg', { src: p.image, alt: '', loading: 'lazy' })
              : el('span.restock__pickimg.restock__pickimg--none', { html: icon('hanger') }),
            el(
              'div.restock__pickmain',
              {},
              el('b.truncate', { text: p.name }),
              el('span.tiny.muted', { html: `${stock} قطعة · ${money(p.price)}` })
            ),
            el('span.size-pill', { style: 'height:24px;min-width:auto', text: 'تجديد' })
          )
        );
      });
    });
  }

  paint();
}