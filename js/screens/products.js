/**
 * Products / Inventory — grid or list view with search, category filters,
 * sorting and a filter sheet (size / colour / stock status).
 */
import { icon } from '../icons.js';
import {
  el, fromHTML, clear, escapeHTML, debounce, moneyHTML, numInt, uid,
} from '../utils.js';
import { listProducts, saveProduct, stockOf, deleteProduct, getSettings } from '../db.js';
import { lowStockProducts } from '../analytics.js';
import { pageHead, emptyState, skeletonGrid, openSheet, confirmDialog, toast, sectionTitle } from '../components.js';
import { scanBarcode, reportMissing } from '../scanner.js';
import { openRestockSheet } from '../restock.js';
import { PREFILL_KEY } from './product-form.js';
import { navigate } from '../router.js';

const SORTS = [
  { id: 'newest', label: 'الأحدث إضافة' },
  { id: 'name', label: 'الاسم (أ → ي)' },
  { id: 'price-asc', label: 'السعر: من الأقل' },
  { id: 'price-desc', label: 'السعر: من الأعلى' },
  { id: 'stock-asc', label: 'المخزون: الأقل أولاً' },
];

const STOCK_FILTERS = [
  { id: 'all', label: 'الكل' },
  { id: 'low', label: 'منخفض' },
  { id: 'out', label: 'نافد' },
  { id: 'ok', label: 'متوفر' },
];

const state = {
  view: 'grid',
  query: '',
  category: 'all',
  sort: 'newest',
  stock: 'all',
  size: '',
  color: '',
};

export function render() {
  const root = el('div.screen', { id: 'screen-products' });
  const host = el('div', { id: 'products-root' });

  root.appendChild(
    pageHead({
      title: 'المنتجات',
      sub: 'إدارة المخزون والأسعار والمقاسات',
      badge: el('span.count', { id: 'products-count', text: '…' }),
    })
  );

  // --- toolbar -------------------------------------------------------
  const searchInput = el('input', {
    type: 'search',
    placeholder: 'ابحث بالاسم، الرمز أو التصنيف…',
    value: state.query,
    oninput: debounce((e) => {
      state.query = e.target.value.trim();
      syncSearchClear();
      paint();
    }, 160),
  });

  const searchBox = el(
    'div.search',
    {},
    fromHTML(icon('search')),
    searchInput,
    el('button.search__clear', {
      type: 'button',
      'aria-label': 'مسح البحث',
      hidden: !state.query,
      onClick: () => {
        state.query = '';
        searchInput.value = '';
        syncSearchClear();
        paint();
      },
    }, fromHTML(icon('x')))
  );

  function syncSearchClear() {
    const b = searchBox.querySelector('.search__clear');
    if (b) b.hidden = !state.query;
  }

  const viewToggle = el(
    'div.viewtoggle',
    {},
    el('button', {
      type: 'button',
      'aria-label': 'عرض شبكي',
      class: state.view === 'grid' ? 'is-active' : '',
      onClick: () => setView('grid'),
      html: icon('grid'),
    }),
    el('button', {
      type: 'button',
      'aria-label': 'عرض قائمة',
      class: state.view === 'list' ? 'is-active' : '',
      onClick: () => setView('list'),
      html: icon('list'),
    })
  );

  const sortBtn = el(
    'button.pill-btn',
    { type: 'button', id: 'sort-btn', onClick: openSort },
    fromHTML(icon('sort')),
    el('span', { text: SORTS.find((s) => s.id === state.sort).label })
  );

  const filterBtn = el(
    'button.pill-btn',
    { type: 'button', id: 'filter-btn', onClick: openFilters },
    fromHTML(icon('filter')),
    el('span', { text: 'تصفية' })
  );

  const scanBtn = el(
    'button.pill-btn.pill-btn--scan.pill-btn--lg',
    { type: 'button', id: 'scan-btn', onClick: () => handleScan(root) },
    fromHTML(icon('barcode')),
    el('span', { text: 'مسح الباركود' })
  );

  const addBtn = el(
    'button.pill-btn.pill-btn--lg.pill-btn--add',
    { type: 'button', id: 'add-btn', onClick: () => navigate('product/new') },
    fromHTML(icon('plus')),
    el('span', { text: 'إضافة بضاعة جديدة' })
  );

  root.appendChild(el('div.stat-grid.stat-grid--inv', { id: 'inv-stats' }));
  root.appendChild(
    el(
      'div.products-toolbar',
      {},
      el('div.products-toolbar__row', {}, searchBox, scanBtn, sortBtn, filterBtn, viewToggle),
      el('div.products-toolbar__actions', {}, addBtn),
      el('div.chip-row', { id: 'category-chips' })
    )
  );

  root.appendChild(el('div.result-line', { id: 'result-line' }));
  root.appendChild(host);

  root._searchBox = searchBox;
  root._sortBtn = sortBtn;
  root._filterBtn = filterBtn;

  paint(root);
  return root;
}

