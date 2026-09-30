/**
 * Sales / POS — pick products, build a cart, apply a discount, take a
 * (labelled) payment method and complete the sale.
 *
 * Stock is decremented atomically by `createSale()` in db.js.
 *
 * Route: `#/pos` or `#/pos/<productId>` (the latter pre-loads one product —
 * used by the quick "+" button on product cards).
 */
import { icon } from '../icons.js';
import {
  el, fromHTML, clear, escapeHTML, num, numInt, moneyHTML, uid,
  flyTo, nudge, debounce, confetti, downloadText, fmtDate, fmtTime, dayKeyOf,
} from '../utils.js';
import { printPage, shareText } from '../native.js';
import {
  listProducts, getSettings, createSale,
  stockOf, availableVariants, variantStock,
} from '../db.js';
import { emptyState, openSheet, openModal, celebrate, confirmDialog, toast } from '../components.js';
import { scanBarcode, reportMissing } from '../scanner.js';
import { navigate } from '../router.js';
import {
  cart, discount, subtotal, discountAmount, grandTotal, totalItems, lineCount,
  getPaymentMethod, setPaymentMethod, getLastSale, setLastSale, clearCart, emit, subscribe,
} from '../cart-store.js';

const PAYMENTS = [
  { id: 'cash', label: 'نقداً', icon: 'cash' },
  { id: 'card', label: 'بطاقة', icon: 'card' },
  { id: 'transfer', label: 'تحويل', icon: 'transfer' },
];

let query = '';
let category = 'all';

/** Store subscriptions owned by mounted POS screens, released in destroy(). */
const activeScreens = [];

export function render(params = []) {
  const root = el('div.screen', { id: 'screen-pos' });

  const head = el(
    'div.page-head',
    {},
    el(
      'div.page-head__text',
      {},
      el('h1.page-title', {}, el('span', { text: 'نقطة البيع' }), el('span.badge.badge--primary', { id: 'pos-count', text: 'سلة فارغة' })),
      el('p.page-sub', { text: 'اضغط على المنتج لإضافته إلى السلة' })
    ),
    el(
      'div.page-head__actions',
      {},
      el('button.btn.btn--soft', { type: 'button', onClick: () => navigate('reports') }, fromHTML(icon('receipt')), el('span', { text: 'السجل' })),
      el('button.btn.btn--primary', { type: 'button', onClick: () => navigate('product/new') }, fromHTML(icon('plus')), el('span', { text: 'منتج' }))
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

  const right = el('div.pos__cart', { id: 'pos-cart' });

  root.appendChild(el('div.pos', {}, left, right));

  // The sticky cart bar mutates the shared store from other screens; this keeps
  // the POS column in step with it. Only the column is repainted here — calling
  // paintCart() would emit again and loop.
  const stopWatching = subscribe(repaintPos);

  paintProducts(root);
  // The router only appends the screen to #view *after* render() returns, so
  // #pos-cart is not in the document yet and repaintPos() would bail on its
  // `if (!host) return` guard. Calling it here meant every visit to POS painted
  // an empty cart column and a "سلة فارغة" badge even when the shared cart held
  // lines — the sticky bar was right and this column was wrong. One frame later
  // the screen is mounted, so repaint now.
  requestAnimationFrame(repaintPos);
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
        text: 'أضف منتجات أولاً لتتمكن من إجراء المبيعات.',
        action: el('button.btn.btn--primary', { type: 'button', onClick: () => navigate('product/new') }, fromHTML(icon('plus')), el('span', { text: 'إضافة منتج' })),
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

    grid.appendChild(
      el(
        `button.pos-item${stock === 0 ? '.is-out' : ''}`,
        {
          type: 'button',
          style: `animation-delay:${Math.min(i * 28, 240)}ms`,
          onClick: () => pickProduct(p),
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
            el('span.pos-item__price', { html: `${numInt(p.price)}<small style="font-size:10px;color:var(--ink-3)"> ${escapeHTML(cache.settings.currency)}</small>` }),
            el('span.pos-item__plus', {}, fromHTML(icon('plus')))
          )
        )
      )
    );
  });

  host.appendChild(grid);
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

