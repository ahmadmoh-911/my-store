/**
 * Application entry point.
 *
 * Responsibilities:
 *   1. register the service worker (offline support)
 *   2. build the persistent chrome (topbar + sidebar footer)
 *   3. optionally seed demo data (opt-in only — a real first run stays empty)
 *   4. start the router and remove the boot splash after its minimum time
 *   5. keep the connectivity indicator in sync
 *   6. remember the install prompt for the Settings screen
 */
import { icon } from './icons.js';
import { el, fromHTML, clear, escapeHTML, wait } from './utils.js';
import { getSettings, listProducts } from './db.js';
import { lowStockProducts } from './analytics.js';
import { seedIfEmpty } from './seed.js';
import { toast, closeTopOverlay } from './components.js';
import { startRouter, renderNav, setLowStockCount, onRoute, navigate, getPath } from './router.js';
import { mountCartBar, cartAffordanceVisible, openCart } from './cart-bar.js';
import { isNative, onNativeBack, minimizeApp } from './native.js';

/* ------------------------------------------------------------------ *
 * Service worker
 * ------------------------------------------------------------------ */

/**
 * How long to wait after a load before asking the browser to look for a new
 * worker. Long enough not to compete with boot, short enough that the owner is
 * not left on yesterday's build.
 */
const SW_UPDATE_AFTER_MS = 3000;

/**
 * Set once the page has reloaded itself into a new worker, so the reload can
 * never become a loop. sessionStorage rather than a module variable because the
 * whole point is to survive the reload it is guarding.
 */
const SW_RELOAD_FLAG = 'saher:sw-reloaded';

function registerServiceWorker() {
  // Inside the Android shell every file is already bundled in the APK, so the
  // cache layer is redundant and a second one only risks serving stale assets.
  if (isNative()) return;
  if (!('serviceWorker' in navigator)) return;

  let reloading = false;

  /**
   * Reload once, and only once, after a new worker takes control.
   *
   * Without this the tab keeps running the document it loaded while the worker
   * underneath it has already swapped caches — the exact "half old, half new"
   * state that leaves a phone on an old version with no visible cause.
   */
  const reloadIntoNewWorker = () => {
    if (reloading) return;
    reloading = true;
    let alreadyReloaded = false;
    try {
      alreadyReloaded = sessionStorage.getItem(SW_RELOAD_FLAG) === '1';
      sessionStorage.setItem(SW_RELOAD_FLAG, '1');
    } catch {
      /* private mode: the flag is a safety net, not a requirement */
    }
    if (alreadyReloaded) return;
    // Reloading on the first claim of a very first visit would throw away the
    // page the owner is looking at for nothing.
    if (!navigator.serviceWorker.controller) return;
    location.reload();
  };

  navigator.serviceWorker.addEventListener('controllerchange', reloadIntoNewWorker);

  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js', {
        // Without this the worker script itself may be served from the HTTP
        // cache, so a redeploy can go unnoticed at the root of the chain.
        updateViaCache: 'none',
      });

      /**
       * Asks the browser to re-fetch sw.js and diff it against the running one.
       *
       * The browser decides whether anything changed — we never force anything.
       * Throttled, because this runs on a phone battery and a rejected network
       * simply means the old build stays, which is the correct offline answer.
       */
      let lastCheck = 0;
      const checkForUpdate = () => {
        const now = Date.now();
        if (now - lastCheck < 60 * 60 * 1000) return;
        lastCheck = now;
        reg.update().catch(() => null);
      };

      // A worker that finished installing while this page was already open.
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            // Take it now rather than on the next cold start: the shop should
            // not need to reopen the app to get the build it already downloaded.
            sw.postMessage('SKIP_WAITING');
          }
        });
      });

      // A worker that installed while the app was closed: adopt it immediately.
      if (reg.waiting && navigator.serviceWorker.controller) {
        reg.waiting.postMessage('SKIP_WAITING');
      }

      checkForUpdate();
      setTimeout(checkForUpdate, SW_UPDATE_AFTER_MS);

      // Coming back to a long-lived tab is the other moment an update is
      // likely waiting — this is the "opened the app again" signal on mobile.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkForUpdate();
      });

      // And after returning from another PWA/tab, where the clock is different.
      window.addEventListener('pageshow', (e) => {
        if (e.persisted) checkForUpdate();
      });
    } catch (err) {
      console.warn('[sw] registration failed', err);
    }
  });
}

/* ------------------------------------------------------------------ *
 * Topbar
 * ------------------------------------------------------------------ */

let currentSettings = null;

