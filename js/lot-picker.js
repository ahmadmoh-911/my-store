/**
 * lot-picker — "من أي دفعة نبيع؟"
 *
 * تجديد الكمية بسعر جديد يسجّل دفعة مخزون منفصلة (كمية + سعر شراء + سعر بيع)،
 * فيصير للمنتج/المقاس الواحد أكثر من سعر بيع على الرف في الوقت نفسه: القطع
 * القديمة بسعرها القديم، والقطع الجديدة بسعرها الجديد. شاشة البيع لا تستطيع
 * أن تخمّن أيهما يريد المالك بيعه، لذلك تُفتح هنا قائمة اختيار صغيرة.
 *
 * القاعدة (قاعدة المالك):
 *   • الافتراضي هو FIFO — الأقدم أولًا — كما كان دائمًا؛
 *   • وبجانبه خيار لكل دفعة متاحة مع سعر بيعها والكمية المتبقية منها؛
 *   • إن اختار المالك دفعة معينة فستهلك منها ما هي عليه ثم يُكمَل الناقص
 *     بالترتيب FIFO داخل db.createSale (يُمرَّر `lotId` مع سطر الفاتورة)،
 *     ولا يُلامس أي شيء إن لم يختر شيئًا.
 *
 * القرار النهائي عن السعر المكتوب على السطر يعود للمستدعي: هذا الملف واجهة
 * فقط — يعرض الدفعات ويعيد الاختيار عبر `onPick`، ولا يقرأ قاعدة البيانات
 * ولا يكتب فيها (الدفعات تمرَّر جاهزة من db.getStockBatches). الدوال
 * الحسابية الصغيرة في الأعلى نقية عمدًا حتى تُختبر في node بلا DOM.
 */
import { icon } from './icons.js';
import { el, fromHTML, clear, numInt, moneyHTML, fmtDate } from './utils.js';
import { openSheet } from './components.js';

/**
 * الدفعات ذات الكمية الموجبة لصنف واحد، الأقدم أولًا — نفس ترتيب FIFO الذي
 * يطبّقه db.js عند البيع. لا تعدّل القائمة الممرَّرة.
 * @param {Array<{quantity:number, createdAt:string}>} lots
 * @returns {Array}
 */
export function fifoOrder(lots) {
  const t = (b) => {
    const d = new Date(b && b.createdAt).getTime();
    return Number.isFinite(d) ? d : 0;
  };
  return [...(lots || [])]
    .filter((b) => (Number(b && b.quantity) || 0) > 0)
    .sort((a, b) => t(a) - t(b));
}

/**
 * أسعار البيع المختلفة الموجودة فعليًا على الرف الآن (بترتيب الأقدم).
 * قائمة فارغة أو بسعر واحد ⇒ لا حاجة لأي اختيار.
 * @param {Array} lots
 * @returns {number[]}
 */
export function distinctSellingPrices(lots) {
  const seen = [];
  for (const b of fifoOrder(lots)) {
    const p = Number(b.sellingPrice) || 0;
    if (!seen.some((v) => Math.abs(v - p) < 1e-9)) seen.push(p);
  }
  return seen;
}

/**
 * هل يستحق هذا الصنف فتح منتقي الدفعات؟ فقط حين يحمل الرف أكثر من سعر بيع
 * واحد — بيع دفعات بسعر واحد لا يحتاج سؤالًا.
 * @param {Array} lots
 * @returns {boolean}
 */
export function needsLotPicker(lots) {
  return distinctSellingPrices(lots).length > 1;
}

/**
 * Opens the batch-choice sheet for one cart line.
 *
 * @param {object} opts
 * @param {string} opts.productId
 * @param {string} [opts.name]        product name (for the sheet header)
 * @param {string} [opts.size]
 * @param {string} [opts.color]
 * @param {number} [opts.qty]         pieces the line wants (display only)
 * @param {Array}  opts.lots          this variant's batches, as
 *                                    db.getStockBatches(productId, variantKey)
 *                                    returns them (already oldest-first, but
 *                                    re-ordered here defensively)
 * @param {Function} opts.onPick      called once with the choice, then the sheet
 *                                    closes:
 *     { mode: 'fifo', price, lot }        → default: oldest lot first; `price`
 *                                           is the OLDEST lot's selling price
 *     { mode: 'lot', lotId, lot, price }  → that exact batch (createSale
 *                                           consumes it first, FIFO after)
 *   Closing the sheet without choosing calls nothing — the caller simply
 *   adds nothing / keeps its previous plan.
 */
