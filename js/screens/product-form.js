/**
 * Add / edit a product.
 *
 * Params: ['new'] for a new product, [id] to edit.
 *
 * Variants are modelled as `[{size, color, quantity}]` (see db.js). The form
 * keeps a sparse map keyed by `size|color` and materialises the array on save,
 * so deselecting a size drops its combinations automatically.
 */
import { icon } from '../icons.js';
import {
  el, fromHTML, clear, escapeHTML, moneyHTML, num, uid,
  processImage, pickFile, readFileAsDataURL, wait, confetti,
} from '../utils.js';
import {
  listProducts, saveProduct, getSettings, saveSettings, deleteProduct, stockOf,
} from '../db.js';
import { pageHead, openModal, confirmDialog, celebrate, promptDialog, toast, pinDialog } from '../components.js';
import { scanBarcode } from '../scanner.js';
import { navigate } from '../router.js';

const NO_SIZE = ''; // shown as "—" when the product has no size breakdown

/** Shared with the inventory screen: pre-fills the barcode on a new product. */
export const PREFILL_KEY = 'majari:prefill-barcode';

export function render(params = []) {
  const id = params[0] && params[0] !== 'new' ? params[0] : null;
  const root = el('div.screen', { id: 'screen-product-form' });

  root.appendChild(
    pageHead({
      title: id ? 'تعديل المنتج' : 'منتج جديد',
      sub: id ? 'حدّث البيانات والمخزون' : 'أضف قطعة جديدة إلى متجرك',
      back: () => history.length > 1 ? history.back() : navigate('products'),
    })
  );

  const host = el('div', { id: 'form-host' });
  root.appendChild(host);
  host.appendChild(el('div.loading-row', {}, el('i.spinner.spinner--ink'), el('span', { text: 'جارٍ فتح النموذج…' })));

  boot(root, host, id);
  return root;
}

async function boot(root, host, id) {
  const [products, settings] = await Promise.all([listProducts(), getSettings()]);
  if (!root.isConnected) return;

  const existing = id ? products.find((p) => p.id === id) : null;
  if (id && !existing) {
    clear(host);
    host.appendChild(
      el(
        'div.empty',
        {},
        el('div.empty__art', {}, fromHTML(icon('alert'))),
        el('h3', { text: 'المنتج غير موجود' }),
        el('p', { text: 'ربما تم حذفه من جهاز آخر.' }),
        el('button.btn.btn--primary', { type: 'button', text: 'العودة للمنتجات', onClick: () => navigate('products') })
      )
    );
    return;
  }

  const draft = hydrate(existing, settings);

  // a scan that matched nothing drops the code here before sending us here
  if (!id) {
    const prefill = sessionStorage.getItem(PREFILL_KEY);
    if (prefill) {
      sessionStorage.removeItem(PREFILL_KEY);
      draft.sku = prefill;
    }
  }

  clear(host);
  host.appendChild(buildForm(draft, settings, id));
}

/* ------------------------------------------------------------------ *
 * Draft model
 * ------------------------------------------------------------------ */

function hydrate(p, settings) {
  const d = {
    id: p?.id || uid(),
    name: p?.name || '',
    sku: p?.sku || '',
    category: p?.category || settings.categories[0] || 'غير مصنف',
    description: p?.description || '',
    price: p?.price ?? '',
    costPrice: p?.costPrice ?? '',
    image: p?.image || '',
    createdAt: p?.createdAt || new Date().toISOString(),
    sizes: p ? uniq((p.variants || []).map((v) => v.size)) : [...settings.sizes.slice(0, 4)],
    colors: p ? uniq((p.variants || []).map((v) => v.color)) : [settings.colors[0]?.name].filter(Boolean),
    qty: new Map(),
    errors: {},
  };
  if (p) {
    for (const v of p.variants || []) d.qty.set(key(v.size, v.color), Number(v.quantity) || 0);
  }
  if (!d.sizes.length) d.sizes = [NO_SIZE];
  if (!d.colors.length) d.colors = [NO_SIZE];
  return d;
}

const uniq = (a) => [...new Set(a.filter((s) => s !== null && s !== undefined))];
const key = (s, c) => `${s || NO_SIZE}|${c || NO_SIZE}`;

