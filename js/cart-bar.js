/**
 * The cart.
 *
 * One floating bar plus one panel, mounted once into document.body outside the
 * router's #view (which is replaced wholesale on every navigation, so a cart
 * that lived inside a screen would be destroyed each time the user moved).
 *
 * ── Where it is allowed to appear ────────────────────────────────────────
 * The basket is a sale instrument, so it belongs to the sale screen and only
 * the sale screen. `body.is-pos` is the single switch: on POS the bar peeks and
 * the topbar button carries a count, everywhere else none of it is drawn. What
 * is inside it is untouched by that — moving to the dashboard and back returns
 * to the same sale, because the state lives in cart-store.js and navigating
 * never empties it.
 *
 * ── What the panel is ────────────────────────────────────────────────────
 * The panel IS the "الطلب الحالي". There used to be a second copy of it — a
 * column on the POS screen — and two copies of the same list means two
 * quantities, two totals and two checkout buttons that can disagree with each
 * other. Everything the old column showed lives here now: the pieces with their
 * size and colour, the quantity stepper, the unit price, the line total, the
 * discount, the payment method and the button that finishes the sale.
 *
 * State comes from cart-store.js, which is the single source of truth; the POS
 * screen writes to the same store when a product is tapped.
 */
import { el, fromHTML, clear, moneyHTML, num, debounce, nudge } from './utils.js';
import { icon } from './icons.js';
import { confirmDialog } from './components.js';
import { getSettings } from './db.js';
import { confirmAndCompleteSale, isCheckingOut, onCheckoutState } from './checkout.js';
import {
  cart, discount, subtotal, discountAmount, grandTotal, totalItems,
  setQty, removeLine, clearCart, subscribe,
  getPaymentMethod, setPaymentMethod, PAYMENT_METHODS,
  isPanelOpen, setPanelOpen, setDiscount,
} from './cart-store.js';

let currency = 'ILS';
let currencyLoaded = false;

let currentPath = '';

let bar = null;
let panel = null;
let scrim = null;
let peekTimer = null;

async function loadCurrency() {
  if (currencyLoaded) return;
  currencyLoaded = true;
  try {
    currency = (await getSettings()).currency || 'ILS';
  } catch {
    // settings are not reachable yet — the default is fine, and the next
    // subscribe() repaint will correct it
    currencyLoaded = false;
  }
}