function addItem(product, variant) {
  const key = `${product.id}|${variant.size}|${variant.color}`;
  const existing = cart.find((l) => l.key === key);

  const max = Number(variant.quantity) || 0;
  if (existing) {
    if (existing.qty >= max) {
      toast('لا توجد كمية إضافية متاحة', 'warn');
      return;
    }
    existing.qty++;
  } else {
    cart.push({
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
  }

  // the thumbnail flies to the cart bar when the POS column is off-screen, and
  // to the column when it is visible
  const srcEl = document.querySelector('#pos-products .pos-item img') ||
    document.querySelector('.pcard__media img');
  const cardEl = [...document.querySelectorAll('#pos-products .pos-item')].find(
    (b) => b.querySelector('.pos-item__name')?.textContent === product.name
  );
  const target = document.getElementById('pos-cart') ||
    document.getElementById('cart-bar') ||
    document.getElementById('pos-count');
  flyTo(cardEl || srcEl, target, product.image);

  paintCart('added');
  toast(`أُضيف: ${product.name}`, 'ok', 1500);
}

/* ------------------------------------------------------------------ *
 * Cart (right column)
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Cart (right column) — totals live in ../cart-store.js so the sticky
 * bar can show the same numbers on every screen.
 * ------------------------------------------------------------------ */

/** Repaints only the POS cart column. Safe to call from anywhere. */
function repaintPos() {
  const host = document.getElementById('pos-cart');
  const badge = document.getElementById('pos-count');
  if (!host) return;

  const cur = cache.settings?.currency || 'ILS';
  if (badge) badge.textContent = totalItems() ? `${totalItems()} قطعة` : 'سلة فارغة';

  clear(host);

  const card = el('div.cart');
  card.appendChild(
    el(
      'div.cart__head',
      {},
      fromHTML(icon('bag')),
      el('h3', { text: 'الطلب الحالي' }),
      el('span.cart__count', { text: `${cart.length} صنف` }),
      cart.length
        ? el('button.cart__clear', { type: 'button', text: 'تفريغ', onClick: clearCartAndReport })
        : null
    )
  );

  const items = el('div.cart__items');
  if (!cart.length) {
    items.appendChild(
      emptyState({
        iconName: 'bag',
        title: 'السلة فارغة',
        text: 'اختر منتجاً من القائمة لإضافته هنا.',
        small: true,
      })
    );
  } else {
    cart.forEach((line) => items.appendChild(cartLine(line, cur)));
  }
  card.appendChild(items);

  if (cart.length) card.appendChild(totalsBlock(cur));
  else card.appendChild(el('div', { style: 'padding:0 16px 16px' }));

  host.appendChild(card);
}

/**
 * Every cart change in the POS screen goes through here: repaint the column,
 * then tell the sticky bar. The bar does the mirror image — it mutates the
 * store and lets the subscription below call repaintPos() — so the two views
 * can never drift apart. `reason` lets the bar peek open on a fresh addition.
 */
function paintCart(reason = '') {
  repaintPos();
  emit(reason);
}

function cartLine(line, cur) {
  const node = el(
    'div.citem',
    {},
    el(
      'div.citem__main',
      {},
      el('div.citem__name.truncate', { text: line.name }),
      el(
        'div.citem__variant',
        {},
        line.size ? el('span.size-pill', { style: 'height:21px;min-width:auto;font-size:10.5px', text: line.size }) : null,
        line.color ? el('span', { text: line.color }) : null,
        el('span', { text: `× ${line.qty}` })
      ),
      el(
        'div.citem__ctrl',
        {},
        el(
          'div.qty',
          {},
          el('button', { type: 'button', 'aria-label': 'إنقاص', onClick: () => changeQty(line, -1) }, fromHTML(icon('minus'))),
          el('span', { text: String(line.qty) }),
          el('button', {
            type: 'button',
            'aria-label': 'زيادة',
            disabled: line.qty >= line.max,
            onClick: () => changeQty(line, 1),
          }, fromHTML(icon('plus')))
        ),
        el('button.citem__del', { type: 'button', 'aria-label': 'حذف', onClick: () => removeLine(line) }, fromHTML(icon('trash')))
      )
    ),
    el('div.citem__line', { html: moneyHTML(line.qty * line.price, cur) })
  );
  return node;
}

function changeQty(line, delta) {
  const next = line.qty + delta;
  if (next < 1) return removeLine(line);
  if (next > line.max) {
    toast(`المتاح فقط ${line.max} قطعة`, 'warn');
    return;
  }
  line.qty = next;
  paintCart();
  nudge(document.querySelector('.totals__grand .amount'));
}

function removeLine(line) {
  const node = [...document.querySelectorAll('.citem')].find(
    (n) => n.querySelector('.citem__name')?.textContent === line.name
  );
  const idx = cart.indexOf(line);
  if (idx > -1) cart.splice(idx, 1);

  if (node) {
    node.classList.add('is-leaving');
    node.addEventListener('animationend', () => paintCart(), { once: true });
    setTimeout(() => paintCart(), 260);
  } else {
    paintCart();
  }
}

function clearCartAndReport() {
  clearCart();
  toast('تم تفريغ السلة');
}

function totalsBlock(cur) {
  const sub = subtotal();
  const disc = discountAmount();
  const total = grandTotal();

  return el(
    'div.totals',
    {},
    el('div.totals__row', {}, el('span', { text: 'المجموع الفرعي' }), el('span', { html: moneyHTML(sub, cur) })),
    disc > 0
      ? el('div.totals__row.totals__row--save', {}, el('span', { text: 'الخصم' }), el('span', { html: `− ${moneyHTML(disc, cur)}` }))
      : null,

    /* discount entry */
    el(
      'div.promo-input',
      {},
      fromHTML(icon('percent')),
      el('input', {
        type: 'number',
        min: '0',
        step: discount.type === 'percent' ? '1' : '0.5',
        placeholder: discount.type === 'percent' ? 'نسبة %' : 'مبلغ خصم',
        value: discount.value || '',
        oninput: debounce((e) => {
          const v = parseFloat(e.target.value);
          discount.value = Number.isFinite(v) && v > 0 ? v : 0;
          paintCart();
          // the input is recreated by the repaint — restore focus for typing
          const inp = document.querySelector('.promo-input input');
          if (inp) {
            inp.focus({ preventScroll: true });
            try {
              inp.setSelectionRange(inp.value.length, inp.value.length);
            } catch {
              /* <input type=number> does not support selection */
            }
          }
        }, 220),
      }),
      el(
        'div.seg',
        {},
        el('button', {
          type: 'button',
          text: 'ILS',
          class: discount.type === 'fixed' ? 'is-active' : '',
          onClick: () => { discount.type = 'fixed'; paintCart(); },
        }),
        el('button', {
          type: 'button',
          text: '%',
          class: discount.type === 'percent' ? 'is-active' : '',
          onClick: () => { discount.type = 'percent'; paintCart(); },
        })
      )
    ),

    /* payment method */
    el(
      'div.pay-methods',
      {},
      ...PAYMENTS.map((p) =>
        el(`button.pay-method${getPaymentMethod() === p.id ? '.is-on' : ''}`, {
          type: 'button',
          onClick: () => { setPaymentMethod(p.id); paintCart(); },
        }, fromHTML(icon(p.icon)), el('span', { text: p.label }))
      )
    ),

    el(
      'div.totals__grand',
      {},
      el('span', { style: 'font-weight:600;color:var(--ink-2)', text: 'الإجمالي النهائي' }),
      el('span.amount.amount--lg', { html: moneyHTML(total, cur) })
    ),

    el(
      'button.btn.btn--primary.checkout-btn',
      { type: 'button', onClick: completeSale },
      fromHTML(icon('receipt')),
      el('span', { text: 'إتمام الدفع' }),
      el('b', { html: moneyHTML(total, cur) })
    )
  );
}

/* ------------------------------------------------------------------ *
 * Complete sale + receipt
 * ------------------------------------------------------------------ */

async function completeSale() {
  if (!cart.length) {
    toast('السلة فارغة — أضف منتجاً أولاً', 'warn');
    return;
  }

  // guard against stock that changed since the cart was built
  const products = await listProducts();
  const byId = new Map(products.map((p) => [p.id, p]));
  for (const line of cart) {
    const p = byId.get(line.productId);
    const available = p ? variantStock(p, line.size, line.color) : 0;
    if (line.qty > available) {
      toast(`«${line.name}» متاح ${available} فقط`, 'err');
      return;
    }
  }

  const seq = await seqForToday();

  const sale = await createSale({
    items: cart.map((l) => ({
      productId: l.productId,
      name: l.name,
      size: l.size,
      color: l.color,
      qty: l.qty,
      price: l.price,
      costPrice: l.costPrice,
    })),
    discountType: discount.type,
    discountValue: discount.value || 0,
    paymentMethod: getPaymentMethod(),
    receiptSeq: seq,
  });

  setLastSale(sale);
  const settings = await getSettings();

  await celebrate({
    title: 'تمت عملية البيع',
    sub: `فاتورة ${sale.receiptNo} · ${moneyHTML(sale.total, settings.currency)}`,
    ms: 1400,
  });

  // reset for the next sale
  clearCart();
  setPaymentMethod('cash');
  invalidateCache();

  // createSale() just rewrote quantities in IndexedDB, so the Inventory screen's
  // module-level cache is stale too — otherwise walking to المخزن after a sale
  // shows pre-sale stock. Same dynamic import the product form already uses,
  // so no static import (and no import cycle) is introduced.
  import('./products.js').then((m) => m.invalidate()).catch(() => {});

  paintCart();
  paintProducts();
  showReceipt(sale, settings);
}

/** Receipt numbers are sequential within the current day. */
async function seqForToday() {
  const all = await import('../db.js').then((m) => m.listSales());
  // Both sides use the local day: the stored timestamp is UTC, so comparing it
  // against a UTC "today" would restart the numbering every evening and hand
  // out a number the shop already used.
  const day = dayKeyOf(new Date());
  return all.filter((s) => dayKeyOf(s.timestamp) === day).length;
}

/* ------------------------------------------------------------------ *
 * Receipt
 * ------------------------------------------------------------------ */

function receiptEl(sale, settings, { forPrint = false } = {}) {
  const cur = settings.currency;
  const lines = el(
    'div.receipt__lines',
    {},
    ...sale.items.map((it) =>
      el(
        'div.receipt__line',
        {},
        el('div.receipt__line-name', {}, el('b', { text: it.name }), el('small', { text: [it.size, it.color].filter(Boolean).join(' · ') || '—' })),
        el('div.receipt__line-qty', { text: `${it.qty} × ${num(it.price)}` }),
        el('div.receipt__line-amt', { html: moneyHTML(it.qty * it.price, cur) })
      )
    )
  );

  return el(
    'div.receipt',
    {},
    el(
      'div.receipt__head',
      {},
      settings.logo && settings.receiptShowLogo !== false
        ? el('img.receipt__logo', { src: settings.logo, alt: '' })
        : el('div.receipt__logo', { style: 'display:grid;place-items:center;color:#fff', html: icon('hanger') }),
      el('div.receipt__store', { text: settings.storeName }),
      el('div.receipt__meta', { text: [settings.address, settings.phone].filter(Boolean).join(' · ') || settings.storeTagline }),
      el('div.receipt__meta', { text: `${fmtDate(sale.timestamp, true)}` }),
      el('span.receipt__no', { text: `فاتورة ${sale.receiptNo}` })
    ),
    lines,
    el(
      'div.receipt__totals',
      {},
      el('div.totals__row', {}, el('span', { text: 'المجموع الفرعي' }), el('span', { html: moneyHTML(sale.subtotal, cur) })),
      sale.discount > 0
        ? el('div.totals__row.totals__row--save', {}, el('span', { text: 'الخصم' }), el('span', { html: `− ${moneyHTML(sale.discount, cur)}` }))
        : null,
      el(
        'div.totals__row',
        { style: 'font-size:16px;font-weight:700;color:var(--ink);padding-top:7px' },
        el('span', { text: 'الإجمالي' }),
        el('span', { html: moneyHTML(sale.total, cur) })
      ),
      el('div.totals__row', {}, el('span', { text: 'طريقة الدفع' }), el('span', { text: PAYMENTS.find((p) => p.id === sale.paymentMethod)?.label || 'نقود' }))
    ),
    el('div.receipt__foot', {}, el('span', { text: settings.receiptFooter || 'شكراً لتسوقكم معنا' }), el('div.receipt__barcode'))
  );
}

function showReceipt(sale, settings) {
  const body = el('div', {}, receiptEl(sale, settings));

  const m = openModal({
    title: `تمت العملية ${sale.receiptNo}`,
    body,
    onClose: () => {},
    foot: [
      el('button.btn', { type: 'button', onClick: () => shareReceipt(sale, settings) }, fromHTML(icon('share')), el('span', { text: 'مشاركة' })),
      el('button.btn.btn--soft', { type: 'button', onClick: () => printReceipt(sale, settings) }, fromHTML(icon('printer')), el('span', { text: 'طباعة' })),
      el('button.btn.btn--primary', { type: 'button', text: 'تم', onClick: () => m.close() }),
    ],
  });
}

function receiptText(sale, settings) {
  const cur = settings.currency;
  const pad = (a, b) => `${a}`.padEnd(0);
  const L = [];
  L.push(settings.storeName);
  L.push(`فاتورة: ${sale.receiptNo}`);
  L.push(`التاريخ: ${fmtDate(sale.timestamp, true)}`);
  L.push('--------------------------------');
  for (const it of sale.items) {
    L.push(`${it.name}`);
    L.push(`  ${[it.size, it.color].filter(Boolean).join(' · ')}  ${it.qty} × ${num(it.price)} = ${num(it.qty * it.price)} ${cur}`);
  }
  L.push('--------------------------------');
  L.push(`المجموع الفرعي: ${num(sale.subtotal)} ${cur}`);
  if (sale.discount > 0) L.push(`الخصم: -${num(sale.discount)} ${cur}`);
  L.push(`الإجمالي: ${num(sale.total)} ${cur}`);
  L.push(`الدفع: ${PAYMENTS.find((p) => p.id === sale.paymentMethod)?.label || ''}`);
  L.push('--------------------------------');
  L.push(settings.receiptFooter || '');
  return L.join('\n');
}

async function shareReceipt(sale, settings) {
  const text = receiptText(sale, settings);
  const title = `فاتورة ${sale.receiptNo}`;

  // WebView has no Web Share API, so the native sheet goes first there
  const native = await shareText(title, text);
  if (native !== 'unavailable') return; // shared, or the user dismissed it

  if (navigator.share) {
    try {
      await navigator.share({ title, text });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('تم نسخ الفاتورة', 'ok');
  } catch {
    const saved = await downloadText(text, `receipt-${sale.receiptNo}.txt`);
    toast(saved ? 'تم تنزيل الفاتورة كنص' : 'تعذّر حفظ الفاتورة', saved ? 'ok' : 'err');
  }
}

function printReceipt(sale, settings) {
  const root = document.getElementById('print-root');
  clear(root);
  const wrap = el('div', { style: 'max-width:340px;margin:0 auto' });
  wrap.appendChild(receiptEl(sale, settings, { forPrint: true }));
  root.appendChild(wrap);
  setTimeout(() => printPage().catch((err) => console.warn('[print] failed', err)), 60);
}

/* ------------------------------------------------------------------ *
 * Reset helper (called when leaving the screen)
 * ------------------------------------------------------------------ */

export function destroy() {
  // keep the cart so an accidental navigation doesn't lose a sale in progress
  // but stop listening to the store, or every past POS screen would keep
  // repainting a column that is no longer on screen
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
