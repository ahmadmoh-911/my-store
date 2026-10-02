/**
 * Sales / POS — pick products and put them in the cart.
 *
 * That is all this screen does now. It used to own the cart as well: a
 * "الطلب الحالي" column beside the grid, carrying its own copy of the line
 * list, its own totals, its own discount box, its own payment buttons and its
 * own checkout button. Two copies of one invoice is two numbers to keep in step
 * and, eventually, two different answers to "what does this cost".
 *
 * So the column is gone. The cart panel (cart-bar.js) is the single place the
 * current order exists — pieces, size, colour, quantity, unit price, line
 * total, discount, payment method and the button that finishes the sale — and
 * the basket itself lives in ../cart-store.js, which this screen writes to and
 * the panel reads from. The shared `addLine()` is what puts a piece in, so the
 * quantity and price rules are enforced in one place.
 *
 * Stock is decremented atomically by `createSale()` in db.js, once the owner has
 * confirmed the sale in the panel.
 *
 * Route: `#/pos` or `#/pos/<productId>` (the latter pre-loads one product —
 * used by the quick "+" button on product cards).
 */
import { icon } from '../icons.js';
import {
  el, fromHTML, clear, escapeHTML, numInt, moneyHTML,
  flyTo, debounce,
} from '../utils.js';
import {
  listProducts, getSettings,
  stockOf, availableVariants, variantStock,
} from '../db.js';
import { emptyState, openSheet, toast } from '../components.js';
import { scanBarcode, reportMissing } from '../scanner.js';
import { navigate } from '../router.js';
import { addLine, totalItems, subscribe } from '../cart-store.js';

let query = '';
let category = 'all';

/** Store subscriptions owned by mounted POS screens, released in destroy(). */
const activeScreens = [];

export function render(params = []) {
  const root = el('div.screen', { id: 'screen-pos' });

  // POS is sale-only. Sale history belongs to Reports, and registering a
  // product belongs to Inventory — both were shortcuts here that could only
  // take the owner out of the sale they were in the middle of.
  const head = el(
    'div.page-head',
    {},
    el(
      'div.page-head__text',
      {},
      el('h1.page-title', {}, el('span', { text: 'نقطة البيع' }), el('span.badge.badge--primary', { id: 'pos-count', text: 'سلة فارغة' })),
      el('p.page-sub', { text: 'اضغط على المنتج لإضافته إلى السلة' })
    )
  );
  root.appendChild(head);

  const scanBtn = el(
    'button.pill-btn.pill-btn--scan',
    { type: 'button', id: 'pos-scan', onClick: () => handleScan() },
    fromHTML(icon('barcode')),
    el('span', { text: 'مسح' })
  );

  const left = el(
    'div',
    {},
    el(
      'div.pos__searchrow',
      {},
      el(
        'div.search',
        {},
        fromHTML(icon('search')),
        el('input', {
          id: 'pos-search',
          type: 'search',
          placeholder: 'ابحث بالاسم أو الرمز…',
          oninput: debounce((e) => {
            query = e.target.value.trim();
            paintProducts();
          }, 140),
        })
      ),
      scanBtn
    ),
    el('div.chip-row', { id: 'pos-cats', style: 'margin-bottom:13px' }),
    el('div', { id: 'pos-products' })
  );

  root.appendChild(el('div.pos', {}, left));

  // The badge is the only cart affordance this screen keeps: a piece count, so
  // the owner can tell at a glance that a tap registered. It deliberately does
  // NOT open the cart — the panel does that, from the topbar button and from the
  // bar at the bottom, and a second opener would just be another way for the two
  // views to disagree about what is in the invoice.
  const stopWatching = subscribe(() => {
    const badge = document.getElementById('pos-count');
    if (!badge) return;
    const n = totalItems();
    badge.textContent = n ? `${n} قطعة` : 'السلة فارغة';
    badge.classList.toggle('is-live', n > 0);
  });

  paintProducts(root);
  // The router only appends the screen to #view *after* render() returns, so the
  // badge is not in the document yet. One frame later the screen is mounted, so
  // paint the count now rather than showing "السلة فارغة" for a cart that is
  // not.
  requestAnimationFrame(() => {
    const badge = document.getElementById('pos-count');
    if (badge) {
      const n = totalItems();
      badge.textContent = n ? `${n} قطعة` : 'السلة فارغة';
      badge.classList.toggle('is-live', n > 0);
    }
  });
  activeScreens.push(stopWatching);

  // pre-select a product when arriving from a product card
  if (params[0]) {
    listProducts().then((products) => {
      const p = products.find((x) => x.id === params[0]);
      if (p) pickProduct(p);
      navigate('pos', { replace: true });
    });
  }

  return root;
}

