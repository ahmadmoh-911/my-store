/**
 * Completing a sale.
 *
 * This used to live inside screens/pos.js, next to the product grid. It does not
 * belong there any more: the basket is shown by the cart panel, which is mounted
 * once in the app shell and is visible on the POS screen only — so the code that
 * turns a basket into a receipt has to be reachable from there too. Importing
 * the POS screen into the shell would drag the whole grid along with it, hence
 * this module.
 *
 * The flow is deliberately three steps and no fewer:
 *
 *   1. ask   — a dialog naming the pieces, the total and the payment method
 *   2. entitlement check — block if licence doesn't allow new sales
 *   3. write — ONE IndexedDB transaction writes the invoice AND decrements the
 *              exact size+colour variants (db.createSale)
 *   4. clear — the basket empties only after that transaction has committed
 *
 * Nothing is written before the user answers, so a stray double tap cannot
 * produce two invoices; and nothing is emptied unless the write succeeded, so a
 * failure cannot cost the owner the sale they were in the middle of.
 */
import { icon } from './icons.js';
import {
  el, fromHTML, clear, moneyHTML, num, fmtDate, dayKeyOf, downloadText,
} from './utils.js';
import { printPage, shareText } from './native.js';
import { createSale, listProducts, listSales, getSettings, variantStock } from './db.js';
import { openModal, confirmDialog, celebrate, toast } from './components.js';
import {
  cart, discount, getPaymentMethod, setPaymentMethod, PAYMENT_METHODS,
  subtotal, discountAmount, grandTotal, totalItems,
  clearCart, setLastSale,
} from './cart-store.js';
import { getEntitlement, getEntitlementMessage, ENTITLEMENT_STATE } from './entitlement.js';

/**
 * One sale at a time.
 *
 * Held from before the confirmation dialog opens until after the receipt is
 * shown — not merely while the write is running. A flag set only at write time
 * would let a second tap land during the dialog and queue a second sale behind
 * it, which is exactly the double invoice the shop would notice first.
 */
let busy = false;

/** True while a checkout is in flight — the UI uses it to disable its button. */
export const isCheckingOut = () => busy;

/**
 * Told about every busy transition.
 *
 * The button that starts a sale cannot disable itself: `confirmAndCompleteSale`
 * sets the flag synchronously, but the caller has already built its button and
 * will not paint again until something tells it to. Without this, the guard that
 * prevents a double invoice is invisible — correct, but the owner still sees a
 * live button under their thumb and no sign that anything is happening.
 */
const busyListeners = new Set();

/** @returns {() => void} unsubscribe */
export function onCheckoutState(fn) {
  busyListeners.add(fn);
  return () => busyListeners.delete(fn);
}

function setBusy(next) {
  if (busy === next) return;
  busy = next;
  for (const fn of busyListeners) {
    try {
      fn(next);
    } catch (e) {
      console.error('[checkout] busy listener failed', e);
    }
  }
}

const paymentLabel = (id) => PAYMENT_METHODS.find((p) => p.id === id)?.label || 'نقداً';

/**
 * Confirm → entitlement check → write → clear → receipt.
 *
 * @returns {Promise<boolean>} whether a sale was actually written
 */
export async function confirmAndCompleteSale() {
  if (busy) return false;

  if (!cart.length) {
    toast('السلة فارغة — أضف منتجاً أولاً', 'warn');
    return false;
  }

  // --- ENTITLEMENT ENFORCEMENT ---
  // This is the single authoritative point where a sale is blocked.
  // The UI may disable buttons, but THIS is the gate that must not be bypassed.
  const entitlement = await getEntitlement();
  if (!entitlement.canSell) {
    const msg = await getEntitlementMessage();
    toast(msg, 'err', 5000);
    // Log for debugging
    console.info('[checkout] Sale blocked by entitlement:', {
      state: entitlement.state,
      canSell: entitlement.canSell,
      licenseStatus: entitlement.license?.status,
      licenseId: entitlement.license?.licenseId,
      authGoogleSub: entitlement.authGoogleSub,
      licenseBoundTo: entitlement.licenseBoundTo,
    });
    return false;
  }
  // --------------------------------

  setBusy(true);
  try {
    const settings = await getSettings();
    const cur = settings.currency;

    /* ---- 1 · ask --------------------------------------------------- */
    const yes = await confirmDialog({
      title: 'تأكيد إتمام البيع',
      message:
        `${totalItems()} قطعة · ${cart.length} صنف\n` +
        `الإجمالي المستحق: ${num(grandTotal())} ${cur}\n` +
        `طريقة الدفع: ${paymentLabel(getPaymentMethod())}`,
      confirmLabel: 'تأكيد البيع',
      cancelLabel: 'رجوع',
    });
    if (!yes) return false;

    /* ---- guard against stock that moved while the basket sat open --- */
    const products = await listProducts();
    const byId = new Map(products.map((p) => [p.id, p]));
    for (const line of cart) {
      const p = byId.get(line.productId);
      const available = p ? variantStock(p, line.size, line.color) : 0;
      if (line.qty > available) {
        toast(`«${line.name}» متاح ${available} فقط`, 'err');
        return false;
      }
    }

    /* ---- 2 · write ------------------------------------------------- */
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
      receiptSeq: await seqForToday(),
    });

    setLastSale(sale);

    await celebrate({
      title: 'تمت عملية البيع',
      sub: `فاتورة ${sale.receiptNo} · ${moneyHTML(sale.total, cur)}`,
      ms: 1400,
    });

    /* ---- 3 · clear — only now, because the sale actually happened ---- */
    clearCart();
    setPaymentMethod('cash');

    // createSale() just rewrote quantities in IndexedDB, so the Inventory
    // screen's module-level cache is stale too — otherwise walking to المخزن
    // after a sale would still show pre-sale stock. A dynamic import, exactly as
    // the POS screen already did, so no static edge (and no import cycle) is
    // introduced between the shell and a screen module.
    import('./screens/products.js').then((m) => m.invalidate()).catch(() => {});

    showReceipt(sale, settings);
    return true;
  } catch (err) {
    // The basket is deliberately left untouched: the sale did not happen, so the
    // pieces the owner picked are still picked. Nothing was half-written either
    // — createSale() writes the invoice and the stock move in one transaction,
    // so it either lands whole or not at all.
    console.error('[checkout] sale failed:', err);
    toast('فشل إتمام البيع: ' + (err.message || err), 'err');
    return false;
  } finally {
    setBusy(false);
  }
}

