/**
 * Hash router + application navigation.
 *
 * Screens are plain modules that export `render(params)` returning a
 * `.screen` element. The router handles the transition between them (a short
 * slide/fade, direction-aware) so every screen feels consistent.
 *
 * Routes are hash-based (`#/products`) so the app works from any static host
 * or sub-folder without server rewrites.
 */
import { icon } from './icons.js';
import { clear, escapeHTML, fromHTML } from './utils.js';
import { stockOf } from './db.js';

import dashboardScreen from './screens/dashboard.js';
import productsScreen from './screens/products.js';
import productFormScreen from './screens/product-form.js';
import posScreen from './screens/pos.js';
import suppliersScreen from './screens/suppliers.js';
import reportsScreen from './screens/reports.js';
import settingsScreen from './screens/settings.js';

/* ------------------------------------------------------------------ *
 * Route table — `order` drives the transition direction (back vs forward)
 * ------------------------------------------------------------------ */
export const ROUTES = [
  { order: 0, match: /^dashboard$/, nav: 'dashboard', screen: dashboardScreen },
  { order: 1, match: /^products$/, nav: 'products', screen: productsScreen },
  { order: 2, match: /^product\/(new|[\w-]+)$/, nav: 'products', screen: productFormScreen },
  { order: 3, match: /^pos(?:\/([\w-]+))?$/, nav: 'pos', screen: posScreen },
  { order: 4, match: /^suppliers$/, nav: 'suppliers', screen: suppliersScreen },
  // The id MUST be captured: the router hands screens `m.slice(1)`, so without
  // the group `params` arrives empty and suppliers.js falls back to the list.
  { order: 5, match: /^supplier\/([\w-]+)$/, nav: 'suppliers', screen: suppliersScreen },
  { order: 6, match: /^reports$/, nav: 'reports', screen: reportsScreen },
  { order: 7, match: /^settings$/, nav: 'settings', screen: settingsScreen },
];

/**
 * Navigation models.
 *
 * The phone is the primary target, so the bottom bar stays short — with
 * "بيع جديد" promoted because it is the action a shop reaches for most.
 *
 * "التقارير" has to be in BOTTOM_NAV, not only in SIDE_NAV: the sidebar is
 * `display: none` below 900px, so a screen listed only there had no navigation
 * at all on the device this app actually runs on. The bar is a flex row of
 * `flex: 1 1 0` items, so it absorbs the extra destination without any
 * layout change.
 */
export const BOTTOM_NAV = [
  { id: 'dashboard', label: 'الرئيسية', icon: 'dashboard', href: '#/dashboard' },
  { id: 'products', label: 'المخزن', icon: 'package', href: '#/products' },
  { id: 'pos', label: 'بيع جديد', icon: 'store', href: '#/pos', primary: true },
  { id: 'suppliers', label: 'الموردون', icon: 'truck', href: '#/suppliers' },
  { id: 'reports', label: 'التقارير', icon: 'chart', href: '#/reports' },
  { id: 'settings', label: 'الإعدادات', icon: 'settings', href: '#/settings' },
];

export const SIDE_NAV = [
  { id: 'products', label: 'المخزن', icon: 'package', href: '#/products' },
  { id: 'pos', label: 'بيع جديد', icon: 'store', href: '#/pos' },
  { id: 'reports', label: 'التقارير', icon: 'chart', href: '#/reports' },
  { id: 'settings', label: 'الإعدادات', icon: 'settings', href: '#/settings' },
];

/** Every destination reachable from the chrome, used for badge/active lookups. */
export const NAV_ITEMS = [...BOTTOM_NAV, ...SIDE_NAV];

const TRANSITION_MS = 170;

let currentRoute = null;      // { path, route, params, order }
let lastOrder = 0;
let lowStockCount = 0;
const listeners = new Set();

