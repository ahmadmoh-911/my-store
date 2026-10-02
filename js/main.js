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
import { mountCartBar } from './cart-bar.js';
import { isNative, onNativeBack, minimizeApp } from './native.js';

/* ------------------------------------------------------------------ *
 * Service worker
 * ------------------------------------------------------------------ */

function registerServiceWorker() {
  // Inside the Android shell every file is already bundled in the APK, so the
  // cache layer is redundant and a second one only risks serving stale assets.
  if (isNative()) return;
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', async () => {
          // a new build finished installing while the app is open
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('يتوفر تحديث للتطبيق — أعد التشغيل لتطبيقه', 'info', 5200);
          }
        });
      });
    } catch (err) {
      console.warn('[sw] registration failed', err);
    }
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // swallow the extra reload some browsers fire on first SW claim
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
  end.appendChild(
    el(
      'button.icon-btn',
      { type: 'button', 'aria-label': 'بيع جديد', title: 'بيع جديد', onClick: () => navigate('pos') },
      fromHTML(icon('store'))
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

  // The sticky cart bar lives in document.body, outside #view, so a sale in
  // progress survives every navigation. Mounted before the first screen so it
  // is never missing for the opening render.
  const cartBar = mountCartBar();

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

  // keep the store name in the chrome in sync when Settings saves
  onRoute((current) => {
    // `current` is the router's route object ({ path, route, params, order }),
    // not a path string — syncRoute compares against 'pos', so pass the path.
    const path = current?.path || '';
    // fold the cart bar away when leaving POS, and re-check its numbers
    cartBar.syncRoute(path);
    getSettings().then((s) => {
      if (s.storeName !== currentSettings?.storeName) {
        currentSettings = s;
        paintStoreName();
      }
      refreshLowStockBadge();
    });
  });

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