/* ------------------------------------------------------------------ *
 * Product picker (left column)
 * ------------------------------------------------------------------ */

let cache = { products: [], settings: null };
let cacheReady = null;

/**
 * Loads (and memoises) the products + settings this screen needs.
 * Anything that touches `cache` from a click handler must go through this —
 * `paintProducts()` is async, so a fast tap on a product card (or the
 * `#/pos/<id>` pre-select) can run before the first load has resolved.
 */
function ensureCache() {
  if (cache.settings) return Promise.resolve(cache);
  if (!cacheReady) {
    cacheReady = Promise.all([listProducts(), getSettings()]).then(([products, settings]) => {
      cache = { products, settings };
      cacheReady = null;
      return cache;
    });
  }
  return cacheReady;
}

function invalidateCache() {
  cache = { products: [], settings: null };
  cacheReady = null;
}

async function paintProducts(screenRoot) {
  const root = screenRoot || document.getElementById('screen-pos');
  const host = root?.querySelector('#pos-products');
  const catsHost = root?.querySelector('#pos-cats');
  if (!host || !catsHost) return;

  if (!cache.settings) {
    clear(host);
    host.appendChild(el('div.loading-row', {}, el('i.spinner.spinner--ink'), el('span', { text: 'جارٍ تحميل المنتجات…' })));
    await ensureCache();
    if (!host.isConnected) return;
  }

  // category chips
  clear(catsHost);
  const cats = ['all', ...new Set(cache.products.map((p) => p.category))];
  cats.forEach((c) => {
    catsHost.appendChild(
      el(
        `button.chip${category === c ? '.is-active' : ''}`,
        { type: 'button', onClick: () => { category = c; paintProducts(); } },
        el('span', { text: c === 'all' ? 'الكل' : c })
      )
    );
  });

  const q = query.toLowerCase();
  const list = cache.products.filter((p) => {
    if (category !== 'all' && p.category !== category) return false;
    if (!q) return true;
    return [p.name, p.sku, p.category].some((v) => v && String(v).toLowerCase().includes(q));
  });

  clear(host);

  if (!cache.products.length) {
    host.appendChild(
      emptyState({
        iconName: 'hanger',
        title: 'لا توجد منتجات للبيع',
        text: 'سجّل منتجاتك من شاشة المخزن لتتمكن من إجراء المبيعات.',
      })
    );
    return;
  }

  if (!list.length) {
    host.appendChild(emptyState({ iconName: 'search', title: 'لا نتائج', text: 'جرّب رمزاً أو اسماً آخر.', small: true }));
    return;
  }

  const grid = el('div.pos-grid');
  list.forEach((p, i) => {
    const stock = stockOf(p);
    const sizes = [...new Set(availableVariants(p).map((v) => v.size))].filter(Boolean);

    // The card opens a read-only detail sheet; the button on it is the quick
    // path straight into the variant picker.
    grid.appendChild(
      el(
        'div.pos-item',
        {
          role: 'button',
          tabindex: '0',
          style: `animation-delay:${Math.min(i * 28, 240)}ms`,
          onClick: () => openProductSheet(p),
          onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && openProductSheet(p),
        },
        el(
          'div.pos-item__media',
          {},
          p.image
            ? el('img', { src: p.image, alt: '', loading: 'lazy' })
            : el('div.thumb-ph', { style: 'position:absolute;inset:0' }, fromHTML(icon('hanger'))),
          stock > 0 && stock <= (Number(cache.settings.lowStockThreshold) || 5)
            ? el('span.badge.badge--low', { style: 'position:absolute;top:7px;inset-inline-start:7px', text: `${stock} فقط` })
            : null
        ),
        el(
          'div.pos-item__body',
          {},
          el('div.pos-item__name', { text: p.name }),
          el('div.pos-item__sizes', { text: sizes.length ? `المقاسات: ${sizes.join(' · ')}` : stock === 0 ? 'نفدت الكمية' : 'مقاس واحد' }),
          el(
            'div.pos-item__foot',
            {},
            el('span.pos-item__price', { html: `${numInt(p.price)}<small style="font-size:10px;color:var(--ink-3)"> ${escapeHTML(cache.settings.currency)}</small>` })
          ),
          stock === 0
            ? el('div.pos-item__add.is-off', {}, fromHTML(icon('x')), el('span', { text: 'نفدت الكمية' }))
            : el(
                'button.pos-item__add',
                {
                  type: 'button',
                  onClick: (e) => {
                    e.stopPropagation();
                    pickProduct(p);
                  },
                },
                fromHTML(icon('cart')),
                el('span', { text: 'أضف إلى السلة' })
              )
        )
      )
    );
  });

  host.appendChild(grid);
}

