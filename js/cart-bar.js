/**
 * The sticky cart bar.
 *
 * A thin bar pinned to the bottom of the window on every screen, so a sale in
 * progress is never more than one tap away and never has to be scrolled back
 * to. It stays collapsed by default, peeks open the moment something is added,
 * and collapses again when the user moves to another screen. Tapping it opens
 * the full basket.
 *
 * It is mounted once into document.body, outside the router's #view, because
 * #view is replaced wholesale on every navigation — a bar that lived inside a
 * screen would be destroyed each time the user moved.
 *
 * State comes from ../cart-store.js, which the POS screen also writes to, so
 * the two views cannot disagree about the total.
 */
import { el, fromHTML, clear, moneyHTML } from './utils.js';
import { icon } from './icons.js';
import { toast, confirmDialog } from './components.js';
import { getSettings } from './db.js';
import { navigate } from './router.js';
import {
  cart, subtotal, discountAmount, grandTotal, totalItems,
  setQty, removeLine, clearCart, subscribe, emit,
} from './cart-store.js';

let currency = 'ILS';
let currencyLoaded = false;

/** 'collapsed' | 'open' */
let open = false;
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

/* ------------------------------------------------------------------ *
 * Line list — shared by the collapsed peek and the open panel
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
      )
    ),
    el(
      'div.cb-line__ctrl',
      {},
      el('button.cb-qty', {
        type: 'button',
        'aria-label': 'إنقاص',
        disabled: line.qty <= 1 ? '' : null,
        onClick: () => setQty(line.key, line.qty - 1),
      }, fromHTML(icon('minus'))),
      el('span.cb-qty__n', { text: String(line.qty) }),
      el('button.cb-qty', {
        type: 'button',
        'aria-label': 'زيادة',
        disabled: atMax ? '' : null,
        onClick: () => setQty(line.key, line.qty + 1),
      }, fromHTML(icon('plus'))),
      el('div.cb-line__sum', { html: moneyHTML(line.qty * line.price, currency) }),
      el('button.cb-line__x', {
        type: 'button',
        'aria-label': 'حذف',
        onClick: () => removeLine(line.key),
      }, fromHTML(icon('x')))
    )
  );
}

function totals() {
  const sub = subtotal();
  const disc = discountAmount();
  const kids = [el('div.cb-tot', {}, el('span', { text: 'المجموع' }), el('span', { html: moneyHTML(sub, currency) }))];
  if (disc > 0.004) {
    kids.push(el('div.cb-tot.cb-tot--off', {}, el('span', { text: 'الخصم' }), el('span', { html: `-${moneyHTML(disc, currency)}` })));
  }
  kids.push(el('div.cb-tot.cb-tot--grand', {}, el('span', { text: 'الإجمالي' }), el('span', { html: moneyHTML(grandTotal(), currency) })));
  return el('div.cb-totals', {}, ...kids);
}

/* ------------------------------------------------------------------ *
 * Paint
 * ------------------------------------------------------------------ */

function paintPanel() {
  if (!panel) return;
  clear(panel);

  if (!cart.length) {
    panel.appendChild(
      el(
        'div.cb-empty',
        {},
        fromHTML(icon('cart')),
        el('p', { text: 'السلة فارغة' }),
        el('button.btn.btn--soft', { type: 'button', onClick: () => { setOpen(false); navigate('pos'); } },
          fromHTML(icon('plus')), el('span', { text: 'ابدأ بيعاً' }))
      )
    );
    return;
  }

  const list = el('div.cb-lines', {}, ...cart.map(lineRow));
  panel.appendChild(list);
  panel.appendChild(totals());
  panel.appendChild(
    el(
      'div.cb-actions',
      {},
      el('button.btn.btn--ghost', { type: 'button', onClick: onEmpty }, fromHTML(icon('trash')), el('span', { text: 'تفريغ' })),
      el('button.btn.btn--primary.cb-checkout', { type: 'button', onClick: onCheckout },
        fromHTML(icon('checkCircle')), el('span', { text: 'إتمام البيع' }))
    )
  );
}

function paintBar() {
  if (!bar) return;
  const count = totalItems();
  const empty = count === 0;

  // An empty cart has nothing worth a permanent strip of screen.
  bar.classList.toggle('is-hidden', empty);
  document.body.classList.toggle('has-cartbar', !empty);
  const showPanel = open && !empty;
  panel.classList.toggle('is-open', showPanel);
  scrim.classList.toggle('is-on', showPanel);

  if (empty) {
    if (open) setOpen(false);
    return;
  }

  clear(bar);
  bar.appendChild(
    el(
      'button.cb-peek',
      { type: 'button', 'aria-expanded': open ? 'true' : 'false', onClick: () => setOpen(!open) },
      el('span.cb-peek__badge', { text: String(count) }),
      el('span.cb-peek__label', { text: open ? 'إخفاء السلة' : 'عرض السلة' }),
      el('span.cb-peek__total', { html: moneyHTML(grandTotal(), currency) }),
      el('span.cb-peek__chev', {}, fromHTML(icon(open ? 'chevronDown' : 'chevronUp')))
    )
  );

  paintPanel();
}

/* ------------------------------------------------------------------ *
 * Behaviour
 * ------------------------------------------------------------------ */

function setOpen(next) {
  if (open === next) return;
  open = next;
  paintBar();
}

/**
 * Called after the cart changes. `added` distinguishes "the user just added
 * something" (peek the basket open so the addition is visible) from a plain
 * edit (leave it as the user left it).
 */
function onCartChange(added) {
  if (added && cart.length) {
    setOpen(true);
    clearTimeout(peekTimer);
    // fall back to collapsed so the bar is not covering the screen by default
    peekTimer = setTimeout(() => setOpen(false), 2600);
  }
  paintBar();
}

function onEmpty() {
  confirmDialog({
    title: 'تفريغ السلة',
    message: 'سيتم حذف كل الأصناف من السلة الحالية.',
    confirmLabel: 'تفريغ',
    danger: true,
  }).then((ok) => {
    if (ok) clearCart();
  });
}

function onCheckout() {
  setOpen(false);
  navigate('pos');
}

/** Keeps the bar in step with the router: collapsed elsewhere, openable anywhere. */
export function syncRoute(path) {
  currentPath = path || currentPath;
  if (!cart.length) {
    setOpen(false);
    return;
  }
  // Moving to another screen folds the bar away; on POS it stays as it is,
  // because the full cart column is already on screen there.
  if (currentPath !== 'pos') setOpen(false);
  paintBar();
}

/* ------------------------------------------------------------------ *
 * Mount
 * ------------------------------------------------------------------ */

export function mountCartBar() {
  if (bar) return;
  loadCurrency();

  panel = el('div.cb-panel', { id: 'cart-panel' });
  bar = el('div.cb-bar', { id: 'cart-bar' });
  scrim = el('div.cb-scrim', { id: 'cart-scrim', onClick: () => setOpen(false) });
  document.body.append(scrim, panel, bar);

  // One subscription for everything: an 'added' peeks the basket open, any
  // other edit just repaints. Guarded by emit() so one bad frame cannot leave
  // the bar half-painted.
  subscribe((reason) => onCartChange(reason === 'added'));

  paintBar();
  return { syncRoute, open: () => setOpen(true), close: () => setOpen(false) };
}

export default { mountCartBar, syncRoute };
