/**
 * Raising stock, by category.
 *
 * Inventory is the one number the owner edits constantly — a delivery arrives
 * and every size in a category needs topping up. Doing that one variant at a
 * time through the product form is the slow way, so this sheet leads with the
 * category and shows its variants together.
 *
 * Writes go through db.saveProduct() per changed product, so the product form,
 * the low-stock alerts and the dashboard all see the new quantities.
 */
import { icon } from './icons.js';
import { el, fromHTML, clear, numInt } from './utils.js';
import { openSheet, toast } from './components.js';
import { saveProduct } from './db.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Groups products by category, biggest stock first inside each group. */
function byCategory(products) {
  const groups = new Map();
  for (const p of products) {
    const key = (p.category || 'غير مصنف').trim() || 'غير مصنف';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return [...groups.entries()]
    .map(([name, items]) => ({
      name,
      items,
      units: items.reduce((t, p) => t + (p.variants || []).reduce((s, v) => s + (Number(v.quantity) || 0), 0), 0),
    }))
    .sort((a, b) => b.units - a.units || a.name.localeCompare(b.name, 'ar'));
}

/**
 * @param {Object} opts { products?: Array, focusCategory?: string, onChanged?: Function }
 */
export function openStockSheet(opts = {}) {
  const products = opts.products || [];
  // Build the body here and hand it to openSheet, the way every other overlay
  // does (invoice-sheet, pos, products, dashboard). Reading `sheet.body` back
  // out cannot work: openSheet returns { close, root } and — unlike openModal —
  // it does not expose the body element, so that read was `undefined` and
  // clear(undefined) threw on the first paint.
  const body = el('div.stk');
  const sheet = openSheet({ title: 'رفع المخزون', body });

  let groups = byCategory(products);
  let openCats = new Set(opts.focusCategory ? [opts.focusCategory] : []);

  paint();
  return sheet;

  /* ---------------------------------------------------------------- */

  function paint() {
    clear(body);

    if (!groups.length) {
      body.appendChild(
        el('p.inv-warn', { text: 'لا توجد منتجات بعد. أضف منتجاً أولاً لتتمكن من رفع مخزونه.' })
      );
      return;
    }

    for (const g of groups) {
      const isOpen = openCats.has(g.name);
      body.appendChild(
        el(
          'div.stk-cat',
          {},
          el(
            'button.stk-cat__head',
            {
              type: 'button',
              'aria-expanded': isOpen ? 'true' : 'false',
              onClick: () => {
                if (isOpen) openCats.delete(g.name);
                else openCats.add(g.name);
                paint();
              },
            },
            fromHTML(icon('chevronDown')),
            el('span.stk-cat__name', { text: g.name }),
            el('span.stk-cat__n', { text: `${g.items.length} منتج · ${numInt(g.units)} قطعة` })
          ),
          isOpen ? el('div.stk-cat__body', {}, ...g.items.map(productRow)) : null
        )
      );
    }
  }

  function productRow(p) {
    const variants = p.variants || [];
    const row = el('div.stk-prod', {});

    row.appendChild(
      el(
        'div.stk-prod__head',
        {},
        p.image
          ? el('img.stk-prod__img', { src: p.image, alt: '', loading: 'lazy' })
          : el('span.stk-prod__img.stk-prod__img--none', {}, fromHTML(icon('package'))),
        el(
          'div.stk-prod__main',
          {},
          el('div.stk-prod__name.truncate', { text: p.name }),
          el('div.stk-prod__sku', { text: p.sku || '' })
        )
      )
    );

    if (!variants.length) {
      row.appendChild(el('p.inv-warn', { text: 'هذا المنتج بلا مقاسات — أضف مقاساً من صفحته.' }));
      return row;
    }

    const list = el('div.stk-vars');
    for (const v of variants) list.appendChild(variantRow(p, v));
    row.appendChild(list);
    return row;
  }

  /**
   * One variant: what it has now, and the two ways an owner thinks about a
   * delivery — "add this many" (the usual case) or "there are this many now".
   */
  function variantRow(p, v) {
    const now = Number(v.quantity) || 0;
    let mode = 'add';
    const addInput = el('input.stk-qty', { type: 'number', min: '0', step: '1', inputmode: 'numeric', value: '1', 'aria-label': 'الكمية المضافة' });
    const setInput = el('input.stk-qty', { type: 'number', min: '0', step: '1', inputmode: 'numeric', value: String(now), 'aria-label': 'الكمية الجديدة', disabled: '' });
    const readout = el('span.stk-readout', { text: `${numInt(now)} قطعة` });

    const apply = async () => {
      const raw = Number((mode === 'add' ? addInput : setInput).value) || 0;
      if (raw < 0) return;
      const next = Math.max(0, mode === 'add' ? now + Math.round(raw) : Math.round(raw));
      if (next === now) return;
      await commit(p, v, next);
    };

    const seg = el(
      'div.seg.seg--mini',
      {},
      el('button', {
        type: 'button', class: mode === 'add' ? 'is-active' : '', text: 'إضافة',
        onClick: () => { mode = 'add'; addInput.disabled = ''; setInput.disabled = 'disabled'; sync(); },
      }),
      el('button', {
        type: 'button', class: mode === 'set' ? 'is-active' : '', text: 'تعيين',
        onClick: () => { mode = 'set'; addInput.disabled = 'disabled'; setInput.disabled = ''; sync(); },
      })
    );

    const sync = () => {
      seg.querySelectorAll('button').forEach((b, i) => {
        b.classList.toggle('is-active', (i === 0) === (mode === 'add'));
      });
      if (mode === 'add') addInput.disabled = ''; else addInput.disabled = 'disabled';
      if (mode === 'set') setInput.disabled = ''; else setInput.disabled = 'disabled';
    };

    return el(
      'div.stk-var',
      {},
      el(
        'div.stk-var__label',
        {},
        el('span.stk-var__name', { text: [v.size, v.color].filter(Boolean).join(' · ') || 'بدون مقاس' }),
        readout
      ),
      el(
        'div.stk-var__ctrl',
        {},
        seg,
        addInput,
        setInput,
        el('button.btn.btn--soft.btn--sm', { type: 'button', onClick: apply }, fromHTML(icon('plus')), el('span', { text: 'رفع' }))
      )
    );
  }

  /** Writes one variant's new quantity and refreshes everything behind it. */
  async function commit(p, v, next) {
    // clone first: saveProduct stamps updatedAt, and mutating the object the
    // dashboard is holding would make its numbers shift under the owner
    const i = (p.variants || []).indexOf(v);
    const copy = {
      ...p,
      variants: (p.variants || []).map((x) => (x === v || x === p.variants[i] ? { ...x, quantity: next } : x)),
    };
    try {
      await saveProduct(copy);
    } catch (err) {
      console.error('[stock] save failed', err);
      toast('تعذّر حفظ الكمية', 'err');
      return;
    }
    // keep the in-memory product in step so a second edit on the same row adds
    // to the quantity that was actually stored
    p.variants[i] = { ...v, quantity: next };
    v.quantity = next;

    const g = groups.find((x) => x.name === (p.category || 'غير مصنف'));
    if (g) g.units = g.items.reduce((t, q) => t + (q.variants || []).reduce((s, vv) => s + (Number(vv.quantity) || 0), 0), 0);
    paint();
    opts.onChanged && opts.onChanged();
  }
}

export default { openStockSheet };
