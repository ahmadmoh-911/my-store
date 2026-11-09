/**
 * lot-pricing — «سعر البيع يتبع الدفعة» (Option A).
 *
 * ── القاعدة التي أقرّها صاحب المتجر ────────────────────────────────────
 * تجديد الكمية بسعر جديد يسجّل دفعة مخزون منفصلة لها سعر بيعها. عند البيع،
 * القطعة تُباع بسعر بيع **الدفعة التي خرجت منها** — القديمة بسعرها القديم
 * والجديدة بسعرها الجديد — لا بسعر المنتج المعروض («آخر سعر»).
 *
 * وإذا استهلكت كمية السطر الواحد أكثر من دفعة بأسعار بيع مختلفة، فالسطر
 * **يُفصَّل إلى سطر لكل سعر**: 3 قطع من دفعة بـ15 + 2 من دفعة بـ18 تصيران
 * سطرين على الفاتورة (3×15 و2×18)، لا سطرًا واحدًا بمتوسط.
 *
 * ── لماذا وحدة نقية مستقلة ────────────────────────────────────────────
 * نفس الحساب يلزم في ثلاثة مواضع: كتابة البيع (`db.createSale`)، معاينة
 * الإجمالي في شاشة التأكيد (`checkout.js`)، واختبارات node بلا DOM. فبدل
 * تكرار المنطق، يعيش هنا مرة واحدة — بلا IndexedDB وبلا DOM — ويستدعيه
 * الجميع. `db.js` يقود به توزيع الدفعات، و`checkout.js` يقوده للمعاينة،
 * فيتطابق المعروض مع المخزَّن إلى الأغورة في الحالة العادية.
 *
 * ── الترتيب ───────────────────────────────────────────────────────────
 * الافتراضي FIFO: الأقدم أولًا (نفس ترتيب `db.getStockBatches`). وإن سمّى
 * المالك دفعة (`preferredLotId`) فهي تُخدَم أولًا بكامل ما فيها ثم يُكمَل
 * الناقص FIFO — تمامًا كما يتوقّع من اختار «بيع من الدفعة الجديدة».
 */

/** دفعتان بسعرين متقاربين إلى هذا الحد تعتبران السعر نفسه (مطابقة lot-picker). */
const SAME_PRICE = 1e-9;

/** الوقت بصيغة عددية للترتيب؛ التاريخ الفاسد يُعتبر الأقدم. */
const lotTime = (b) => {
  const t = new Date(b && b.createdAt).getTime();
  return Number.isFinite(t) ? t : 0;
};

/**
 * الدفعات الموجبة لصنف واحد، الأقدم أولًا. لا تعدّل القائمة الممرَّرة.
 * @param {Array} lots
 * @param {string} productId
 * @param {string} variantKey  "size|color"
 * @returns {Array}
 */
export function lotsOf(lots, productId, variantKey) {
  return (lots || [])
    .filter((b) => b.productId === productId && b.variantKey === variantKey && (Number(b.quantity) || 0) > 0)
    .sort((a, b) => lotTime(a) - lotTime(b));
}

/** same as `lotsOf` but the caller passes size+color separately. */
export const lotsOfVariant = (lots, productId, size, color) =>
  lotsOf(lots, productId, `${size || ''}|${color || ''}`);

/**
 * يوزّع `qty` قطعة على دفعات صنف واحد ويعيد المأخوذات **دون تعديل** الدفعات.
 *
 * @param {Array} lots
 * @param {string} productId
 * @param {string} variantKey  "size|color"
 * @param {number} qty
 * @param {string} [preferredLotId]  الدفعة المختارة (تُخدَم أولًا)
 * @returns {Array<{batchId:string, qty:number, costPrice:number, sellingPrice:number}>}
 * @throws {Error} عند نقص المخزون أو عند معرّف دفعة لا يخصّ هذا الصنف
 */
export function allocateLots(lots, productId, variantKey, qty, preferredLotId) {
  const need = Math.round(Number(qty) || 0);
  if (need <= 0) return [];
  const ordered = lotsOf(lots, productId, variantKey);
  const have = ordered.reduce((t, b) => t + (Number(b.quantity) || 0), 0);
  if (have < need) {
    throw new Error(`Insufficient stock: needed ${need}, only ${have} available`);
  }
  let remaining = need;
  const taken = [];
  const take = (b) => {
    const n = Math.min(Number(b.quantity) || 0, remaining);
    taken.push({ batchId: b.id, qty: n, costPrice: b.costPrice, sellingPrice: b.sellingPrice });
    remaining -= n;
  };
  if (preferredLotId) {
    const pref = ordered.find((b) => b.id === preferredLotId);
    if (!pref) {
      throw new Error(`الدفعة المحددة غير متاحة لهذا المنتج/المقاس (${preferredLotId})`);
    }
    take(pref);
  }
  for (const b of ordered) {
    if (remaining <= 0) break;
    if (preferredLotId && b.id === preferredLotId) continue; // already served first
    take(b);
  }
  return taken;
}

/**
 * يجمّع المأخوذات حسب سعر البيع (بترتيب الظهور: الأقدم أولًا، أو المختارة
 * أولًا). يحافظ على ترتيب الدفعات داخل كل مجموعة.
 *
 * @param {Array<{qty:number, sellingPrice:number}>} takes
 * @returns {Array<{price:number, qty:number, takes:Array}>}
 */