/** Receipt numbers are sequential within the current day. */
async function seqForToday() {
  const all = await listSales();
  // Both sides use the local day: the stored timestamp is UTC, so comparing it
  // against a UTC "today" would restart the numbering every evening and hand out
  // a number the shop has already used today.
  const day = dayKeyOf(new Date());
  return all.filter((s) => dayKeyOf(s.timestamp) === day).length;
}

/* ------------------------------------------------------------------ *
 * Receipt
 * ------------------------------------------------------------------ */

function receiptEl(sale, settings) {
  const cur = settings.currency;
  const lines = el(
    'div.receipt__lines',
    {},
    ...sale.items.map((it) =>
      el(
        'div.receipt__line',
        {},
        el(
          'div.receipt__line-name',
          {},
          el('b', { text: it.name }),
          el('small', { text: [it.size, it.color].filter(Boolean).join(' · ') || '—' })
        ),
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
        : el('div.receipt__logo', {
            style: 'display:grid;place-items:center;color:#fff',
            html: icon('hanger'),
          }),
      el('div.receipt__store', { text: settings.storeName }),
      el('div.receipt__meta', {
        text: [settings.address, settings.phone].filter(Boolean).join(' · ') || settings.storeTagline,
      }),
      el('div.receipt__meta', { text: `${fmtDate(sale.timestamp, true)}` }),
      el('span.receipt__no', { text: `فاتورة ${sale.receiptNo}` })
    ),
    lines,
    el(
      'div.receipt__totals',
      {},
      el('div.totals__row', {}, el('span', { text: 'المجموع الفرعي' }), el('span', { html: moneyHTML(sale.subtotal, cur) })),
      sale.discount > 0
        ? el(
            'div.totals__row.totals__row--save',
            {},
            el('span', { text: 'الخصم' }),
            el('span', { html: `− ${moneyHTML(sale.discount, cur)}` })
          )
        : null,
      el(
        'div.totals__row',
        { style: 'font-size:16px;font-weight:700;color:var(--ink);padding-top:7px' },
        el('span', { text: 'الإجمالي' }),
        el('span', { html: moneyHTML(sale.total, cur) })
      ),
      el('div.totals__row', {}, el('span', { text: 'طريقة الدفع' }), el('span', { text: paymentLabel(sale.paymentMethod) }))
    ),
    el(
      'div.receipt__foot',
      {},
      el('span', { text: settings.receiptFooter || 'شكراً لتسوقكم معنا' }),
      el('div.receipt__barcode')
    )
  );
}

export function showReceipt(sale, settings) {
  const body = el('div', {}, receiptEl(sale, settings));

  // `m` is captured by the foot handlers, which only ever run after openModal
  // has returned — so the binding is always initialised by the time it is read.
  const m = openModal({
    title: `تمت العملية ${sale.receiptNo}`,
    body,
    onClose: () => {},
    foot: [
      el(
        'button.btn',
        { type: 'button', onClick: () => shareReceipt(sale, settings) },
        fromHTML(icon('share')),
        el('span', { text: 'مشاركة' })
      ),
      el(
        'button.btn.btn--soft',
        { type: 'button', onClick: () => printReceipt(sale, settings) },
        fromHTML(icon('printer')),
        el('span', { text: 'طباعة' })
      ),
      el('button.btn.btn--primary', { type: 'button', text: 'تم', onClick: () => m.close() }),
    ],
  });
  return m;
}

function receiptText(sale, settings) {
  const cur = settings.currency;
  const L = [];
  L.push(settings.storeName);
  L.push(`فاتورة: ${sale.receiptNo}`);
  L.push(`التاريخ: ${fmtDate(sale.timestamp, true)}`);
  L.push('--------------------------------');
  for (const it of sale.items) {
    L.push(`${it.name}`);
    L.push(
      `  ${[it.size, it.color].filter(Boolean).join(' · ')}  ` +
        `${it.qty} × ${num(it.price)} = ${num(it.qty * it.price)} ${cur}`
    );
  }
  L.push('--------------------------------');
  L.push(`المجموع الفرعي: ${num(sale.subtotal)} ${cur}`);
  if (sale.discount > 0) L.push(`الخصم: -${num(sale.discount)} ${cur}`);
  L.push(`الإجمالي: ${num(sale.total)} ${cur}`);
  L.push(`الدفع: ${paymentLabel(sale.paymentMethod)}`);
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
  if (!root) return;
  clear(root);
  const wrap = el('div', { style: 'max-width:340px;margin:0 auto' });
  wrap.appendChild(receiptEl(sale, settings));
  root.appendChild(wrap);
  setTimeout(() => printPage().catch((err) => console.warn('[print] failed', err)), 60);
}

/** The three figures the cart panel and the confirmation both quote. */
export const cartTotals = () => ({
  sub: subtotal(),
  disc: discountAmount(),
  grand: grandTotal(),
});

export default { confirmAndCompleteSale, showReceipt, isCheckingOut, onCheckoutState, cartTotals };