/* ------------------------------------------------------------------ *
 * Read-only product details
 *
 * Tapping a POS card opens what the piece IS — name, image, price, sizes,
 * colours and the quantity of each variant — and lets the owner put it in the
 * basket. There is deliberately no field to type into here: prices, stock and
 * variants are edited in Inventory, never while a sale is open.
 * ------------------------------------------------------------------ */
function openProductSheet(p) {
  const cur = cache.settings?.currency || 'ILS';
  const groups = new Map(); // size → variants
  for (const v of p.variants || []) {
    const s = v.size || '—';
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(v);
  }

  let chosenSize = [...groups.keys()][0];
  let chosenColor = groups.get(chosenSize)?.[0]?.color || '—';

  const sizesHost = el('div.opt-wrap');
  const colorsHost = el('div.opt-wrap');
  const stockHost = el('div.pos-item__stock');

  function paintSizes() {
    clear(sizesHost);
    for (const s of groups.keys()) {
      sizesHost.appendChild(
        el(`button.opt${chosenSize === s ? '.is-on' : ''}`, {
          type: 'button',
          text: s === '—' ? 'مقاس واحد' : s,
          onClick: () => {
            chosenSize = s;
            chosenColor = groups.get(s)[0].color || '—';
            paintSizes();
            paintColors();
            paintStock();
          },
        })
      );
    }
  }

  function paintColors() {
    clear(colorsHost);
    const list = groups.get(chosenSize) || [];
    if (list.length <= 1) {
      colorsHost.appendChild(el('span.tiny.muted', { text: 'بدون ألوان متعددة' }));
      return;
    }
    for (const v of list) {
      const name = v.color || '—';
      const cdef = (cache.settings.colors || []).find((c) => c.name === name);
      colorsHost.appendChild(
        el(`button.opt${chosenColor === name ? '.is-on' : ''}`, {
          type: 'button',
          onClick: () => { chosenColor = name; paintColors(); paintStock(); },
        },
          cdef ? el('i.swatch', { style: `background:${cdef.hex};width:15px;height:15px` }) : null,
          el('span', { text: name }),
          el('span.tiny', { style: 'opacity:.7', text: `${Number(v.quantity) || 0} متاح` })
        )
      );
    }
  }

  function chosenVariant() {
    return (groups.get(chosenSize) || []).find((x) => (x.color || '—') === chosenColor) || null;
  }

  function paintStock() {
    const v = chosenVariant();
    const n = v ? Number(v.quantity) || 0 : 0;
    clear(stockHost);
    stockHost.appendChild(
      el(
        'div.pos-item__stockrow',
        {},
        el('span', { text: [v?.size || 'مقاس واحد', v?.color || 'بدون لون'].join(' · ') }),
        el('span', { class: n > 0 ? 'pos-item__stock--ok' : 'pos-item__stock--out', text: n > 0 ? `${n} قطعة متاحة` : 'غير متوفر — اختر آخر' })
      )
    );
    if (addBtn) addBtn.disabled = n <= 0;
  }

  const addBtn = el('button.btn.btn--primary.btn--block.btn--lg', { type: 'button', text: 'أضف إلى السلة' });

  const body = el(
    'div',
    {},
    el(
      'div',
      { style: 'display:flex;gap:13px;align-items:center;margin-bottom:16px' },
      p.image
        ? el('img.thumb.thumb--lg', { src: p.image, alt: '' })
        : el('div.thumb.thumb--lg.thumb-ph', {}, fromHTML(icon('hanger'))),
      el(
        'div',
        { style: 'min-width:0' },
        el('b', { style: 'font-size:17px;display:block', text: p.name }),
        el('span.tiny.muted', { html: `${moneyHTML(p.price, cur)} · ${escapeHTML(p.category || '')}` })
      )
    ),
    el('div.field', {}, el('label.field__label', { text: 'المقاس' }), sizesHost),
    el('div.field', {}, el('label.field__label', { text: 'اللون' }), colorsHost),
    stockHost,
    el('p.tiny.muted', { style: 'margin-top:14px', text: 'تفاصيل فقط — تعديل الأسعار والمقاسات من شاشة المخزن.' })
  );

  paintSizes();
  paintColors();
  paintStock();

  const sheet = openSheet({ title: 'تفاصيل المنتج', body, foot: addBtn });

  addBtn.addEventListener('click', () => {
    const v = chosenVariant();
    if (!v || (Number(v.quantity) || 0) <= 0) return;
    sheet.close();
    addItem(p, v);
  });
}