export function groupTakesByPrice(takes) {
  const groups = [];
  for (const t of takes || []) {
    const qty = Math.round(Number(t && t.qty) || 0);
    if (qty <= 0) continue;
    const price = Number(t.sellingPrice) || 0;
    let g = groups.find((x) => Math.abs(x.price - price) < SAME_PRICE);
    if (!g) {
      g = { price, qty: 0, takes: [] };
      groups.push(g);
    }
    g.qty += qty;
    g.takes.push(t);
  }
  return groups;
}

/**
 * يوسّع سطر سلة/فاتورة واحد إلى سطر أو أكثر، واحد لكل سعر بيع دفعة.
 * الحقول الأخرى (الاسم، المقاس، اللون) تُنسخ كما هي. لا يحتفظ بحقل `lotId`:
 * السطر المخزَّن يحمل شكله القديم تمامًا.
 *
 * @param {object} line
 * @param {Array} takes
 * @returns {Array<object>}
 */
export function splitLineByLotPrice(line, takes) {
  return groupTakesByPrice(takes).map((g) => {
    const { lotId, ...rest } = line || {};
    return { ...rest, qty: g.qty, price: g.price };
  });
}

/**
 * أخذات سطر لا يقابل له أي دفعة على الرفّ (بيانات قديمة أو مستوردة): لا توزيع
 * ولا رفض — القطعة تُسعَّر بسعر البيع الذي يحمله المنتج نفسه وتكلفته بتكلفته،
 * تمامًا كما كان قبل وجود الدفعات. تُستعمل في الكتابة (`db.createSale`) وفي
 * المعاينة (`checkout.js` عبر `planItems`) فلا يختلف ما يُعرض عمّا يُخزَّن.
 *
 * `batchId: null` هنا معناه «لم تخرج القطعة من دفعة»: لا يُكتَب في
 * `stockBatchesConsumed`، وعند الإرجاع يسلك الطريق القديم — `refundSale`
 * تُنشئ دفعة جديدة بسعر هذا السطر وترجع الكمية إلى المقاس قطعةً بقطعة.
 *
 * تنبيه: هذه الحالة تخصّ المقاس الذي لا دفعات له أصلًا. أمّا مقاس تقع دفعاته
 * على الرفّ ثم ينقصها المطلوب فهو مرفوض (allocateLots ترمي) — لا يُخمَّن أبدًا.
 *
 * @param {number} qty
 * @param {object|null} product  سجل المنتج إن بقي في القاعدة
 * @param {object} [line]        السطر الأصلي (احتياط لسعر/تكلفة المنتج)
 * @returns {Array<{batchId:null, qty:number, costPrice:number, sellingPrice:number}>}
 */
export function takeWithoutLots(qty, product, line) {
  const n = Math.round(Number(qty) || 0);
  if (n <= 0) return [];
  const p = product || {};
  const pick = (fromProduct, fromLine) => {
    const v = Number(fromProduct);
    return Number.isFinite(v) ? v : Number(fromLine) || 0;
  };
  return [
    {
      batchId: null,
      qty: n,
      costPrice: pick(p.costPrice, line && line.costPrice),
      sellingPrice: pick(p.price, line && line.price),
    },
  ];
}

/**
 * يعاين الفاتورة كاملة من السلة + الدفعات الحالية، بلا أي كتابة:
 * يوزّع كل سطر على دفعاته ويوسّعه بحسب السعر، ثم يعيد السطور الناتجة.
 *
 * `lotsFor(item)` يعيد دفعات الصنف (مثلاً من `db.getStockBatches`). لو تعذّر
 * التوزيع (نقص مخزون، أو دفعة اختفت) يعيد `null` كي يستعمل المستدعي تقديره
 * السابق بدل أن ينكسر.
 *
 * `opts.productOf(item)` (اختياري) يعيد سجل المنتج: سطر لم يقع له أي دفعة
 * يُعاين بسعر المنتج وتكلفته — نفس ما سيسجّله `db.createSale` — بدل أن تسقط
 * المعاينة كلها إلى تقدير قديم. بلا `productOf` يبقى السلوك كما كان.
 *
 * @param {Array<object>} items
 * @param {(item:object)=>Array} lotsFor
 * @param {{productOf?:(item:object)=>object}} [opts]
 * @returns {Array<object>|null}
 */
export function planItems(items, lotsFor, opts) {
  const out = [];
  for (const it of items || []) {
    const lots = lotsFor(it) || [];
    let taken;
    if (!lots.length && opts && typeof opts.productOf === 'function') {
      taken = takeWithoutLots(it.qty, opts.productOf(it), it);
    } else {
      try {
        taken = allocateLots(lots, it.productId, `${it.size || ''}|${it.color || ''}`, it.qty, it.lotId);
      } catch {
        return null;
      }
    }
    out.push(...splitLineByLotPrice(it, taken));
  }
  return out;
}

export default {
  lotsOf,
  lotsOfVariant,
  allocateLots,
  groupTakesByPrice,
  splitLineByLotPrice,
  takeWithoutLots,
  planItems,
};