/** The cart is a sale-screen instrument, so it only exists on the sale screen. */
function isPosPath(path = currentPath) {
  const head = String(path || '').replace(/^[#/]+/, '').split('/')[0];
  return head === 'pos';
}

/* ------------------------------------------------------------------ *
 * Line list
 * ------------------------------------------------------------------ */

function lineRow(line) {
  const atMax = Number(line.max) > 0 && line.qty >= Number(line.max);

  return el(
    'div.cb-line',
    {},
    line.image
      ? el('img.cb-line__img', { src: line.image, alt: '', loading: 'lazy' })
      : el('span.cb-line__img.cb-line__img--none', {}, fromHTML(icon('box'))),
    el(
      'div.cb-line__main',
      {},
      el('div.cb-line__name.truncate', { text: line.name }),
      el(
        'div.cb-line__meta',
        {},
        line.size ? el('span.size-pill', { style: 'height:20px;min-width:auto;font-size:10px', text: line.size }) : null,
        line.color ? el('span', { text: line.color }) : null
      ),
      // The unit price sits under the name rather than in the totals: the owner
      // checks it per piece while counting, and a number that is only visible
      // after the eye has travelled to the right edge is a number nobody reads.
      el('div.cb-line__unit', { html: `${icon('tag')} ${moneyHTML(line.price, currency)} / للقطعة` })
    ),
    el(
      'div.cb-line__ctrl',
      {},
      el(
        'div.cb-qty-group',
        {},
        el('button.cb-qty', {
          type: 'button',
          'aria-label': `إنقاص ${line.name}`,
          disabled: line.qty <= 1 ? '' : null,
          onClick: () => { setQty(line.key, line.qty - 1); nudge(panel.querySelector('.cb-tot--grand')); },
        }, fromHTML(icon('minus'))),
        el('span.cb-qty__n', { text: String(line.qty) }),
        el('button.cb-qty', {
          type: 'button',
          'aria-label': `زيادة ${line.name}`,
          disabled: atMax ? '' : null,
          onClick: () => { setQty(line.key, line.qty + 1); nudge(panel.querySelector('.cb-tot--grand')); },
        }, fromHTML(icon('plus')))
      ),
      el('div.cb-line__sum', { html: moneyHTML(line.qty * line.price, currency) }),
      el('button.cb-line__x', {
        type: 'button',
        'aria-label': `حذف ${line.name}`,
        title: 'حذف الصنف',
        onClick: () => onRemoveLine(line),
      }, fromHTML(icon('trash')))
    )
  );
}

/**
 * Removing a line is destructive and easy to mis-tap on a phone, so — unlike a
 * quantity change, which is trivially undoable by tapping + again — it asks.
 */
function onRemoveLine(line) {
  confirmDialog({
    title: 'حذف الصنف؟',
    message: `سيتم حذف «${line.name}» من الطلب الحالي.`,
    confirmLabel: 'حذف',
    cancelLabel: 'رجوع',
    danger: true,
  }).then((ok) => {
    if (ok) removeLine(line.key);
  });
}

/* ------------------------------------------------------------------ *
 * Discount + payment + totals
 * ------------------------------------------------------------------ */

/**
 * The discount box.
 *
 * Rebuilt on every repaint, which would steal focus mid-typing, so the caret is
 * put back where it was. Values are clamped by setDiscount(): a negative
 * discount is not a surcharge and a percentage over 100 is not a negative total,
 * so both are refused here rather than showing up as a strange invoice later.
 */
function discountRow() {
  const isPct = discount.type === 'percent';

  return el(
    'div.promo-input.cb-discount',
    {},
    fromHTML(icon('percent')),
    el('input', {
      type: 'number',
      min: '0',
      inputmode: 'decimal',
      step: isPct ? '1' : '0.5',
      'aria-label': isPct ? 'نسبة الخصم' : 'مبلغ الخصم',
      placeholder: isPct ? 'نسبة %' : 'مبلغ خصم',
      value: discount.value || '',
      oninput: debounce((e) => {
        const raw = e.target.value;
        const v = parseFloat(raw);
        setDiscount(discount.type, Number.isFinite(v) ? v : 0);
        // A rejected value is shown as rejected: the box is emptied rather than
        // left holding a number the totals do not agree with.
        if (!Number.isFinite(v) || v < 0) e.target.value = '';
        paintBar();
        const inp = panel.querySelector('.cb-discount input');
        if (inp) {
          inp.focus({ preventScroll: true });
          try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch { /* type=number */ }
        }
      }, 220),
    }),
    el(
      'div.seg',
      {},
      el('button', {
        type: 'button',
        text: currency,
        'aria-pressed': isPct ? 'false' : 'true',
        class: isPct ? '' : 'is-active',
        onClick: () => { setDiscount('fixed', discount.value); paintBar(); },
      }),
      el('button', {
        type: 'button',
        text: '%',
        'aria-pressed': isPct ? 'true' : 'false',
        class: isPct ? 'is-active' : '',
        onClick: () => { setDiscount('percent', discount.value); paintBar(); },
      })
    )
  );
}

function paymentRow() {
  return el(
    'div.cb-pay',
    { role: 'group', 'aria-label': 'طريقة الدفع' },
    ...PAYMENT_METHODS.map((p) =>
      el(`button.pay-method${getPaymentMethod() === p.id ? '.is-on' : ''}`, {
        type: 'button',
        'aria-pressed': getPaymentMethod() === p.id ? 'true' : 'false',
        text: p.label,
        onClick: () => { setPaymentMethod(p.id); paintBar(); },
      })
    )
  );
}

function totals() {
  const sub = subtotal();
  const disc = discountAmount();
  const kids = [
    el('div.cb-tot', {}, el('span', { text: 'المجموع الفرعي' }), el('span', { html: moneyHTML(sub, currency) })),
  ];
  if (disc > 0.004) {
    kids.push(el('div.cb-tot.cb-tot--off', {}, el('span', { text: `الخصم${discount.type === 'percent' ? ` (${num(discount.value)}%)` : ''}` }), el('span', { html: `−${moneyHTML(disc, currency)}` })));
  }
  kids.push(discountRow());
  kids.push(el('div.cb-tot.cb-tot--grand', {}, el('span', { text: 'الإجمالي النهائي' }), el('span', { html: moneyHTML(grandTotal(), currency) })));
  return el('div.cb-totals', {}, ...kids);
}

/* ------------------------------------------------------------------ *
 * Paint
 * ------------------------------------------------------------------ */

function paintPanel() {
  if (!panel) return;

  const head = el(
    'div.cb-head',
    {},
    el(
      'div.cb-head__title',
      {},
      fromHTML(icon('cart')),
      el('span', { text: 'الطلب الحالي' }),
      cart.length ? el('span.cb-head__count', { text: `${totalItems()} قطعة` }) : null
    ),
    el('button.cb-head__x', {
      type: 'button',
      'aria-label': 'إغلاق السلة',
      onClick: () => setOpen(false),
    }, fromHTML(icon('x')))
  );

  clear(panel);
  panel.appendChild(head);

  if (!cart.length) {
    panel.appendChild(
      el(
        'div.cb-empty',
        {},
        fromHTML(icon('cart')),
        el('p', { text: 'السلة فارغة' }),
        el('button.btn.btn--soft', { type: 'button', onClick: () => setOpen(false) },
          fromHTML(icon('plus')), el('span', { text: 'ابدأ بيعاً' }))
      )
    );
    return;
  }

  panel.appendChild(el('div.cb-lines', {}, ...cart.map(lineRow)));
  panel.appendChild(totals());
  panel.appendChild(paymentRow());
  // Disabled while a sale is being written, so the button cannot be pressed a
  // second time from a second finger, a second repaint, or an impatient double
  // tap. The guard in checkout.js is the real one; this is what the owner sees.
  const busy = isCheckingOut();
  panel.appendChild(
    el(
      'div.cb-actions',
      {},
      el('button.btn.btn--ghost', { type: 'button', disabled: busy ? '' : null, onClick: onEmpty }, fromHTML(icon('trash')), el('span', { text: 'تفريغ' })),
      el(
        'button.btn.btn--primary.cb-checkout',
        { type: 'button', disabled: busy ? '' : null, onClick: onCheckout },
        fromHTML(icon('receipt')),
        el('span', { text: busy ? 'جارٍ الحفظ…' : 'إتمام البيع' }),
        el('b', { html: moneyHTML(grandTotal(), currency) })
      )
    )
  );
}

function paintBar() {
  if (!bar) return;
  const onPos = isPosPath();
  const count = totalItems();
  const empty = count === 0;

  // Outside the sale screen nothing of the cart is drawn — not the bar, not the
  // panel, not the count on the topbar button. The contents themselves are
  // untouched, so coming back to POS restores the sale exactly as it was.
  const shown = onPos && !empty;
  bar.classList.toggle('is-hidden', !shown);
  document.body.classList.toggle('has-cartbar', shown);

  // Hidden means unreachable, and that has to hold even when the hide/show
  // transition does not run to completion — an interrupted or throttled
  // transition leaves the bar translated down across the bottom nav, still
  // laid out and still clickable, which silently kills the navigation until
  // the next reload. `inert` is not animated, so it applies the moment the
  // class flips: the subtree leaves hit-testing and the tab order at once.
  if (shown) bar.removeAttribute('inert');
  else bar.setAttribute('inert', '');

  const showPanel = onPos && isPanelOpen();
  panel.classList.toggle('is-open', showPanel);
  scrim.classList.toggle('is-on', showPanel);

  if (shown) {
    clear(bar);
    bar.appendChild(
      el(
        'button.cb-peek',
        {
          type: 'button',
          'aria-expanded': showPanel ? 'true' : 'false',
          'aria-label': 'عرض السلة',
          onClick: () => setOpen(!showPanel),
        },
        el('span.cb-peek__badge', { text: String(count) }),
        el('span.cb-peek__label', { text: showPanel ? 'إخفاء السلة' : 'عرض السلة' }),
        el('span.cb-peek__total', { html: moneyHTML(grandTotal(), currency) }),
        el('span.cb-peek__chev', {}, fromHTML(icon(showPanel ? 'chevronDown' : 'chevronUp')))
      )
    );
  }

  paintPanel();
  syncChrome(onPos, count);
}

/**
 * The topbar button doubles as the cart's own handle, so it has to say what it
 * currently does. On POS it is "السلة" and wears the count; everywhere else it is
 * "بيع جديد" and takes you to the sale screen — the same control, honest about
 * which of the two it is doing right now.
 */
function syncChrome(onPos = isPosPath(), count = totalItems()) {
  const btn = document.getElementById('topbar-cart');
  if (!btn) return;
  const badge = btn.querySelector('.topbar-cart__badge');
  const label = onPos ? 'السلة' : 'بيع جديد';
  btn.setAttribute('aria-label', onPos && count ? `السلة — ${count} قطعة` : label);
  btn.title = label;
  btn.dataset.mode = onPos ? 'cart' : 'new-sale';
  if (badge) {
    badge.textContent = String(count);
    // Only inside the sale screen: a cart count hanging off the header on the
    // dashboard would be a cart icon outside the sale screen.
    badge.classList.toggle('is-on', onPos && count > 0);
  }
}

/* ------------------------------------------------------------------ *
 * Behaviour
 * ------------------------------------------------------------------ */

function setOpen(next) {
  clearTimeout(peekTimer);
  peekTimer = null;
  setPanelOpen(next);
}

/**
 * Called after the cart changes. `added` distinguishes "the user just added
 * something" (open the basket briefly so the addition is visible, then fold it
 * back) from a plain edit (leave it as the user left it).
 */
function onCartChange(reason) {
  if (reason === 'added' && cart.length) {
    setOpen(true);
    // fall back to collapsed so the panel is not covering the screen by default
    peekTimer = setTimeout(() => setPanelOpen(false), 2600);
  }
  paintBar();
}

function onEmpty() {
  confirmDialog({
    title: 'تفريغ السلة',
    message: 'سيتم حذف كل الأصناف من الطلب الحالي.',
    confirmLabel: 'تفريغ',
    cancelLabel: 'رجوع',
    danger: true,
  }).then((ok) => {
    if (ok) clearCart();
  });
}

/**
 * Hands over to the checkout, which asks for confirmation before it writes
 * anything. The panel is left open behind the dialog so cancelling returns to
 * the basket the owner was looking at, untouched.
 */
async function onCheckout() {
  if (isCheckingOut()) return;
  const done = await confirmAndCompleteSale();
  // Repaint on the way out whichever way it went: on success clearCart() already
  // repainted, on cancel the button must come back looking pressable.
  paintBar();
  return done;
}

/**
 * Keeps the cart in step with the router.
 *
 * Leaving the sale screen folds the basket away — the panel cannot stay open over
 * a screen it does not belong to — but the basket itself is left alone. Nothing
 * here empties the cart, and that is the point: walking to check a product's
 * price mid-sale and coming back must not cost the sale.
 */
export function syncRoute(path) {
  currentPath = path || currentPath;
  if (!isPosPath()) {
    clearTimeout(peekTimer);
    peekTimer = null;
    setPanelOpen(false);
  }
  paintBar();
}

/* ------------------------------------------------------------------ *
 * The topbar handle
 * ------------------------------------------------------------------ */

/** True on the sale screen — the only place the cart is on offer. */
export function cartAffordanceVisible() {
  return isPosPath();
}

/** Opens the basket panel. Works when empty: the panel shows the empty state. */
export function openCart() {
  if (!bar) return false;
  setOpen(true);
  paintBar();
  return true;
}

/* ------------------------------------------------------------------ *
 * Mount
 * ------------------------------------------------------------------ */

export function mountCartBar() {
  if (bar) return { syncRoute, openCart, close: () => setOpen(false), mounted: true };
  loadCurrency();

  panel = el('div.cb-panel', { id: 'cart-panel' });
  bar = el('div.cb-bar', { id: 'cart-bar' });
  scrim = el('div.cb-scrim', { id: 'cart-scrim', onClick: () => setOpen(false) });
  document.body.append(scrim, panel, bar);

  // One subscription for everything: an 'added' peeks the basket open, any
  // other edit just repaints. Guarded by emit() so one bad frame cannot leave
  // the bar half-painted.
  subscribe((reason) => onCartChange(reason));

  // Repaint on every busy transition, so the checkout button greys out for as
  // long as the sale is being written. The flag itself lives in checkout.js and
  // is set before this listener could possibly run.
  onCheckoutState(() => paintBar());

  paintBar();
  return { syncRoute, openCart, close: () => setOpen(false), mounted: true };
}

export default { mountCartBar, syncRoute, openCart, cartAffordanceVisible, isCheckingOut };