/* ------------------------------------------------------------------ *
 * Adding to cart
 * ------------------------------------------------------------------ */

async function pickProduct(p) {
  await ensureCache();
  const variants = availableVariants(p);
  if (!variants.length) {
    toast('هذه القطعة نافدة من المخزون', 'warn');
    return;
  }
  if (variants.length === 1) {
    addItem(p, variants[0]);
    return;
  }
  openVariantPicker(p, variants);
}

function openVariantPicker(p, variants) {
  const cur = cache.settings?.currency || 'ILS';
  const groups = new Map(); // size → variants
  for (const v of variants) {
    const s = v.size || '—';
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(v);
  }

  let chosenSize = [...groups.keys()][0];
  let chosenColor = groups.get(chosenSize)[0].color || '—';

  const body = el(
    'div',
    {},
    el(
      'div',
      { style: 'display:flex;gap:12px;align-items:center;margin-bottom:16px' },
      p.image
        ? el('img.thumb.thumb--lg', { src: p.image, alt: '' })
        : el('div.thumb.thumb--lg.thumb-ph', {}, fromHTML(icon('hanger'))),
      el(
        'div',
        { style: 'min-width:0' },
        el('b', { style: 'font-size:16px;display:block', text: p.name }),
        el('span.tiny.muted', { html: `${moneyHTML(p.price, cur)} · ${p.category}` })
      )
    ),
    el('div.field', {}, el('label.field__label', { text: 'المقاس' }), el('div.opt-wrap', { id: 'vp-sizes' })),
    el('div.field', {}, el('label.field__label', { text: 'اللون' }), el('div.opt-wrap', { id: 'vp-colors' })),
    el('div', { id: 'vp-stock', style: 'margin-top:4px' })
  );

  function paintSizes() {
    const host = body.querySelector('#vp-sizes');
    clear(host);
    for (const s of groups.keys()) {
      host.appendChild(
        el(`button.opt${chosenSize === s ? '.is-on' : ''}`, {
          type: 'button',
          text: s,
          onClick: () => {
            chosenSize = s;
            chosenColor = groups.get(s)[0].color || '—';
            paintSizes();
            paintColors();
            paintStock();
          },
        })
      );
    }
  }

  function paintColors() {
    const host = body.querySelector('#vp-colors');
    clear(host);
    const def = (cache.settings.colors || []).find((c) => c.name === chosenColor);
    for (const v of groups.get(chosenSize) || []) {
      const name = v.color || '—';
      const cdef = (cache.settings.colors || []).find((c) => c.name === name);
      host.appendChild(
        el(`button.opt${chosenColor === name ? '.is-on' : ''}`, {
          type: 'button',
          onClick: () => { chosenColor = name; paintColors(); paintStock(); },
        },
          cdef ? el('i.swatch', { style: `background:${cdef.hex};width:15px;height:15px` }) : null,
          el('span', { text: name }),
          el('span.tiny', { style: 'opacity:.7', text: `${v.quantity} متاح` })
        )
      );
    }
  }

  function paintStock() {
    const host = body.querySelector('#vp-stock');
    const n = variantStock(p, chosenSize === '—' ? '' : chosenSize, chosenColor === '—' ? '' : chosenColor);
    clear(host);
    host.appendChild(
      el(
        'div',
        { style: `padding:11px 13px;border-radius:12px;background:${n > 0 ? 'var(--success-tint)' : 'var(--danger-tint)'};font-size:13.5px;font-weight:600;display:flex;gap:8px;align-items:center` },
        fromHTML(icon(n > 0 ? 'checkCircle' : 'alert')),
        el('span', { text: n > 0 ? `${n} قطعة متاحة من هذا الاختيار` : 'غير متوفر — اختر آخر' })
      )
    );
    if (addBtn) addBtn.disabled = n <= 0;
  }

  paintSizes();
  paintColors();

  const addBtn = el('button.btn.btn--primary.btn--block', { type: 'button', text: 'أضف إلى السلة' });

  const sheet = openSheet({
    title: 'اختر المقاس واللون',
    body,
    foot: addBtn,
  });

  paintStock();

  addBtn.addEventListener('click', () => {
    const v = (groups.get(chosenSize) || []).find(
      (x) => (x.color || '—') === chosenColor
    );
    if (!v) return;
    sheet.close();
    addItem(p, v);
  });
}

