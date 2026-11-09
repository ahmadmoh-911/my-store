/**
 * Product view — read-only product details.
 *
 * Tapping a product in Inventory opens WHAT THE PIECE IS: image, name,
 * category, prices, stock status and the size/colour/quantity table. There is
 * deliberately nothing to type into here and no save button — every change
 * belongs to the product form, which the explicit "تعديل" button opens.
 *
 * The styling reuses the app's existing building blocks (form-section, matrix,
 * badge, thumb) — this screen's old `view__*` classes had no CSS anywhere, so
 * the sections rendered as an unstyled jumble.
 *
 * Route: `#/product/<id>/view` (see router.js order 2.5).
 */
import { icon } from '../icons.js';
import {
  el, fromHTML, clear, moneyHTML, escapeHTML, numInt,
} from '../utils.js';
import { get, getSettings, stockOf, STORES } from '../db.js';
import { navigate } from '../router.js';
import { pageHead, emptyState } from '../components.js';

export function render(params = []) {
  const id = params[0];
  const root = el('div.screen', { id: 'screen-product-view' });

  root.appendChild(
    pageHead({
      title: 'عرض المنتج',
      sub: 'تفاصيل القطعة — للتعديل استخدم زر «تعديل»',
      back: () => history.length > 1 ? history.back() : navigate('products'),
    })
  );

  const host = el('div', { id: 'view-host' });
  root.appendChild(host);
  host.appendChild(el('div.loading-row', {}, el('i.spinner.spinner--ink'), el('span', { text: 'جارٍ تحميل المنتج…' })));

  boot(host, id);
  return root;
}

