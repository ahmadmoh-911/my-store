/**
 * Optional demo data for design review and automated tests.
 *
 * OFF by default: a genuine first install must be empty — 0 products, 0 sales,
 * 0 invoices, 0 suppliers, 0 stock, 0 opening balance. Call `enableDemoSeed()`
 * to turn it on for a test harness or a developer preview.
 *
 * Product photos are generated inline as SVG data URLs, so no binary assets
 * are needed and the images stay tiny in storage.
 */
import {
  listProducts, listSales, getSettings, saveSettings, stockOf, put, STORES,
} from './db.js';
import { uid, isoDate, startOfDay, addDays } from './utils.js';

/* ------------------------------------------------------------------ *
 * Image generator — soft gradient plate + garment silhouette
 * ------------------------------------------------------------------ */

const GARMENTS = {
  blazer:
    'M118 150 172 116 200 146 228 116 282 150 300 214 264 232 262 404 138 404 136 232 100 214Z',
  shirt:
    'M124 152 174 120 200 150 226 120 276 152 292 210 258 226 256 400 144 400 142 226 108 210Z',
  dress:
    'M162 124 200 102 238 124 252 192 232 204 274 406 126 406 168 204 148 192Z',
  pants:
    'M150 118 250 118 264 246 242 406 206 406 202 274 198 406 162 406 140 246Z',
  knit:
    'M120 156 172 124 200 152 228 124 280 156 300 226 262 244 258 402 142 402 138 244 100 226Z',
  tee:
    'M116 150 168 122 200 156 232 122 284 150 296 206 262 224 258 398 142 398 138 224 104 206Z',
  skirt:
    'M158 150 242 150 248 196 286 404 114 404 152 196Z',
  coat:
    'M116 154 170 118 200 152 230 118 284 154 302 220 266 238 264 410 136 410 134 238 98 220Z',
  bag:
    'M144 176 256 176 268 404 132 404Z M172 176 a28 44 0 0 1 56 0',
  shoe:
    'M112 300 200 300 246 330 292 344 296 372 118 372Z',
};

const PALETTES = [
  ['#efe3d5', '#dcc9b4'],
  ['#e6e9e2', '#c9d2c4'],
  ['#f0e0dd', '#d9c2be'],
  ['#e3e6ee', '#c6ccdb'],
  ['#efe9dc', '#d6ccb8'],
  ['#e8ded2', '#cbbba7'],
  ['#e4ebe9', '#c4d5d1'],
  ['#f1e7da', '#dccdb8'],
  ['#e9e4ef', '#cec6dd'],
  ['#eceee6', '#d2d6c7'],
];