/* ------------------------------------------------------------------ *
 * Local view state
 * ------------------------------------------------------------------ */

function setView(v) {
  state.view = v;
  const root = document.getElementById('screen-products');
  if (!root) return;
  root.querySelectorAll('.viewtoggle button').forEach((b, i) => {
    b.classList.toggle('is-active', (i === 0) === (v === 'grid'));
  });
  paint();
}

/* ------------------------------------------------------------------ *
 * Data painting
 * ------------------------------------------------------------------ */

let cache = { products: [], settings: null };

async function paint(screenRoot) {
  const root = screenRoot || document.getElementById('screen-products');
  const host = root?.querySelector('#products-root');
  if (!host) return;

  if (!cache.settings) {
    clear(host);
    host.appendChild(skeletonGrid(state.view === 'grid' ? 8 : 5, state.view === 'grid' ? 'pcard' : 'prow'));
    const [products, settings] = await Promise.all([listProducts(), getSettings()]);
    if (!root.isConnected) return;
    cache = { products, settings };
  }

  renderInvStats(root);
  renderChips(root);
  renderResults(root, host);
}

/**
 * Three numbers the owner checks before anything else: how many pieces are on
 * the shelf, how many models those are, and how many need reordering. The
 * "needs reordering" count uses the existing low-stock threshold — no second,
 * competing definition of "low".
 */
function renderInvStats(root) {
  const host = root.querySelector('#inv-stats');
  if (!host) return;
  clear(host);

  const threshold = Number(cache.settings?.lowStockThreshold) || 5;
  const pieces = cache.products.reduce((t, p) => t + stockOf(p), 0);
  // "قارب على النفاد" is the near-out band only: things that still have stock
  // but sit at or below the existing threshold. A fully empty product is a
  // different state and already carries its "نفدت" badge on the card.
  const low = lowStockProducts(cache.products, threshold).filter((x) => x.stock > 0);

  const tile = (label, value, unit, iconName, tone, onClick) => {
    const node = el(
      `div.stat.stat--slim${onClick ? '.stat--tap' : ''}`,
      onClick
        ? {
            role: 'button',
            tabindex: '0',
            title: label,
            onClick,
            onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && onClick(),
          }
        : {}
    );
    node.appendChild(
      el(
        'div.stat__top',
        {},
        el(`div.stat__icon.stat__icon--sm${tone ? '.stat__icon--' + tone : ''}`, {}, fromHTML(icon(iconName))),
        el('div.stat__label', { text: label })
      )
    );
    node.appendChild(
      el('div.stat__value', {}, el('span', { text: String(value) }), unit ? el('small', { text: unit }) : null)
    );
    return node;
  };

  host.appendChild(tile('إجمالي القطع', pieces, 'قطعة', 'package', 'emerald', null));
  host.appendChild(tile('عدد الموديلات', cache.products.length, 'منتج', 'layers', 'brass', null));
  host.appendChild(
    tile('قارب على النفاد', low.length, 'منتج', 'alert', 'danger', low.length ? () => openStockFilter(root) : null)
  );
}

/** Jumps the list straight to the low / near-out products. */
function openStockFilter(root) {
  state.stock = 'low';
  root.querySelector('#filter-btn')?.classList.add('is-on');
  paint(root);
  root.querySelector('#result-line')?.scrollIntoView({ block: 'center' });
}

function renderChips(root) {
  const host = root.querySelector('#category-chips');
  if (!host) return;
  clear(host);

  const cats = ['all', ...(cache.settings?.categories || [])];
  const counts = {};
  for (const p of cache.products) counts[p.category] = (counts[p.category] || 0) + 1;

  cats.forEach((c) => {
    const label = c === 'all' ? 'الكل' : c;
    const n = c === 'all' ? cache.products.length : counts[c] || 0;
    if (c !== 'all' && !n) return;
    host.appendChild(
      el(
        `button.chip${state.category === c ? '.is-active' : ''}`,
        {
          type: 'button',
          onClick: () => {
            state.category = c;
            paint();
          },
        },
        el('span', { text: label }),
        el('span.chip--count', { text: String(n) })
      )
    );
  });
}