function buildTopbar() {
  const bar = document.getElementById('topbar');
  if (!bar) return;

  clear(bar);

  // The brand is decoration, not a link. It looked like a button, so it read
  // as one — tapping the app's own name and being thrown to the dashboard is
  // the kind of thing that makes people tap it twice to see if it broke.
  bar.appendChild(
    el(
      'span.brand',
      { 'aria-hidden': 'true' },
      el('span.brand__mark', { html: icon('hanger') }),
      el('span.brand__name', { text: 'متجري' })
    )
  );

  // The green dot beside the store name says "this device is online and
  // selling" — it is a status light, not a shortcut. Settings has its own
  // button two icons away; turning the status light into a link made the
  // indicator lie about what it was.
  bar.appendChild(
    el(
      'span.store-pill',
      { id: 'store-pill', title: 'حالة الاتصال ونشاط المتجر' },
      el('span.store-pill__dot'),
      el('span.store-pill__name', { id: 'topbar-context', text: '—' })
    )
  );

  const end = el('div.topbar__end');
  end.appendChild(el('span.net-dot', { id: 'net-dot', title: 'متصل' }, el('i')));

  // The storefront button beside the settings gear is the cart's own handle.
  //
  // It used to be a shortcut to the sale screen and nothing else, which is why
  // the cart needed a sixth slot in the bottom bar: the only button near the top
  // of the screen could not be the cart. Now that the cart belongs to the sale
  // screen, this button *is* it there — one tap to the invoice in progress,
  // with or without anything in it. Outside the sale screen there is no cart to
  // open, so the same button goes to the sale screen and says so.
  //
  // It never goes to the dashboard. That is what the brand name and the bottom
  // bar's "الرئيسية" are for, and neither of those is a cart.
  end.appendChild(
    el(
      'button.icon-btn.topbar-cart',
      {
        type: 'button',
        id: 'topbar-cart',
        'aria-label': 'بيع جديد',
        title: 'بيع جديد',
        onClick: onCartButton,
      },
      fromHTML(icon('store')),
      el('span.topbar-cart__badge', { 'aria-hidden': 'true' })
    )
  );
  end.appendChild(
    el(
      'button.icon-btn',
      { type: 'button', 'aria-label': 'الإعدادات', title: 'الإعدادات', onClick: () => navigate('settings') },
      fromHTML(icon('settings'))
    )
  );
  bar.appendChild(end);
}

/**
 * The topbar cart button's one action.
 *
 * Resolved at click time rather than bound at build time, because the cart bar
 * is mounted after the topbar and because whether this button is a cart or a
 * shortcut depends on the current screen.
 */
function onCartButton() {
  if (cartAffordanceVisible()) {
    openCart();
    return;
  }
  navigate('pos');
}

function paintStoreName() {
  const node = document.getElementById('topbar-context');
  if (node && currentSettings) node.textContent = currentSettings.storeName;

  const foot = document.getElementById('sidebar-foot');
  if (foot && currentSettings) {
    clear(foot);
    foot.appendChild(
      el(
        'button.sidebar__store',
        { type: 'button', onClick: () => navigate('settings') },
        currentSettings.logo
          ? el('img', { src: currentSettings.logo, alt: '' })
          : el('span.logo-ph', { html: icon('hanger') }),
        el(
          'div',
          {},
          el('b', { class: 'store-pill__name', text: currentSettings.storeName }),
          el('span', { text: currentSettings.storeTagline || 'إدارة المتجر' })
        )
      )
    );
  }
}

/* ------------------------------------------------------------------ *
 * Connectivity indicator
 * ------------------------------------------------------------------ */

function wireConnectivity() {
  const bar = document.getElementById('offline-bar');
  const dot = document.getElementById('net-dot');

  const sync = () => {
    const on = navigator.onLine;
    if (bar) bar.hidden = on;
    if (dot) {
      dot.classList.toggle('is-off', !on);
      dot.title = on ? 'متصل' : 'غير متصل — التطبيق يعمل محلياً';
    }
  };

  window.addEventListener('online', () => {
    sync();
    toast('عاد الاتصال', 'ok', 1800);
  });
  window.addEventListener('offline', () => {
    sync();
    toast('لا يوجد إنترنت — كل البيانات متاحة محلياً', 'warn', 2600);
  });
  sync();
}

/* ------------------------------------------------------------------ *
 * Install prompt (Android/Chrome/Edge)
 * ------------------------------------------------------------------ */

function wireInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window.__saherInstallPrompt = e;
  });
  window.addEventListener('appinstalled', () => {
    window.__saherInstallPrompt = null;
    toast('تم تثبيت التطبيق', 'ok');
  });
}

/* ------------------------------------------------------------------ *
 * Low-stock badge
 * ------------------------------------------------------------------ */

async function refreshLowStockBadge() {
  try {
    const threshold = currentSettings?.lowStockThreshold ?? 5;
    const products = await listProducts();
    const low = lowStockProducts(products, threshold);
    setLowStockCount(low.length);
  } catch {
    /* badge is cosmetic — never block the UI on it */
  }
}

/* ------------------------------------------------------------------ *
 * Hardware back button (Android)
 * ------------------------------------------------------------------ */