function garmentSVG({ palette, garment, accent }) {
  const [bg1, bg2] = palette;
  const d = GARMENTS[garment] || GARMENTS.shirt;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500" viewBox="0 0 400 500">` +
    `<defs>` +
    `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${bg1}"/><stop offset="1" stop-color="${bg2}"/>` +
    `</linearGradient>` +
    `<linearGradient id="c" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${accent}" stop-opacity="0.95"/>` +
    `<stop offset="1" stop-color="${accent}" stop-opacity="0.72"/>` +
    `</linearGradient>` +
    `</defs>` +
    `<rect width="400" height="500" fill="url(#g)"/>` +
    // woven texture
    Array.from({ length: 26 }, (_, i) =>
      `<path d="M0 ${i * 20} H400" stroke="#ffffff" stroke-opacity="0.10" stroke-width="1"/>`
    ).join('') +
    Array.from({ length: 20 }, (_, i) =>
      `<path d="M${i * 20} 0 V500" stroke="#000000" stroke-opacity="0.035" stroke-width="1"/>`
    ).join('') +
    // soft vignette circle
    `<circle cx="200" cy="250" r="185" fill="#ffffff" fill-opacity="0.18"/>` +
    // garment
    `<path d="${d}" fill="url(#c)" stroke="#ffffff" stroke-opacity="0.5" stroke-width="3" stroke-linejoin="round"/>` +
    // hanger hint
    `<path d="M200 96 v-16" stroke="#6b1d2f" stroke-opacity="0.35" stroke-width="4" stroke-linecap="round"/>` +
    `</svg>`;

  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/* ------------------------------------------------------------------ *
 * Catalogue
 * ------------------------------------------------------------------ */

const CATALOG = [
  { name: 'بليز كتان مفصل', cat: 'جاكيتات ومعاطف', price: 1280, cost: 640, garment: 'blazer', acc: '#c9b8a4', sizes: ['36', '38', '40'], colors: ['أوف وايت كريمي', 'كحلي'], stock: [12, 9, 11, 7] },
  { name: 'قميص كتان مريح', cat: 'قمصان وبلوزات', price: 690, cost: 330, garment: 'shirt', acc: '#b7c3b0', sizes: ['S', 'M', 'L', 'XL'], colors: ['أبيض ناصع', 'رمادي محايد'], stock: [14, 18, 16, 6] },
  { name: 'بنطال حوض رسمي بكسرات', cat: 'بناطيل', price: 820, cost: 410, garment: 'pants', acc: '#c2b09c', sizes: ['30', '32', '34'], colors: ['كحلي', 'أسود'], stock: [8, 11, 5, 3] },
  { name: 'كارديغان مرينو مضلع', cat: 'قمصان وبلوزات', price: 730, cost: 360, garment: 'knit', acc: '#d9cdbe', sizes: ['XS', 'S', 'M', 'L'], colors: ['أوف وايت كريمي', 'رمادي محايد'], stock: [6, 9, 12, 4] },
  { name: 'معطف ترنش بنم', cat: 'جاكيتات ومعاطف', price: 1580, cost: 820, garment: 'coat', acc: '#8f7d6c', sizes: ['S', 'M', 'L'], colors: ['خشب داكن', 'أسود'], stock: [4, 6, 3] },
  { name: 'مجموعة تيشيرتات قطن عضوي', cat: 'تيشيرتات', price: 410, cost: 175, garment: 'tee', acc: '#cfd6c6', sizes: ['S', 'M', 'L', 'XL'], colors: ['أبيض ناصع', 'أسود'], stock: [22, 26, 19, 12] },
  { name: 'فستان حرير سادة', cat: 'فساتين', price: 790, cost: 380, garment: 'dress', acc: '#1a1a1a', sizes: ['S', 'M'], colors: ['أسود', 'أوف وايت كريمي'], stock: [7, 5] },
  { name: 'قميص كتان استوديو', cat: 'قمصان وبلوزات', price: 540, cost: 255, garment: 'shirt', acc: '#a9b6ad', sizes: ['M', 'L'], colors: ['أبيض ناصع'], stock: [9, 7] },
  { name: 'بنطال شتوي رملي', cat: 'بناطيل', price: 600, cost: 300, garment: 'pants', acc: '#c8b8a3', sizes: ['30', '32'], colors: ['خشب داكن'], stock: [10, 6] },
  { name: 'كارديغان صوف متن', cat: 'قمصان وبلوزات', price: 650, cost: 310, garment: 'knit', acc: '#9aa89b', sizes: ['S', 'L'], colors: ['رمادي محايد'], stock: [5, 3] },
  { name: 'تنورة بليسيه ميدي', cat: 'بناطيل', price: 390, cost: 180, garment: 'skirt', acc: '#363e67', sizes: ['XS', 'S', 'M'], colors: ['كحلي'], stock: [8, 12, 7] },
  { name: 'حقيبة جلد طبيعي', cat: 'أحذية وإكسسوارات', price: 950, cost: 470, garment: 'bag', acc: '#6b4a35', sizes: ['—'], colors: ['خشب داكن'], stock: [5] },
  { name: 'حذاء كلاسيك مخيط', cat: 'أحذية وإكسسوارات', price: 1120, cost: 560, garment: 'shoe', acc: '#4a3a30', sizes: ['40', '41', '42'], colors: ['أسود', 'خشب داكن'], stock: [4, 6, 3] },
  { name: 'بلوزة كتان مطرزة', cat: 'قمصان وبلوزات', price: 480, cost: 230, garment: 'shirt', acc: '#e0d3c2', sizes: ['XS', 'S', 'M'], colors: ['أوف وايت كريمي'], stock: [11, 8, 6] },
];

const SUPPLIERS = [
  { name: 'مصنع الأناقة للملابس', phone: '0551234567', notes: 'قمصان وبلوزات — تسليم أسبوعي', opening: 0 },
  { name: 'أزياء البحر للأقمشة', phone: '0567788990', notes: 'أقمشة مستوردة، الدفع آجل 30 يوم', opening: 2400 },
  { name: 'معارض الشرق التجارية', phone: '0503344556', notes: 'إكسسوارات وأحذية', opening: 0 },
  { name: 'مؤسسة النخبة للألبسة', phone: '0541122334', notes: 'فساتين وجاكيتات', opening: 850 },
];

/** Free-text line items — supplier bills are not tied to product SKUs. */
const SUPPLY_ITEMS = [
  'قمصان قطن — 12 قطعة',
  'فساتين سهرة — 6 قطع',
  'بناطيل جينز — 20 قطعة',
  'تيشيرتات مطبوعة — 40 قطعة',
  'جاكيتات شتوي — 8 قطع',
  'أحذية جلد — 10 أزواج',
  'إكسسوارات متنوعة',
  'أقمشة قطنية — 30 متر',
  'سحّابات وأزرار',
  'عبوات وتغليف',
];

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Opt-in switch for the demo catalogue.
 *
 * A real first install must come up genuinely empty: 0 products, 0 sales,
 * 0 invoices, 0 suppliers, 0 stock, 0 opening balance. A shop owner who
 * installs the app and finds someone else's stock list — and then has to work
 * out how to delete it before entering their own — has been given the wrong
 * app.
 *
 * The demo data itself is not thrown away. It is genuinely useful for design
 * review and for automated tests, so the capability stays and only its
 * default is off: a test harness (or a developer preview build) calls
 * `enableDemoSeed()` before boot, and every other first run gets an empty app.
 */
let demoSeedWanted = false;

export function enableDemoSeed() {
  demoSeedWanted = true;
}

/** True only when something explicitly asked for the demo catalogue. */
export function demoSeedEnabled() {
  return demoSeedWanted;
}

export async function seedIfEmpty() {
  const settings = await getSettings();
  const [products, sales] = await Promise.all([listProducts(), listSales()]);

  if (settings.seeded || products.length || sales.length) {
    if (!settings.seeded) await saveSettings({ seeded: true });
    return { seeded: false, products: products.length };
  }

  // A clean install. Stamp the flag either way so the emptiness check below
  // costs one boolean from here on, and leave every counter at zero.
  if (!demoSeedWanted) {
    await saveSettings({ seeded: true });
    return { seeded: false, products: 0 };
  }

  const now = new Date();
  const colorHex = new Map((settings.colors || []).map((c) => [c.name, c.hex]));

  /* --- products ----------------------------------------------------- */
  const created = [];
  CATALOG.forEach((c, ci) => {
    const variants = [];
    let i = 0;
    for (const color of c.colors) {
      for (const size of c.sizes) {
        variants.push({ size, color, quantity: c.stock[i % c.stock.length] });
        i++;
      }
    }
    // stock spread: bump a few SKUs below the low-stock threshold
    if (ci % 4 === 3) variants[0].quantity = 2;
    if (ci % 5 === 4) variants[0].quantity = 0;

    const p = {
      id: uid(),
      name: c.name,
      sku: `ATL-${1000 + ci * 7}`,
      category: c.cat,
      description: `${c.name} — قصّة مريحة وخامة مختارة بعناية، مناسب للاستخدام اليومي والمناسبات.`,
      price: c.price,
      costPrice: c.cost,
      image: garmentSVG({ palette: PALETTES[ci % PALETTES.length], garment: c.garment, accent: c.acc }),
      variants,
      createdAt: addDays(now, -(14 - ci)).toISOString(),
      updatedAt: addDays(now, -(14 - ci)).toISOString(),
    };
    created.push(p);
  });

  /* --- suppliers: a small purchases ledger ----------------------------- */
  const rand = (n) => Math.floor(Math.random() * n);
  const SUP_PAY = ['cash', 'transfer', 'cheque', 'cash'];

  const suppliers = [];
  for (const sp of SUPPLIERS) {
    const rec = {
      id: uid(),
      name: sp.name,
      phone: sp.phone,
      notes: sp.notes,
      openingBalance: sp.opening,
      createdAt: addDays(now, -55).toISOString(),
      updatedAt: addDays(now, -55).toISOString(),
    };
    suppliers.push(rec);
    await put(STORES.suppliers, rec);
  }

  const supInvoices = [];
  const supPayments = [];

  suppliers.forEach((sp, si) => {
    // A different billing rhythm per supplier, so the list does not look uniform.
    const bills = 2 + (si % 3);
    for (let b = 0; b < bills; b++) {
      const when = addDays(now, -(3 + si * 4 + b * 9));
      const nLines = 1 + ((si + b) % 3);
      const items = [];
      for (let l = 0; l < nLines; l++) {
        const name = SUPPLY_ITEMS[rand(SUPPLY_ITEMS.length)];
        if (items.some((it) => it.name === name)) continue;
        items.push({ name, qty: 5 + rand(40), price: 5 + rand(90) });
      }
      if (!items.length) continue;

      const subtotal = Math.round(items.reduce((t, it) => t + it.qty * it.price, 0));
      const discount = Math.random() < 0.25 ? Math.round(subtotal * 0.03) : 0;
      supInvoices.push({
        id: uid(),
        supplierId: sp.id,
        invoiceNo: `S-${1000 + si * 10 + b}`,
        date: when.toISOString(),
        items,
        subtotal,
        discount,
        total: subtotal - discount,
        note: '',
        createdAt: when.toISOString(),
      });

      // Each bill gets one payment a few days later, sometimes partial, so the
      // remaining balance lands on a mix of owing / settled / in-advance.
      if (Math.random() < 0.78) {
        const payDay = addDays(when, 2 + rand(5));
        const ratio = Math.random() < 0.5 ? 1 : 0.4 + Math.random() * 0.5;
        supPayments.push({
          id: uid(),
          supplierId: sp.id,
          amount: Math.round((subtotal - discount) * ratio),
          method: SUP_PAY[rand(SUP_PAY.length)],
          date: payDay.toISOString(),
          invoiceId: null,
          note: ratio < 1 ? 'دفعة جزئية' : '',
          createdAt: payDay.toISOString(),
        });
      }
    }
  });

  /* --- sales over the last 30 days ------------------------------------ */
  const PAY = ['cash', 'card', 'cash', 'transfer', 'cash', 'card'];
  let seq = 0;
  const saleRecords = [];

  for (let day = 29; day >= 0; day--) {
    const base = startOfDay(addDays(now, -day));
    // weekends (Fri/Sat) are busier, and the trend grows towards today
    const dow = base.getDay();
    const busy = dow === 5 || dow === 6 ? 3 : 2;
    const count = Math.max(1, Math.round((busy + Math.random() * 2) * (1 + (29 - day) / 55)));

    for (let k = 0; k < count; k++) {
      const items = [];
      const nLines = 1 + rand(3);
      for (let l = 0; l < nLines; l++) {
        const p = created[rand(created.length)];
        const v = p.variants[rand(p.variants.length)];
        if (!v || v.quantity <= 0) continue;
        if (items.some((it) => it.productId === p.id && it.size === v.size && it.color === v.color)) continue;
        items.push({
          productId: p.id,
          name: p.name,
          size: v.size,
          color: v.color,
          qty: 1 + rand(2),
          price: p.price,
          costPrice: p.costPrice,
        });
      }
      if (!items.length) continue;

      const subtotal = items.reduce((t, it) => t + it.qty * it.price, 0);
      const hasDiscount = Math.random() < 0.28;
      const discount = hasDiscount ? Math.round((subtotal * (Math.random() < 0.5 ? 5 : 10)) / 100) : 0;

      const when = new Date(base);
      when.setHours(10 + rand(12), rand(60), rand(60), 0);

      seq++;
      saleRecords.push({
        id: uid(),
        receiptNo: `${isoDate(when).replace(/-/g, '')}-${String(seq).padStart(4, '0')}`,
        items,
        subtotal,
        discount,
        discountType: 'percent',
        discountValue: discount ? (discount / subtotal) * 100 : 0,
        total: subtotal - discount,
        paymentMethod: PAY[rand(PAY.length)],
        costTotal: items.reduce((t, it) => t + it.qty * it.costPrice, 0),
        timestamp: when.toISOString(),
        note: '',
      });
    }
  }

  saleRecords.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  /* --- write everything ---------------------------------------------- */
  for (const p of created) await put(STORES.products, p);
  for (const s of saleRecords) await put(STORES.sales, s);
  for (const i of supInvoices) await put(STORES.supplierInvoices, i);
  for (const p of supPayments) await put(STORES.supplierPayments, p);

  await saveSettings({ seeded: true });

  return {
    seeded: true,
    products: created.length,
    sales: saleRecords.length,
    suppliers: suppliers.length,
    supplierInvoices: supInvoices.length,
    supplierPayments: supPayments.length,
  };
}