/** Adds a line to the cart and animates the product image flying into it. */
/** Finds a product by its barcode, tolerating spaces and case. */
function findBySku(products, code) {
  const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
  const want = norm(code);
  return products.find((p) => norm(p.sku) === want) || null;
}

/**
 * Scan into the cart: the known product goes straight in, and a product with
 * several variants still opens the size/colour picker.
 */
async function handleScan() {
  const code = await scanBarcode({ title: 'باركود المنتج' });
  if (!code) return;

  await ensureCache();
  const hit = findBySku(cache.products, code);
  if (!hit) {
    reportMissing(code);
    return;
  }
  pickProduct(hit);
}

/**
 * Puts a piece in the cart.
 *
 * The line itself is built and normalised by `addLine()` in cart-store.js, which
 * is where the quantity ceiling (the variant's real stock) and the "never
 * negative" rules live — this function only knows which product and which
 * variant, and which of the two outcomes to tell the owner about.
 */
function addItem(product, variant) {
  const key = `${product.id}|${variant.size}|${variant.color}`;
  const max = Number(variant.quantity) || 0;
  if (!max) {
    toast('هذه القطعة نافدة من المخزون', 'warn');
    return;
  }

  const outcome = addLine({
    key,
    productId: product.id,
    name: product.name,
    image: product.image || '',
    size: variant.size || '',
    color: variant.color || '',
    qty: 1,
    price: Number(product.price) || 0,
    costPrice: Number(product.costPrice) || 0,
    max,
  });

  // the thumbnail flies to the cart bar, which is the only thing that shows the
  // basket now
  const srcEl = document.querySelector('#pos-products .pos-item img');
  const cardEl = [...document.querySelectorAll('#pos-products .pos-item')].find(
    (b) => b.querySelector('.pos-item__name')?.textContent === product.name
  );
  const target = document.getElementById('cart-bar') || document.getElementById('pos-count');
  flyTo(cardEl || srcEl, target, product.image);

  if (outcome === 'full') {
    toast(`لا توجد كمية إضافية — المتاح ${max}`, 'warn');
    return;
  }
  toast(`أُضيف: ${product.name}`, 'ok', 1500);
}

/* ------------------------------------------------------------------ *
 * Teardown
 * ------------------------------------------------------------------ */

export function destroy() {
  // Keep the cart — an accidental navigation must not lose a sale in progress —
  // but stop listening to the store, or every past POS screen would keep
  // repainting a badge that is no longer on screen.
  while (activeScreens.length) {
    const stop = activeScreens.pop();
    try {
      stop();
    } catch (e) {
      console.error('[pos] unsubscribe failed', e);
    }
  }
}

export default { render, destroy };