export function onRoute(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getPath() {
  return (location.hash || '#/dashboard').replace(/^#\/?/, '').replace(/\/+$/, '');
}

export function getCurrentRoute() {
  return currentRoute;
}

export function navigate(path, { replace = false } = {}) {
  const target = `#/${String(path).replace(/^#?\/?/, '')}`;
  if (location.hash === target) {
    render();
    return;
  }
  if (replace) location.replace(target);
  else location.hash = target;
}

function match(path) {
  for (const r of ROUTES) {
    const m = path.match(r.match);
    if (m) return { route: r, params: m.slice(1) };
  }
  return { route: ROUTES[0], params: [] };
}

/* ------------------------------------------------------------------ *
 * Navigation chrome (sidebar + bottom bar)
 * ------------------------------------------------------------------ */

function buildNavItem(item, activeId) {
  const a = document.createElement('a');
  a.className = 'nav-item' + (item.primary ? ' nav-item--primary' : '') + (item.id === activeId ? ' is-active' : '');
  a.href = item.href;
  a.dataset.nav = item.id;
  a.innerHTML =
    icon(item.icon) +
    `<span>${escapeHTML(item.label)}</span>` +
    (item.id === 'products' && lowStockCount > 0
      ? `<span class="nav-item__badge" title="${lowStockCount} منتج منخفض المخزون">${lowStockCount}</span>`
      : '');
  return a;
}

export function renderNav(activeId) {
  const bottom = document.getElementById('bottomnav');
  const sidebar = document.getElementById('sidebar');
  if (!bottom || !sidebar) return;

  clear(bottom);
  BOTTOM_NAV.forEach((item) => bottom.appendChild(buildNavItem(item, activeId)));

  clear(sidebar);
  sidebar.innerHTML =
    `<a class="sidebar__brand" href="#/dashboard">` +
    `<span class="brand__mark">${icon('hanger')}</span>` +
    `<span class="sidebar__brand-text"><b>متجري</b><span>إدارة متجر الملابس</span></span>` +
    `</a>` +
    `<div class="sidebar__label">القائمة</div>`;
  SIDE_NAV.forEach((item) => sidebar.appendChild(buildNavItem(item, activeId)));

  const foot = document.createElement('div');
  foot.className = 'sidebar__foot';
  foot.id = 'sidebar-foot';
  sidebar.appendChild(foot);
}

/** Refresh the low-stock badge shown on the "المنتجات" nav item. */
export function setLowStockCount(n) {
  lowStockCount = n;
  const active = document.querySelector('.bottomnav .nav-item.is-active')?.dataset.nav;
  renderNav(active || currentRoute?.route.nav || 'dashboard');
}

/* ------------------------------------------------------------------ *
 * Render pipeline
 * ------------------------------------------------------------------ */

async function render() {
  const path = getPath();
  const { route, params } = match(path);

  // never animate out a screen that is being replaced by itself
  const sameScreen = currentRoute && currentRoute.path === path;
  const forward = route.order >= lastOrder;

  const view = document.getElementById('view');
  if (!view) return;

  let next;
  try {
    next = route.screen.render(params);
  } catch (err) {
    console.error('[router] render failed:', err);
    next = document.createElement('div');
    next.className = 'screen';
    next.innerHTML = `<div class="empty"><div class="empty__art">${icon('alert')}</div><h3>تعذّر فتح الشاشة</h3><p>${escapeHTML(err.message || String(err))}</p></div>`;
  }

  // the screen currently on top — during a swap that is the newest child, not
  // the first, so a burst of rapid navigations still fades the right screen
  const old = view.lastElementChild;

  // give the outgoing screen a chance to release charts/timers before it dies
  if (currentRoute && currentRoute.path !== path && currentRoute.route.screen.destroy) {
    try {
      currentRoute.route.screen.destroy();
    } catch (e) {
      console.error('[router] destroy failed', e);
    }
  }

  const swapping = Boolean(old) && !sameScreen;

  // The outgoing screen fades out underneath the incoming one. It is taken out
  // of flow so the new screen can be mounted *immediately* — screens load their
  // data asynchronously and skip painting while they are still detached, so the
  // mount has to happen before any await.
  if (swapping) {
    old.classList.remove('is-entering');
    old.classList.add('is-leaving');
    old.dataset.dir = forward ? 'fwd' : 'back';
    view.classList.add('is-swapping');
  } else {
    clear(view);
  }

  next.classList.add('screen');
  next.dataset.dir = forward ? 'fwd' : 'back';
  next.classList.add('is-entering');
  view.appendChild(next);
  view.scrollTop = 0;
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });

  next.addEventListener(
    'animationend',
    () => next.classList.remove('is-entering'),
    { once: true }
  );

  currentRoute = { path, route, params, order: route.order };
  lastOrder = route.order;
  renderNav(route.nav);
  // POS shows the full cart in its own column, so the sticky bar stands down
  // there and stands up everywhere else.
  document.body.classList.toggle('is-pos', path === 'pos');

  // let the screen know it is live (for chart teardown etc.)
  listeners.forEach((fn) => {
    try {
      fn(currentRoute, old);
    } catch (e) {
      console.error('[router] listener error', e);
    }
  });

  if (swapping) {
    await new Promise((r) => setTimeout(r, TRANSITION_MS - 40));
    // Always drop the screen we were fading out, even if a newer navigation
    // started meanwhile — otherwise every interrupted swap leaks a screen.
    old.remove();
    if (!view.querySelector('.screen.is-leaving')) view.classList.remove('is-swapping');
  }
}

/** Force a re-render of the active screen (after data changes). */
export function refresh() {
  render();
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

export function startRouter() {
  if (!location.hash || location.hash === '#' || location.hash === '#/') {
    history.replaceState(null, '', '#/dashboard');
  }
  window.addEventListener('hashchange', render);
  return render();
}

/** Sets the topbar store pill / title without a full re-render. */
export function setTopbarContext(title, { showBack = false, onBack = null } = {}) {
  const host = document.getElementById('topbar-context');
  if (host) {
    clear(host);
    host.appendChild(document.createTextNode(title));
  }
  const back = document.getElementById('topbar-back');
  if (back) {
    back.hidden = !showBack;
    back.onclick = onBack;
  }
}