function filtered() {
  const q = state.query.toLowerCase();
  let list = cache.products.filter((p) => {
    if (state.category !== 'all' && p.category !== state.category) return false;
    if (state.size && !(p.variants || []).some((v) => v.size === state.size)) return false;
    if (state.color && !(p.variants || []).some((v) => v.color === state.color)) return false;
    if (state.stock !== 'all') {
      const s = stockOf(p);
      if (state.stock === 'out' && s !== 0) return false;
      if (state.stock === 'low' && !(s > 0 && s <= (Number(cache.settings.lowStockThreshold) || 5))) return false;
      if (state.stock === 'ok' && s <= 0) return false;
    }
    if (!q) return true;
    return [p.name, p.category, p.sku, p.description]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  });

  const by = {
    newest: (a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''),
    name: (a, b) => a.name.localeCompare(b.name, 'ar'),
    'price-asc': (a, b) => a.price - b.price,
    'price-desc': (a, b) => b.price - a.price,
    'stock-asc': (a, b) => stockOf(a) - stockOf(b),
  };
  return list.sort(by[state.sort] || by.newest);
}

function renderResults(root, host) {
  const list = filtered();
  const cur = cache.settings?.currency || 'ILS';
  const threshold = Number(cache.settings?.lowStockThreshold) || 5;

  const line = root.querySelector('#result-line');
  if (line) {
    clear(line);
    line.appendChild(el('span', { text: `${list.length} منتج` }));
    const active = state.stock !== 'all' || state.size || state.color || state.category !== 'all';
    if (active) {
      line.appendChild(
        el('button.card-head__action', {
          type: 'button',
          text: 'إعادة ضبط',
          onClick: () => {
            state.stock = 'all';
            state.size = '';
            state.color = '';
            state.category = 'all';
            paint();
          },
        })
      );
    }
  }

  const badge = root.querySelector('#products-count');
  if (badge) badge.textContent = String(cache.products.length);

  const fBtn = root.querySelector('#filter-btn');
  if (fBtn) {
    const on = state.stock !== 'all' || state.size || state.color;
    fBtn.classList.toggle('is-on', !!on);
  }

  clear(host);

  if (!cache.products.length) {
    host.appendChild(
      emptyState({
        iconName: 'hanger',
        title: 'لا توجد منتجات بعد',
        text: 'ابدأ ب إضافة أول قطعة إلى متجرك — ستظهر هنا مع صورها ومقاساتها.',
        action: el('button.btn.btn--primary', { type: 'button', onClick: () => navigate('product/new') }, fromHTML(icon('plus')), el('span', { text: 'إضافة أول منتج' })),
      })
    );
    return;
  }

  if (!list.length) {
    host.appendChild(
      emptyState({
        iconName: 'search',
        title: 'لا نتائج مطابقة',
        text: 'جرّب كلمة بحث أخرى أو أعد ضبط عوامل التصفية.',
        small: true,
        action: el('button.btn.btn--soft', { type: 'button', onClick: () => {
          state.query = '';
          state.category = 'all';
          state.stock = 'all';
          state.size = '';
          state.color = '';
          const inp = root.querySelector('.search input');
          if (inp) inp.value = '';
          paint();
        } }, fromHTML(icon('refresh')), el('span', { text: 'إعادة ضبط' })),
      })
    );
    return;
  }

  if (state.view === 'grid') {
    const grid = el('div.product-grid');
    list.forEach((p, i) => grid.appendChild(productCard(p, cur, threshold, i)));
    host.appendChild(grid);
  } else {
    const wrap = el('div.plist');
    list.forEach((p, i) => wrap.appendChild(productRow(p, cur, threshold, i)));
    host.appendChild(wrap);
  }
}

/* ------------------------------------------------------------------ *
 * Cards
 * ------------------------------------------------------------------ */

