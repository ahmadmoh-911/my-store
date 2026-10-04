/**
 * Product view — read-only product details.
 *
 * This screen shows all product information in a clean, read-only format.
 * No editing is possible from this screen; an explicit "Edit" button
 * navigates to the product form.
 */
import { icon } from '../icons.js';
import {
  el, fromHTML, clear, moneyHTML, numInt, escapeHTML,
} from '../utils.js';
import { getProduct, stockOf } from '../db.js';
import { navigate } from '../router.js';
import { pageHead, emptyState, toast } from '../components.js';

export function render(params = []) {
  const id = params[0];
  const root = el('div.screen', { id: 'screen-product-view' });

  root.appendChild(
    pageHead({
      title: 'عرض المنتج',
      sub: 'تفاصيل المنتج',
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
    getProduct(id),
    (await import('../db.js')).getSettings(),
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

  const cur = settings.currency || 'ILS';
  const stock = stockOf(product);
  const sizes = getSizes(product);

  clear(host);
  host.appendChild(
    el(
      'div.view',
      {},
      /* --- header --- */
      el(
        'div.view__header',
        {},
        el(
          'div.view__media',
          {},
          product.image
            ? el('img', { src: product.image, alt: product.name, loading: 'lazy' })
            : el('div.view__media-ph', {}, fromHTML(icon('hanger'))),
        ),
        el(
          'div.view__info',
          {},
          el('h2.view__name', { text: product.name }),
          product.sku ? el('div.view__sku', { text: `SKU: ${product.sku}` }) : null,
          el('div.view__meta', { text: `التصنيف: ${product.category}` }),
          product.description ? el('div.view__desc', { text: product.description }) : null,
        )
      ),

      /* --- pricing & stock --- */
      el(
        'div.view__section',
        {},
        el('h3', { text: 'التسعير والمخزون' }),
        el(
          'div.view__grid',
          {},
          el(
            'div.view__field',
            {},
            el('span.view__label', { text: 'سعر البيع' }),
            el('b.view__value', { html: moneyHTML(product.price, settings.currency) })
          ),
          el(
            'div.view__field',
            {},
            el('span.view__label', { text: 'سعر التكلفة' }),
            el('b.view__value', { html: moneyHTML(product.costPrice, settings.currency) })
          ),
          el(
            'div.view__field',
            {},
            el('span.view__label', { text: 'إجمالي المخزون' }),
            el('b.view__value', { text: `${stock} قطعة` })
          ),
          el(
            'div.view__field',
            {},
            el('span.view__label', { text: 'المتغيرات' }),
            el('b.view__value', { text: `${product.variants?.length || 0} تركيبة` })
          ),
        )
      ),

      /* --- variants --- */
      product.variants?.length ? el(
        'div.view__section',
        {},
        el('h3', { text: 'تفاصيل المتغيرات' }),
        el(
          'table.view__variants',
          {},
          el(
            'thead',
            {},
            el('tr', {}, el('th', { text: 'المقاس' }), el('th', { text: 'اللون' }), el('th', { text: 'الكمية' }))
          ),
          el(
            'tbody',
            {},
            ...product.variants.map((v) => el(
              'tr',
              {},
              el('td', { text: v.size || '—' }),
              el('td', { text: v.color || '—' }),
              el('td', { text: `${Number(v.quantity) || 0} قطعة` })
            ))
          )
        )
      ) : null,

      /* --- description --- */
      product.description ? el(
        'div.view__section',
        {},
        el('h3', { text: 'الوصف' }),
        el('p.view__desc', { text: product.description })
      ) : null,

      /* --- actions --- */
      el(
        'div.view__actions',
        {},
        el('button.btn.btn--primary', { type: 'button', onClick: () => navigate(`product/${product.id}`) },
          fromHTML(icon('pencil')), el('span', { text: 'تعديل' })),
        el('button.btn', { type: 'button', onClick: () => navigate('products') },
          fromHTML(icon('arrowBack')), el('span', { text: 'العودة' })),
      )
    )
  );

  function getSizes(p) {
    const seen = new Set();
    const out = [];
    for (const v of p.variants || []) {
      if (v.size && !seen.has(v.size) && (Number(v.quantity) || 0) > 0) {
        seen.add(v.size);
        out.push(v.size);
      }
    }
    return out;
  }
}

export default { render };