function buildVariants(d) {
  const out = [];
  for (const s of d.sizes) {
    for (const c of d.colors) {
      out.push({ size: s, color: c, quantity: Number(d.qty.get(key(s, c))) || 0 });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Form
 * ------------------------------------------------------------------ */

function buildForm(d, settings, editingId) {
  const wrap = el('div', { id: 'product-form' });
  const cur = settings.currency;

  /* --- 1 · image ---------------------------------------------------- */
  const imgPreview = el('div.image-strip', {});
  function paintImage() {
    clear(imgPreview);
    if (!d.image) return;
    imgPreview.appendChild(
      el(
        'div.image-thumb',
        {},
        el('img', { src: d.image, alt: '' }),
        el('button.image-thumb__x', { type: 'button', 'aria-label': 'حذف الصورة', onClick: () => { d.image = ''; paintImage(); } }, fromHTML(icon('x')))
      )
    );
  }

  const dropzone = el(
    'label.dropzone',
    {
      htmlFor: 'product-image',
      ondragover: (e) => { e.preventDefault(); dropzone.classList.add('is-over'); },
      ondragleave: () => dropzone.classList.remove('is-over'),
      ondrop: (e) => {
        e.preventDefault();
        dropzone.classList.remove('is-over');
        const f = e.dataTransfer.files?.[0];
        if (f) handleFile(f);
      },
    },
    fromHTML(icon('camera')),
    el('b', { text: 'اسحب صورة هنا أو اضغط للاختيار' }),
    el('span', { text: 'JPG / PNG · تُصغَّر تلقائياً لتناسب التخزين المحلي' }),
    el('input', {
      id: 'product-image',
      type: 'file',
      accept: 'image/*',
      onChange: (e) => e.target.files?.[0] && handleFile(e.target.files[0]),
    })
  );

  async function handleFile(file) {
    try {
      dropzone.innerHTML = `<div class="spinner spinner--ink"></div><span>جارٍ معالجة الصورة…</span>`;
      d.image = await processImage(file, 900, 0.82);
      dropzone.innerHTML = '';
      dropzone.appendChild(el('img', { src: d.image, alt: '' }));
      dropzone.appendChild(el('span', { style: 'position:absolute;bottom:6px;inset-inline-start:6px;background:rgba(33,29,29,.72);color:#fff;padding:3px 8px;border-radius:8px;z-index:2', text: 'اضغط لتغيير الصورة' }));
      paintImage();
    } catch (e) {
      toast('تعذّرت قراءة الصورة', 'err');
      dropzone.innerHTML = '';
      dropzone.appendChild(fromHTML(icon('camera')));
      dropzone.appendChild(el('b', { text: 'اسحب صورة هنا أو اضغط للاختيار' }));
    }
  }

  if (d.image) {
    dropzone.appendChild(el('img', { src: d.image, alt: '' }));
    dropzone.appendChild(el('span', { style: 'position:absolute;bottom:6px;inset-inline-start:6px;background:rgba(33,29,29,.72);color:#fff;padding:3px 8px;border-radius:8px;z-index:2', text: 'اضغط لتغيير الصورة' }));
  }

  wrap.appendChild(
    section(1, 'الصور', 'صورة واحدة واضحة تكفي للعرض', [
      dropzone,
      imgPreview,
    ])
  );

  /* --- 2 · general info -------------------------------------------- */
  const nameInput = field('اسم المنتج', {
    id: 'f-name',
    placeholder: 'مثال: قميص كتان استوديو',
    value: d.name,
    required: true,
    errKey: 'name',
    onInput: (v) => { d.name = v; clearError('name'); },
  });

  const catSelect = el(
    'select.select',
    {
      onChange: (e) => { d.category = e.target.value; clearError('category'); },
    },
    ...(settings.categories || []).map((c) =>
      el('option', { value: c, text: c, selected: c === d.category })
    ),
    ...(settings.categories || []).includes(d.category) ? [] : [el('option', { value: d.category, text: d.category, selected: true })]
  );

  const skuInput = field('رمز الصنف / الباركود', {
    id: 'f-sku',
    placeholder: 'ATL-2041',
    value: d.sku,
    ltr: true,
    onInput: (v) => { d.sku = v; },
    addon: el(
      'button.icon-btn',
      {
        type: 'button',
        'aria-label': 'مسح الباركود',
        title: 'مسح الباركود',
        onClick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          const code = await scanBarcode({ title: 'باركود المنتج' });
          btn.disabled = false;
          if (!code) return;
          d.sku = code;
          const input = root()?.querySelector('#f-sku');
          if (input) input.value = code;
        },
      },
      fromHTML(icon('barcode'))
    ),
  });

  const descInput = field('الوصف', {
    id: 'f-desc',
    textarea: true,
    placeholder: 'صف القماش، القصّة، وخامة المنتج…',
    value: d.description,
    onInput: (v) => { d.description = v; },
  });

  const catBlock = el(
    'div.field',
    {},
    el(
      'label.field__label',
      {},
      el('span', { text: 'التصنيف' }),
      el('button.card-head__action', {
        type: 'button',
        text: '+ تصنيف',
        onClick: async () => {
          const v = await promptDialog({ title: 'تصنيف جديد', label: 'اسم التصنيف', placeholder: 'مثال: عبايات' });
          if (!v) return;
          if (!settings.categories.includes(v)) settings.categories.push(v);
          d.category = v;
          await saveSettings({ categories: settings.categories });
          clear(catSelect);
          settings.categories.forEach((c) => catSelect.appendChild(el('option', { value: c, text: c, selected: c === v })));
          toast('تمت إضافة التصنيف', 'ok');
        },
      })
    ),
    catSelect
  );

  wrap.appendChild(
    section(2, 'المعلومات العامة', null, [
      nameInput,
      el('div.grid-2', {}, catBlock, skuInput),
      descInput,
    ])
  );

  /* --- 3 · sizes & colours ------------------------------------------
   *
   * The selected chips and the library are two views of the same `d.sizes` /
   * `d.colors` state, so they are repainted together. They used to be painted
   * independently — the library was built once and each chip toggled its own
   * class — which meant removing a size with the × left the library chip still
   * glowing red: the chip claimed a size was picked that was not picked.
   * Deriving both from state is what keeps them honest. */
  const sizesHost = el('div.opt-wrap');
  const colorsHost = el('div.opt-wrap');
  // Assigned below, once the section is built — declared up here so the paint
  // helpers can close over them without a temporal-dead-zone trap.
  let sizeLibrary = null;
  let colorLibrary = null;

  function toggle(list, value) {
    const i = list.indexOf(value);
    if (i < 0) list.push(value);
    else list.splice(i, 1);
  }

  function paintSizes() {
    clear(sizesHost);
    for (const s of d.sizes) {
      if (s === NO_SIZE) continue;
      sizesHost.appendChild(
        el(
          `button.opt.is-on`,
          { type: 'button', onClick: () => { d.sizes = d.sizes.filter((x) => x !== s); paintSizes(); paintMatrix(); } },
          el('span', { text: s }),
          fromHTML(icon('x'))
        )
      );
    }
    sizesHost.appendChild(
      el('button.opt.opt--custom', { type: 'button', onClick: addSize }, fromHTML(icon('plus')), el('span', { text: 'مقاس' }))
    );
    paintSizeLibrary();
  }

  function paintSizeLibrary() {
    if (!sizeLibrary) return;
    clear(sizeLibrary);
    // a size selected earlier in this session joins the library too, so the
    // list is the full history rather than only the ones from settings
    const all = uniq([...(settings.sizes || []), ...d.sizes.filter((x) => x !== NO_SIZE)]);
    if (!all.length) {
      sizeLibrary.appendChild(el('div.tiny', { style: 'color:var(--ink-3);font-size:12px', text: 'لا توجد مقاسات في المكتبة بعد — أضف مقاساً جديداً.' }));
      return;
    }
    for (const s of all) {
      sizeLibrary.appendChild(
        el(`button.opt${d.sizes.includes(s) ? '.is-on' : ''}`, {
          type: 'button',
          text: s,
          onClick: () => { toggle(d.sizes, s); paintSizes(); paintMatrix(); },
        })
      );
    }
  }

  async function addSize() {
    const v = await promptDialog({ title: 'مقاس جديد', label: 'المقاس', placeholder: 'مثال: 42 أو XL' });
    if (!v) return;
    if (!d.sizes.includes(v)) d.sizes.push(v);
    if (!settings.sizes.includes(v)) {
      settings.sizes.push(v);
      saveSettings({ sizes: settings.sizes });
    }
    paintSizes();
    paintMatrix();
  }

  function paintColors() {
    clear(colorsHost);
    const palette = settings.colors || [];
    for (const c of d.colors) {
      if (c === NO_SIZE) continue;
      const def = palette.find((x) => x.name === c);
      colorsHost.appendChild(
        el(
          `button.opt.is-on`,
          { type: 'button', onClick: () => { d.colors = d.colors.filter((x) => x !== c); paintColors(); paintMatrix(); } },
          def ? el('i.swatch', { style: `background:${def.hex};width:16px;height:16px` }) : null,
          el('span', { text: c }),
          fromHTML(icon('x'))
        )
      );
    }
    colorsHost.appendChild(
      el('button.opt.opt--custom', { type: 'button', onClick: addColor }, fromHTML(icon('plus')), el('span', { text: 'لون' }))
    );
    paintColorLibrary();
  }

  function paintColorLibrary() {
    if (!colorLibrary) return;
    clear(colorLibrary);
    const palette = settings.colors || [];
    const names = uniq([...palette.map((x) => x.name), ...d.colors.filter((c) => c !== NO_SIZE)]);
    if (!names.length) {
      colorLibrary.appendChild(el('div.tiny', { style: 'color:var(--ink-3);font-size:12px', text: 'لا توجد ألوان في المكتبة بعد — أضف لوناً جديداً.' }));
      return;
    }
    for (const n of names) {
      const def = palette.find((x) => x.name === n);
      colorLibrary.appendChild(
        el(`button.opt${d.colors.includes(n) ? '.is-on' : ''}`, {
          type: 'button',
          onClick: () => { toggle(d.colors, n); paintColors(); paintMatrix(); },
        }, el('i.swatch', { style: `background:${def ? def.hex : '#7a7a86'};width:15px;height:15px` }), el('span', { text: n }))
      );
    }
  }

  async function addColor() {
    const v = await promptDialog({ title: 'لون جديد', label: 'اسم اللون', placeholder: 'مثال: زيتي' });
    if (!v) return;
    if (!d.colors.includes(v)) d.colors.push(v);
    paintColors();
    paintMatrix();
  }

  // Both libraries start empty and are filled by paintSizes / paintColors, so
  // they always agree with the selected chips above them.
  sizeLibrary = el('div.opt-wrap', { style: 'margin-top:9px' });
  colorLibrary = el('div.opt-wrap', { style: 'margin-top:9px' });

  const matrixHost = el('div');

  /* --- the local gate ------------------------------------------------ *
   *
   * Editing the quantities, sizes or colours of a product that is ALREADY on
   * the shelf is the fastest way to lose a real count, and the damage stays
   * invisible until a sale fails at the till. Those two sections therefore sit
   * behind the app's local pin while a saved product is being edited.
   *
   * A brand-new product is not locked: there is no recorded stock to damage
   * yet, and forcing the pin before the very first size is chosen would be
   * pure friction. Prices, names, categories and the barcode are never locked.
   * ------------------------------------------------------------------- */
  const gate = { open: !editingId };

  async function unlock() {
    if (gate.open) return true;
    const ok = await pinDialog({
      title: 'المقاسات والكميات محمية',
      hint: 'أدخل رمز المتجر لتعديل مقاسات وألوان وكميات منتج قائم. الأسعار والاسم والصور غير مقفلة.',
      pin: settings.editPin || '0000',
    });
    if (!ok) return false;
    gate.open = true;
    paintGate();
    return true;
  }

  const gateBanner = el('div.form-lock__banner');
  const gateSections = [];

  function paintGate() {
    for (const sec of gateSections) {
      sec.classList.toggle('is-locked', !gate.open);
      const mark = sec.querySelector('.form-lock__mark');
      if (mark) mark.hidden = gate.open;
    }
    clear(gateBanner);
    gateBanner.hidden = gate.open || !editingId;
    if (gateBanner.hidden) return;
    gateBanner.appendChild(
      el(
        'div.form-lock__box',
        {},
        fromHTML(icon('sliders')),
        el(
          'div.form-lock__txt',
          {},
          el('b', { text: 'المقاسات والألوان والكميات محمية' }),
          el('span.tiny', { text: 'أدخل رمز المتجر لتعديلها. باقي البيانات قابلة للتعديل.' })
        ),
        el('button.btn.btn--soft.btn--sm', { type: 'button', text: 'فتح', onClick: unlock })
      )
    );
  }

  /* --- 3 · sizes & colours (locked while editing a saved product) ----- */
  const sizesSection = section(3, 'الأحجام والألوان', null, [
    el('div.field', {}, el('label.field__label', {}, el('span', { text: 'المقاسات المتاحة' }), el('span.field__hint', { id: 'sizes-count' })), sizesHost, sizeLibrary),
    el('div.field', {}, el('label.field__label', {}, el('span', { text: 'ألوان المنتج' }), el('span.field__hint', { id: 'colors-count' })), colorsHost, colorLibrary),
  ]);
  markSection(sizesSection);
  wrap.appendChild(gateBanner);
  wrap.appendChild(sizesSection);

  function markSection(sec) {
    sec.querySelector('.form-section__head')?.appendChild(
      el('span.form-lock__mark', { hidden: gate.open }, fromHTML(icon('sliders')))
    );
    gateSections.push(sec);
    return sec;
  }

  /* --- 4 · pricing --------------------------------------------------- */
  const priceInput = field('سعر البيع', {
    id: 'f-price',
    placeholder: '0.00',
    value: d.price,
    money: true,
    ltr: true,
    required: true,
    errKey: 'price',
    onInput: (v) => { d.price = v; clearError('price'); paintMargin(); },
  });
  const costInput = field('سعر التكلفة', {
    id: 'f-cost',
    placeholder: '0.00',
    value: d.costPrice,
    money: true,
    ltr: true,
    onInput: (v) => { d.costPrice = v; paintMargin(); },
  });

  const marginChip = el('div', { id: 'margin-chip' });
  function paintMargin() {
    clear(marginChip);
    const price = Number(d.price);
    const cost = Number(d.costPrice);
    if (!(price > 0) || !(cost >= 0)) return;
    const diff = price - cost;
    const pct = cost > 0 ? (diff / cost) * 100 : 100;
    marginChip.appendChild(
      el(
        `span.margin-chip${diff <= 0 ? '.is-bad' : ''}`,
        {},
        fromHTML(icon(diff <= 0 ? 'alert' : 'trendingUp')),
        el('span', { text: diff <= 0 ? 'خسارة متوقعة' : `هامش ربح ${pct.toFixed(0)}% · ${num(diff)} ${cur}` })
      )
    );
  }

  wrap.appendChild(
    section(4, 'التسعير', null, [
      el('div.grid-2', {}, priceInput, costInput),
      marginChip,
    ])
  );

  /* --- 5 · stock matrix ---------------------------------------------- */
  const stockSection = section(5, 'مخزون القطعة', 'الكمية لكل مقاس ولون', [
    el(
      'div',
      { style: 'display:flex;gap:9px;flex-wrap:wrap;margin-bottom:4px' },
      el(
        'div.search',
        { style: 'flex:1;min-width:170px;min-height:42px' },
        fromHTML(icon('layers')),
        el('input', {
          type: 'number',
          min: '0',
          placeholder: 'كمية سريعة لكل المقاسات',
          oninput: (e) => fillAll(e.target.value),
        })
      ),
      el('button.btn.btn--sm.btn--soft', { type: 'button', onClick: () => fillAll('0') }, fromHTML(icon('refresh')), el('span', { text: 'تصفير' }))
    ),
    matrixHost,
    el('div', { id: 'stock-summary', style: 'margin-top:12px' }),
  ]);
  markSection(stockSection);
  wrap.appendChild(stockSection);

  /* --- matrix rendering ---------------------------------------------- */
  function paintMatrix() {
    clear(matrixHost);
    const sizes = d.sizes.length ? d.sizes : [NO_SIZE];
    const colors = d.colors.length ? d.colors : [NO_SIZE];

    const table = el('table.matrix');
    const thead = el('thead', {}, el('tr', {}, el('th', { text: 'لون \\ مقاس' }), ...sizes.map((s) => el('th', { text: s === NO_SIZE ? '—' : s }))));
    const tbody = el('tbody');

    for (const c of colors) {
      const tr = el('tr', {}, el('th', {}, colorDot(c), el('span', { text: c === NO_SIZE ? 'بدون لون' : c })));
      for (const s of sizes) {
        const k = key(s, c);
        const input = el('input', {
          type: 'number',
          min: '0',
          value: String(d.qty.get(k) ?? 0),
          oninput: (e) => {
            const v = Math.max(0, parseInt(e.target.value || '0', 10) || 0);
            d.qty.set(k, v);
            input.classList.toggle('is-low', v > 0 && v <= (Number(settings.lowStockThreshold) || 5));
            input.animate([{ transform: 'scale(1.12)' }, { transform: 'scale(1)' }], { duration: 220, easing: 'cubic-bezier(.34,1.56,.64,1)' });
            paintSummary();
          },
        });
        const cur = d.qty.get(k) ?? 0;
        if (cur > 0 && cur <= (Number(settings.lowStockThreshold) || 5)) input.classList.add('is-low');
        tr.appendChild(el('td', {}, input));
      }
      tbody.appendChild(tr);
    }

    // per-size totals along the bottom of the matrix
    const footRow = el('tr', {}, el('th', { text: 'الإجمالي' }));
    for (const s of sizes) {
      const sub = colors.reduce((t, c) => t + (Number(d.qty.get(key(s, c))) || 0), 0);
      footRow.appendChild(el('td', { text: String(sub) }));
    }

    table.appendChild(thead);
    table.appendChild(tbody);
    table.appendChild(el('tfoot', {}, footRow));
    matrixHost.appendChild(el('div.matrix-wrap', {}, table));

    // summary line
    const sizesEl = root()?.querySelector('#sizes-count');
    if (sizesEl) sizesEl.textContent = `${d.sizes.filter((s) => s !== NO_SIZE).length} مقاس`;
    const colorsEl = root()?.querySelector('#colors-count');
    if (colorsEl) colorsEl.textContent = `${d.colors.filter((c) => c !== NO_SIZE).length} لون`;

    paintSummary();
  }

  function paintSummary() {
    const host = root()?.querySelector('#stock-summary');
    if (!host) return;
    const total = [...d.qty.values()].reduce((t, v) => t + (Number(v) || 0), 0);
    const threshold = Number(settings.lowStockThreshold) || 5;
    clear(host);
    host.appendChild(
      el(
        'div',
        { style: `display:flex;gap:12px;align-items:center;padding:12px 14px;border-radius:12px;background:${total === 0 ? 'var(--danger-tint)' : 'var(--brass-tint)'};flex-wrap:wrap` },
        fromHTML(icon(total === 0 ? 'alert' : 'package')),
        el('b', { style: 'font-size:15px', text: `${total} قطعة في المخزون` }),
        el('span.tiny', { style: 'color:var(--ink-3);margin-inline-start:auto', text: `${d.sizes.length * d.colors.length} تركيبة` }),
        total > 0 && total <= threshold
          ? el('span.badge.badge--low', { text: 'ضمن حد النقص' })
          : null
      )
    );
  }

  function fillAll(v) {
    const n = Math.max(0, parseInt(v || '0', 10) || 0);
    const sizes = d.sizes.length ? d.sizes : [NO_SIZE];
    const colors = d.colors.length ? d.colors : [NO_SIZE];
    for (const s of sizes) for (const c of colors) d.qty.set(key(s, c), n);
    paintMatrix();
    toast(`تم ضبط ${n} لكل التركيبات`, 'ok', 1600);
  }

  function colorDot(c) {
    const def = (settings.colors || []).find((x) => x.name === c);
    return el('i.swatch', { style: `background:${def ? def.hex : '#e7ded1'};width:17px;height:17px` });
  }

  paintSizes();
  paintColors();
  paintMatrix();
  paintMargin();
  paintGate();

  /* --- actions -------------------------------------------------------- */
  const saveBtn = el(
    'button.btn.btn--primary.btn--lg',
    { type: 'button', onClick: () => submit(false) },
    fromHTML(icon('check')),
    el('span', { text: editingId ? 'حفظ التعديلات' : 'حفظ المنتج' })
  );

  wrap.appendChild(
    el(
      'div.form-actions',
      {},
      el('button.btn.btn--lg', { type: 'button', text: 'إلغاء', onClick: () => navigate('products') }),
      editingId
        ? el('button.btn.btn--danger-soft.btn--lg.btn--icon', { type: 'button', 'aria-label': 'حذف', onClick: removeProduct }, fromHTML(icon('trash')))
        : null,
      saveBtn
    )
  );

  /* --- validation + submit -------------------------------------------- */
  function root() {
    return document.getElementById('screen-product-form');
  }

  function field(labelText, opts = {}) {
    const id = opts.id || `f-${uid().slice(0, 8)}`;
    const common = {
      id,
      value: opts.value ?? '',
      oninput: (e) => opts.onInput && opts.onInput(e.target.value),
      onblur: (e) => opts.onInput && opts.onInput(e.target.value),
    };
    const control = opts.textarea
      ? el('textarea.textarea', { ...common, placeholder: opts.placeholder || '' })
      : el('input', {
          ...common,
          type: opts.money ? 'number' : 'text',
          inputmode: opts.money ? 'decimal' : 'text',
          step: opts.money ? '0.01' : undefined,
          min: opts.money ? '0' : undefined,
          placeholder: opts.placeholder || '',
          class: `input${opts.money ? ' input--money' : ''}${opts.ltr ? ' ltr' : ''}`,
        });

    return el(
      'div.field',
      { dataset: { err: opts.errKey || '' } },
      el('label.field__label', { htmlFor: id }, el('span', { text: labelText }), opts.required ? el('span.req', { text: '*' }) : null),
      opts.addon ? el('div.input-addon', {}, control, opts.addon) : control,
      el('div.field__error', {}, fromHTML(icon('alertCircle')), el('span', { text: '' }))
    );
  }

  function showError(key, msg) {
    const f = root()?.querySelector(`.field[data-err="${key}"]`);
    if (!f) return;
    f.classList.add('has-error');
    f.querySelector('.field__error span').textContent = msg;
  }
  function clearError(key) {
    const f = root()?.querySelector(`.field[data-err="${key}"]`);
    f?.classList.remove('has-error');
  }

  function validate() {
    const errs = [];
    clearErrors();
    if (d.name.trim().length < 2) { errs.push('name'); showError('name', 'اكتب اسم المنتج (حرفان على الأقل)'); }
    const price = Number(d.price);
    if (!(price > 0)) { errs.push('price'); showError('price', 'أدخل سعراً صحيحاً أكبر من صفر'); }
    if (d.costPrice !== '' && Number(d.costPrice) < 0) { errs.push('price'); showError('price', 'سعر التكلفة لا يمكن أن يكون سالباً'); }
    return errs;
  }
  function clearErrors() {
    root()?.querySelectorAll('.field.has-error').forEach((f) => f.classList.remove('has-error'));
  }

  async function submit(again) {
    const errs = validate();
    if (errs.length) {
      toast('راجع الحقول المميزة بالأحمر', 'err');
      const f = root()?.querySelector('.field.has-error');
      f?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      f?.querySelector('input,textarea')?.focus({ preventScroll: true });
      return;
    }

    const variants = buildVariants(d);
    const rec = {
      id: d.id,
      name: d.name.trim(),
      sku: d.sku.trim(),
      category: d.category,
      description: d.description.trim(),
      price: Number(d.price) || 0,
      costPrice: Number(d.costPrice) || 0,
      image: d.image,
      variants,
      createdAt: d.createdAt,
    };

    await saveProduct(rec);

    const ok = await celebrate({
      title: editingId ? 'تم حفظ التعديلات' : 'تمت إضافة المنتج',
      sub: `${rec.name} · ${variants.reduce((t, v) => t + v.quantity, 0)} قطعة`,
      ms: 1350,
    });

    if (again) {
      // reset for rapid entry of several products
      d.name = '';
      d.sku = '';
      d.description = '';
      d.image = '';
      d.qty = new Map();
      clear(wrap);
      const fresh = buildForm(d, settings, null);
      wrap.replaceWith(fresh);
      fresh.querySelector('input')?.focus();
      return;
    }

    import('./products.js').then((m) => m.invalidate());
    navigate('products');
  }

  async function removeProduct() {
    const yes = await confirmDialog({
      title: 'حذف المنتج؟',
      message: `سيُحذف «${d.name || 'هذا المنتج'}» نهائياً من هذا الجهاز. لن تتأثر المبيعات السابقة.`,
      confirmLabel: 'حذف',
      danger: true,
    });
    if (!yes) return;
    await deleteProduct(d.id);
    import('./products.js').then((m) => m.invalidate());
    toast('تم حذف المنتج', 'ok');
    navigate('products');
  }

  return wrap;
}

/* ------------------------------------------------------------------ *
 * Section shell
 * ------------------------------------------------------------------ */

function section(n, title, hint, children) {
  return el(
    'section.form-section',
    {},
    el(
      'div.form-section__head',
      {},
      el('span.form-section__num', { text: String(n) }),
      el('h3', { text: title }),
      hint ? el('span.tiny.muted', { text: hint }) : null
    ),
    ...children
  );
}

export default { render };