function sizesOf(p) {
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

function productCard(p, cur, threshold, index) {
  const stock = stockOf(p);
  const sizes = sizesOf(p);

  const restock = (e) => {
    e.stopPropagation();
    openRestockSheet(p, { onDone: () => paint() });
  };
  const edit = (e) => {
    e.stopPropagation();
    navigate(`product/${p.id}`);
  };

  return el(
    'article.pcard',
    {
      tabindex: '0',
      role: 'button',
      style: `animation-delay:${Math.min(index * 35, 260)}ms`,
      onClick: () => navigate(`product/${p.id}`),
      onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && navigate(`product/${p.id}`),
    },
    el(
      'div.pcard__media',
      {},
      p.image
        ? el('img', { src: p.image, alt: p.name, loading: 'lazy' })
        : el('div.thumb-ph', {}, fromHTML(icon('hanger'))),
      el('span.pcard__tag', {}, stockBadge(stock, threshold, p.createdAt))
    ),
    el(
      'div.pcard__body',
      {},
      el('div.pcard__name', { text: p.name }),
      el(
        'div.pcard__meta',
        {},
        fromHTML(icon('tag')),
        el('span.truncate', { text: p.category })
      ),
      sizes.length
        ? el('div.pcard__sizes', {}, ...sizes.slice(0, 5).map((s) => el('span.size-pill', { text: s })))
        : el('div.pcard__sizes', {}, el('span.muted', { text: 'بدون مقاسات' })),
      el('div.pcard__stockline', { text: stock === 0 ? 'نفدت الكمية' : `${stock} قطعة متاحة` }),
      el(
        'div.pcard__foot',
        {},
        el('span.pcard__price', { html: `${numInt(p.price)}<small>${escapeHTML(cur)}</small>` })
      ),
      el(
        'div.pcard__acts',
        {},
        el('button.pill-btn.pill-btn--sm.pill-btn--restock', { type: 'button', onClick: restock },
          fromHTML(icon('box')), el('span', { text: 'تجديد الكمية' })),
        el('button.pill-btn.pill-btn--sm.pill-btn--edit', { type: 'button', onClick: edit },
          fromHTML(icon('pencil')), el('span', { text: 'تعديل البيانات' }))
      )
    )
  );
}

function productRow(p, cur, threshold, index) {
  const stock = stockOf(p);
  const sizes = sizesOf(p);

  return el(
    'article.prow',
    {
      tabindex: '0',
      role: 'button',
      style: `animation-delay:${Math.min(index * 35, 260)}ms`,
      onClick: () => navigate(`product/${p.id}`),
      onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && navigate(`product/${p.id}`),
    },
    p.image
      ? el('img.thumb.thumb--lg', { src: p.image, alt: '', loading: 'lazy' })
      : el('div.thumb.thumb--lg.thumb-ph', {}, fromHTML(icon('hanger'))),
    el(
      'div.prow__main',
      {},
      el(
        'div.prow__top',
        {},
        el('span.badge.badge--brass', { text: p.category }),
        p.sku ? el('span.prow__sku', { text: p.sku }) : null
      ),
      el('div.prow__name.truncate', { text: p.name }),
      sizes.length
        ? el('div.prow__badges', {}, ...sizes.slice(0, 6).map((s) => el('span.size-pill', { text: s })))
        : null,
      el(
        'div.prow__stock',
        {},
        el('i.dot-ok', { style: stock === 0 ? 'background:var(--danger)' : stock <= threshold ? 'background:var(--warning)' : '' }),
        el('span', { text: stock === 0 ? 'نفدت الكمية' : `${stock} قطعة متاحة` })
      )
    ),
    el(
      'div.prow__end',
      {},
      el('span.prow__price', { html: `${numInt(p.price)}<small>${escapeHTML(cur)}</small>` }),
      stockBadge(stock, threshold, p.createdAt),
      el(
        'div.prow__acts',
        {},
        el('button.pill-btn.pill-btn--sm.pill-btn--restock', {
          type: 'button',
          onClick: (e) => { e.stopPropagation(); openRestockSheet(p, { onDone: () => paint() }); },
        }, fromHTML(icon('box')), el('span', { text: 'تجديد' })),
        el('button.pill-btn.pill-btn--sm.pill-btn--edit', {
          type: 'button',
          onClick: (e) => { e.stopPropagation(); navigate(`product/${p.id}`); },
        }, fromHTML(icon('pencil')), el('span', { text: 'تعديل' }))
      )
    )
  );
}

function stockBadge(stock, threshold, createdAt) {
  if (stock === 0) return el('span.badge.badge--out', { text: 'نفدت' });
  if (stock <= threshold) return el('span.badge.badge--low', { text: `${stock} متبقٍ` });
  if (createdAt && Date.now() - new Date(createdAt).getTime() < 7 * 864e5)
    return el('span.badge.badge--new', { text: 'جديد' });
  return el('span.badge.badge--ok', { text: 'متوفر' });
}

/* ------------------------------------------------------------------ *
 * Sheets: sort + filters
 * ------------------------------------------------------------------ */

function openSort() {
  const list = el(
    'div',
    {},
    ...SORTS.map((s) =>
      el(
        `button.pick${state.sort === s.id ? '.is-on' : ''}`,
        { type: 'button', onClick: () => { state.sort = s.id; sheet.close(); paint(); syncSortLabel(); } },
        el('span.pick__check', {}, fromHTML(icon('check'))),
        el('span', { text: s.label })
      )
    )
  );
  const sheet = openSheet({ title: 'ترتيب النتائج', body: list });
}

function syncSortLabel() {
  const root = document.getElementById('screen-products');
  const btn = root?.querySelector('#sort-btn span');
  if (btn) btn.textContent = SORTS.find((s) => s.id === state.sort).label;
}

function openFilters() {
  const settings = cache.settings || { sizes: [], colors: [] };
  const draft = { stock: state.stock, size: state.size, color: state.color };

  const body = el('div', {});

  const stockRow = el(
    'div.opt-wrap',
    {},
    ...STOCK_FILTERS.map((s) =>
      el(`button.opt${draft.stock === s.id ? '.is-on' : ''}`, {
        type: 'button',
        text: s.label,
        onClick: (e) => {
          draft.stock = s.id;
          [...e.currentTarget.parentNode.children].forEach((c) => c.classList.remove('is-on'));
          e.currentTarget.classList.add('is-on');
        },
      })
    )
  );

  const sizeRow = el(
    'div.opt-wrap',
    {},
    ...['', ...(settings.sizes || [])].map((s) =>
      el(`button.opt${draft.size === s ? '.is-on' : ''}`, {
        type: 'button',
        text: s || 'الكل',
        onClick: (e) => {
          draft.size = s;
          [...e.currentTarget.parentNode.children].forEach((c) => c.classList.remove('is-on'));
          e.currentTarget.classList.add('is-on');
        },
      })
    )
  );

  const colorRow = el(
    'div.opt-wrap',
    {},
    ...['', ...((settings.colors || []).map((c) => c.name))].map((c) =>
      el(`button.opt${draft.color === c ? '.is-on' : ''}`, {
        type: 'button',
        onClick: (e) => {
          draft.color = c;
          [...e.currentTarget.parentNode.children].forEach((cc) => cc.classList.remove('is-on'));
          e.currentTarget.classList.add('is-on');
        },
      }, c ? swatchDot((settings.colors || []).find((x) => x.name === c)) : null, el('span', { text: c || 'الكل' }))
    )
  );

  body.appendChild(el('div.field', {}, el('label.field__label', { text: 'حالة المخزون' }), stockRow));
  body.appendChild(el('div.field', {}, el('label.field__label', { text: 'المقاس' }), sizeRow));
  body.appendChild(el('div.field', {}, el('label.field__label', { text: 'اللون' }), colorRow));

  const sheet = openSheet({
    title: 'تصفية النتائج',
    body,
    foot: el(
      'div',
      { style: 'display:flex;gap:9px' },
      el('button.btn', { type: 'button', text: 'مسح', onClick: () => {
        state.stock = 'all'; state.size = ''; state.color = '';
        sheet.close(); paint();
      } }),
      el('button.btn.btn--primary', { type: 'button', text: 'تطبيق', onClick: () => {
        state.stock = draft.stock;
        state.size = draft.size;
        state.color = draft.color;
        sheet.close();
        paint();
      } })
    ),
  });
}

function swatchDot(c) {
  return el('i.swatch', { style: `background:${c ? c.hex : 'transparent'};width:16px;height:16px;box-shadow:0 0 0 1px var(--line)` });
}

/** Finds a product by its barcode, tolerating spaces and case. */
function findBySku(products, code) {
  const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
  const want = norm(code);
  return products.find((p) => norm(p.sku) === want) || null;
}

/**
 * Scan from the inventory toolbar: opens the product when the code is known,
 * offers to start a new one when it is not.
 */
async function handleScan(root) {
  const code = await scanBarcode({ title: 'باركود المنتج' });
  if (!code) return;

  const products = await listProducts();
  const hit = findBySku(products, code);

  if (hit) {
    navigate(`product/${hit.id}`);
    return;
  }

  const add = await confirmDialog({
    title: 'باركود غير معروف',
    message: `لا يوجد منتج مسجّل بالباركود ${code}. هل تريد إضافته الآن؟`,
    confirmLabel: 'إضافة منتج',
  });
  if (!add) {
    reportMissing(code);
    return;
  }
  sessionStorage.setItem(PREFILL_KEY, code);
  navigate('product/new');
}

/** Re-read products after a change elsewhere (e.g. after saving a product). */
export function invalidate() {
  cache = { products: [], settings: null };
}

export default { render };