/**
 * WebView has no Escape key, so the physical back button is mapped to the
 * closest equivalent: close the topmost overlay, else walk back through the
 * screens visited in this session, else send the app to the background.
 */
function wireNativeBack() {
  if (!isNative()) return;

  // seeded with the screen already on screen, so the first back press has
  // somewhere to go even before the user has navigated anywhere
  const trail = [getPath()];
  onRoute(() => {
    const path = getPath();
    if (trail[trail.length - 1] !== path) trail.push(path);
  });

  onNativeBack(() => {
    if (closeTopOverlay()) return;

    if (trail.length > 1) {
      trail.pop();
      navigate(trail[trail.length - 1], { replace: true });
      return;
    }

    // already at the start of the session — don't kill the app outright
    minimizeApp();
  });
}

/* ------------------------------------------------------------------ *
 * Global niceties
 * ------------------------------------------------------------------ */

function wireGlobalHandlers() {
  // print → clear the print root afterwards so the DOM never holds a big table
  window.addEventListener('afterprint', () => {
    const root = document.getElementById('print-root');
    if (root) clear(root);
  });

  // block pinch-zoom double-tap on iOS outside form fields
  let lastTouch = 0;
  document.addEventListener(
    'touchend',
    (e) => {
      const now = Date.now();
      if (now - lastTouch < 300 && !e.target.closest('input,textarea,select,[contenteditable]')) {
        e.preventDefault();
      }
      lastTouch = now;
    },
    { passive: false }
  );
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

/**
 * How long the splash is guaranteed to stay on screen.
 *
 * A fast phone used to get a splash that flashed and vanished, which reads as
 * a glitch rather than as an app opening. 2.5s is the floor — if the data is
 * ready earlier the splash simply waits; if it is slower the splash comes
 * down as soon as the screen behind it is actually painted.
 */
const SPLASH_MIN_MS = 2500;

async function boot() {
  const splash = document.getElementById('boot');
  const shell = document.getElementById('shell');
  const openedAt = performance.now();

  try {
    currentSettings = await getSettings();
  } catch (err) {
    console.error('[boot] settings failed', err);
    currentSettings = null;
  }

  // A first run stays genuinely empty — no demo products, no demo sales, no
  // opening balance. The demo catalogue is still available (the test harness
  // and any developer build opt into it explicitly) but it is never what a
  // shop owner sees on their own phone.
  try {
    const result = await seedIfEmpty();
    if (result.seeded) {
      console.info(`[boot] seeded ${result.products} products, ${result.sales} sales, ${result.suppliers} suppliers`);
    }
    currentSettings = await getSettings();
  } catch (err) {
    console.error('[boot] seed failed', err);
  }

  buildTopbar();
  paintStoreName();

  // The cart lives in document.body, outside #view, so a sale in progress
  // survives every navigation. Mounted before the first screen so it is never
  // missing for the opening render.
  const cartBar = mountCartBar();

  // Subscribed BEFORE the router starts, on purpose. The first render is a real
  // screen, and the cart has to hear about it: subscribed afterwards it learns
  // of no route at all, so it believes it is on no screen, the topbar button
  // offers "بيع جديد" while the owner is standing in the sale screen, and the
  // first tap navigates instead of opening the basket.
  onRoute((current) => {
    // `current` is the router's route object ({ path, route, params, order }),
    // not a path string — syncRoute compares against 'pos', so pass the path.
    const path = current?.path || '';
    // Decide whether the cart is on offer at all, and fold its panel away if not.
    cartBar.syncRoute(path);
    getSettings().then((s) => {
      if (s.storeName !== currentSettings?.storeName) {
        currentSettings = s;
        paintStoreName();
      }
      refreshLowStockBadge();
    });
  });

  // render the first screen before revealing the shell so there's no flash
  renderNav('dashboard');
  await startRouter();

  shell.hidden = false;
  // let the first screen paint, then hold the splash for the rest of its time
  await wait(40);
  const remaining = SPLASH_MIN_MS - (performance.now() - openedAt);
  if (remaining > 0) await wait(remaining);
  splash.classList.add('is-done');
  setTimeout(() => splash.remove(), 420);

  wireConnectivity();
  wireInstallPrompt();
  wireGlobalHandlers();
  wireNativeBack();
  refreshLowStockBadge();

  console.info('[saher] ready');
}

/* ------------------------------------------------------------------ *
 * Go
 * ------------------------------------------------------------------ */

registerServiceWorker();
boot().catch((err) => {
  console.error('[boot] fatal', err);
  const splash = document.getElementById('boot');
  if (splash) {
    splash.innerHTML =
      `<div class="boot__name">تعذّر تشغيل التطبيق</div>` +
      `<p style="color:#a08b8f;font-size:13px;max-width:280px;text-align:center;margin-top:6px">${escapeHTML(err.message || String(err))}</p>`;
  }
});