async function boot(host, id) {
  const [product, settings] = await Promise.all([
    get(STORES.products, id),
    getSettings(),
  ]);

  if (!host.isConnected) return;

  if (!product) {
    clear(host);
    host.appendChild(
      emptyState({
        iconName: 'alert',
        title: 'المنتج غير موجود',
        text: 'ربما تم حذفه من جهاز آخر.',
        action: el('button.btn.btn--primary', { type: 'button', onClick: () => navigate('products') }, 'العودة للمنتجات'),
      })
    );
    return;
  }

  const stock = stockOf(product);
  const threshold = Number(settings.lowStockThreshold) || 5;
  // Same three-band status the inventory cards use — one definition of
  // "low", not a second competing one.
  const status = stock === 0
    ? { cls: 'badge--out', label: 'نفدت الكمية' }
    : stock <= threshold
      ? { cls: 'badge--low', label: `منخفض — تبقّى ${stock}` }
      : { cls: 'badge--ok', label: 'متوفر' };

  const variants = product.variants || [];
  const sizes = [...new Set(variants.map((v) => v.size).filter(Boolean))];
  const totalVariants = variants.reduce((t, v) => t + (Number(v.quantity) || 0), 0);

  clear(host);

  /* --- header: image, name, category, status ------------------------- */
  host.appendChild(
    el(
      'div.card',
      { style: 'display:flex;gap:13px;align-items:flex-start;padding:14px;margin-bottom:13px' },
      product.image
        ? el('img.thumb.thumb--lg', { src: product.image, alt: product.name, style: 'flex:none' })
        : el('div.thumb.thumb--lg.thumb-ph', { style: 'flex:none' }, fromHTML(icon('hanger'))),
      el(
        'div',
        { style: 'min-width:0;flex:1' },
        el('h2', { style: 'margin:0 0 6px;font-size:18px', text: product.name }),
        el(
          'div',
          { style: 'display:flex;gap:6px;flex-wrap:wrap;align-items:center' },
          el('span.badge.badge--brass', { text: product.category || 'غير مصنف' }),
          el('span', { class: `badge ${status.cls}`, text: status.label })
        ),
        product.sku
          ? el('div.tiny.muted', { style: 'margin-top:7px;direction:ltr;text-align:end', text: `SKU: ${product.sku}` })
          : null
      )
    )
  );

  /* --- pricing & stock summary --------------------------------------- */
  host.appendChild(
    el(
      'section.form-section',
      {},
      el('div.form-section__head', {}, el('span.form-section__num', { text: '1' }), el('h3', { text: 'السعر والمخزون' })),
      el(
        'div.grid-2',
        { style: 'padding:0 4px 6px' },
        priceField('سعر البيع', moneyHTML(product.price, settings.currency)),
        priceField('سعر التكلفة', moneyHTML(product.costPrice, settings.currency)),
        priceField('إجمالي المخزون', `${numInt(stock)} قطعة`),
        priceField('عدد التركيبات', `${variants.length} تركيبة`),
      ),
      totalVariants !== stock
        ? el('div.tiny', { style: 'padding:0 4px;color:var(--danger)', text: 'تنبيه: مجموع الكميات في الجدول لا يطابق الإجمالي — أعد حفظ الكميات من نموذج التعديل.' })
        : null
    )
  );

  /* --- sizes × colours × quantities (read-only table) ----------------- */
  host.appendChild(
    el(
      'section.form-section',
      {},
      el(
        'div.form-section__head',
        {},
        el('span.form-section__num', { text: '2' }),
        el('h3', { text: 'المقاسات والألوان والكميات' }),
        sizes.length ? el('span.tiny.muted', { text: sizes.join(' · ') }) : null
      ),
      variants.length
        ? el('div.matrix-wrap', {}, variantsTable(variants, settings))
        : el('p.tiny.muted', { style: 'padding:0 4px', text: 'لا توجد تركيبات مسجّلة — أضف مقاسات وكميات من نموذج التعديل.' })
    )
  );

  /* --- description ---------------------------------------------------- */
  if (product.description) {
    host.appendChild(
      el(
        'section.form-section',
        {},
        el('div.form-section__head', {}, el('span.form-section__num', { text: '3' }), el('h3', { text: 'الوصف' })),
        el('p', { style: 'margin:0;padding:0 4px;line-height:1.7;white-space:pre-wrap', text: product.description })
      )
    );
  }

  /* --- actions: edit goes to the form; nothing here saves ------------- */
  host.appendChild(
    el(
      'div.form-actions',
      {},
      el('button.btn.btn--primary.btn--lg', {
        type: 'button',
        onClick: () => navigate(`product/${product.id}`),
      }, fromHTML(icon('pencil')), el('span', { text: 'تعديل' })),
      el('button.btn.btn--lg', {
        type: 'button',
        onClick: () => history.length > 1 ? history.back() : navigate('products'),
      }, fromHTML(icon('arrowBack')), el('span', { text: 'عودة' }))
    )
  );

  function priceField(label, valueHTML) {
    return el(
      'div.field',
      { style: 'margin:0' },
      el('span.field__label', { text: label }),
      el('b', { style: 'font-size:16px', html: valueHTML })
    );
  }

  function variantsTable(rows, set) {
    const table = el('table.matrix');
    table.appendChild(
      el('thead', {}, el('tr', {},
        el('th', { text: 'المقاس' }),
        el('th', { text: 'اللون' }),
        el('th', { text: 'الكمية' }),
        el('th', { text: 'الحالة' })))
    );
    const tbody = el('tbody');
    for (const v of rows) {
      const qty = Number(v.quantity) || 0;
      const name = v.color || '';
      const def = (set.colors || []).find((c) => c.name === name);
      const rowState = qty === 0
        ? { label: 'نفدت', style: 'color:var(--danger)' }
        : qty <= threshold
          ? { label: 'منخفض', style: 'color:var(--warning)' }
          : { label: 'متوفر', style: 'color:var(--success)' };
      tbody.appendChild(
        el(
          'tr',
          qty === 0 ? { style: 'opacity:.55' } : {},
          el('th', { text: v.size || '—' }),
          el('td', {},
            el('span', { style: 'display:inline-flex;gap:6px;align-items:center' },
              el('i.swatch', { style: `background:${def ? def.hex : '#e7ded1'};width:15px;height:15px` }),
              el('span', { text: name || 'بدون لون' }))),
          el('td', { text: String(qty) }),
          el('td', {}, el('span.tiny', { style: rowState.style, text: rowState.label }))
        )
      );
    }
    table.appendChild(tbody);
    table.appendChild(
      el('tfoot', {}, el('tr', {},
        el('th', { text: 'الإجمالي' }),
        el('td'),
        el('td', { text: String(stock) }),
        el('td')))
    );
    return table;
  }
}

export default { render };