export function openLotPicker({ productId, name, size, color, qty, lots, onPick, onClose }) {
  const ordered = fifoOrder(lots);
  if (!ordered.length) return;

  const currency = 'ILS'; // the app is priced in shekels (db.js forces it)
  const variantLabel = [size || 'مقاس واحد', color || 'بدون لون'].filter(Boolean).join(' · ');

  const listHost = el('div.lotpick__list');

  function option({ tag, tagClass, lot, title, onClick }) {
    const remaining = Number(lot.quantity) || 0;
    const price = Number(lot.sellingPrice) || 0;
    return el(
      'button.lotpick__opt',
      { type: 'button', onClick },
      el('span.lotpick__tag' + (tagClass ? '.' + tagClass : ''), { text: tag }),
      el(
        'div.lotpick__main',
        {},
        el('b.truncate', { text: title }),
        el('span.tiny.muted', {
          html: `${moneyHTML(price, currency)} · المتبقي ${numInt(remaining)} قطعة · تكلفة الشراء ${moneyHTML(lot.costPrice, currency)}`,
        })
      ),
      el('span.size-pill', { style: 'height:24px;min-width:auto', text: 'اختيار' })
    );
  }

  function paint() {
    clear(listHost);
    ordered.forEach((lot, i) => {
      const oldest = i === 0;
      const newest = i === ordered.length - 1;
      listHost.appendChild(
        option({
          tag: oldest ? 'FIFO · الأقدم' : newest ? 'الأحدث' : `دفعة ${fmtDate(lot.createdAt)}`,
          tagClass: oldest ? 'lotpick__tag--fifo' : '',
          lot,
          title: oldest
            ? `الأقدم أولًا (FIFO) — سعر ${Number(lot.sellingPrice) || 0}`
            : `دفعة ${fmtDate(lot.createdAt)}`,
          onClick: () =>
            pick(
              oldest
                ? { mode: 'fifo', price: Number(lot.sellingPrice) || 0, lot }
                : { mode: 'lot', lotId: lot.id, lot, price: Number(lot.sellingPrice) || 0 }
            ),
        })
      );
    });
    if ((Number(qty) || 0) > 0) {
      const first = ordered[0];
      const shelf = ordered.reduce((t, b) => t + (Number(b.quantity) || 0), 0);
      listHost.appendChild(
        el('p.tiny.muted', {
          style: 'margin-top:10px',
          text:
            `الكمية المطلوبة: ${numInt(qty)} من ${numInt(shelf)} على الرف. ` +
            (Number(first.quantity) >= Number(qty)
              ? 'الدفعة المختارة تغطيها كلها.'
              : 'إن لم تكفِ الدفعة المختارة يُكمَل الناقص من الدفعات الأقدم تلقائيًا.'),
        })
      );
    }
  }

  const body = el(
    'div.lotpick',
    {},
    el(
      'div.restock__head',
      { style: 'margin-bottom:12px' },
      el(
        'div',
        { style: 'min-width:0' },
        el('b', { style: 'font-size:16px;display:block', text: name || 'منتج' }),
        el('span.tiny.muted', { text: `${variantLabel} — لهذا الصنف أكثر من سعر بيع على الرف` })
      )
    ),
    el(
      'p.tiny.muted',
      { style: 'margin:0 0 12px' },
      fromHTML(icon('info')),
      el('span', { text: ' الافتراضي: الأقدم أولًا. اختر دفعة بعينها لبيعها بسعرها الخاص.' })
    ),
    listHost
  );

  function pick(result) {
    picked = true;
    sheet.close();
    onPick && onPick(result);
  }

  let picked = false;

  const sheet = openSheet({
    title: 'اختيار الدفعة',
    body,
    onClose: () => { if (!picked && onClose) onClose(); },
  });

  paint();
  return sheet;
}
