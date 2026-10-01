/* ==========================================================================
   Service worker for the Saher PWA
   --------------------------------------------------------------------------
   Caching strategy
   ---------------
   * INSTALL  → precache every static asset (shell, css, js, fonts, icons,
                chart library). After this step the app runs with no network.
   * FETCH    → navigations use network-first (so a redeployed shell is picked
                up when online) with a cache fallback to index.html; every
                other same-origin request is served cache-first, with a
                background refresh (stale-while-revalidate) so edits to assets
                land on the next load without ever blocking the UI.
   * ACTIVATE → drop caches from older versions.

   Bump VERSION whenever any precached file changes, otherwise clients keep
   the old copy until you do.
   ========================================================================== */

const VERSION = 'v10';
const CACHE = `saher-${VERSION}`;

/* Everything the app needs to boot offline. Keep in sync with /js /css /fonts. */
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',

  './css/tokens.css',
  './css/base.css',
  './css/components.css',
  './css/screens.css',

  './js/main.js',
  './js/icons.js',
  './js/utils.js',
  './js/db.js',
  './js/seed.js',
  './js/components.js',
  './js/router.js',
  './js/charts.js',
  './js/analytics.js',
  './js/native.js',
  './js/scanner.js',
  './js/cart-store.js',
  './js/cart-bar.js',
  './js/invoice-sheet.js',
  './js/stock-sheet.js',
  './vendor/html5-qrcode.min.js',
  './js/screens/dashboard.js',
  './js/screens/products.js',
  './js/screens/product-form.js',
  './js/screens/pos.js',
  './js/screens/suppliers.js',
  './js/screens/reports.js',
  './js/screens/settings.js',

  './vendor/chart.umd.js',

  './fonts/fonts.css',
  './fonts/cairo-arabic-400-normal.woff2',
  './fonts/cairo-arabic-500-normal.woff2',
  './fonts/cairo-arabic-600-normal.woff2',
  './fonts/cairo-arabic-700-normal.woff2',
  './fonts/cairo-latin-400-normal.woff2',
  './fonts/cairo-latin-500-normal.woff2',
  './fonts/cairo-latin-600-normal.woff2',
  './fonts/cairo-latin-700-normal.woff2',
  './fonts/ibm-plex-sans-arabic-arabic-400-normal.woff2',
  './fonts/ibm-plex-sans-arabic-arabic-500-normal.woff2',
  './fonts/ibm-plex-sans-arabic-arabic-600-normal.woff2',
  './fonts/ibm-plex-sans-arabic-arabic-700-normal.woff2',
  './fonts/ibm-plex-sans-arabic-latin-400-normal.woff2',
  './fonts/ibm-plex-sans-arabic-latin-500-normal.woff2',
  './fonts/ibm-plex-sans-arabic-latin-600-normal.woff2',
  './fonts/ibm-plex-sans-arabic-latin-700-normal.woff2',

  './icons/icon-48.png',
  './icons/icon-96.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './icons/favicon-16.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // tolerate a single missing file rather than failing the whole install
      .then((cache) =>
        Promise.all(
          PRECACHE.map((url) =>
            cache.add(new Request(url, { cache: 'reload' })).catch(() => null)
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** Stale-while-revalidate: answer immediately from cache, refresh in background. */
async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then((res) => {
      if (res && res.status === 200 && res.type === 'same-origin') {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
      }
      return res;
    })
    .catch(() => null);

  if (cached) return cached;
  const res = await network;
  if (res) return res;
  // last resort: unknown route → serve the app shell so the SPA can handle it
  const shell = await caches.match('./index.html');
  return shell || new Response('Offline', { status: 503 });
}

/**
 * Cache-first for navigations.
 *
 * This app is offline by design: there is no server it syncs with and no
 * deployment it needs to discover. The old network-first handler meant every
 * single launch stalled on a request that could only ever fail, then fell
 * back to the same cache it already had. Answering from the cache first makes
 * startup instant and removes the dependency on the network entirely.
 */
async function shellFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res && res.status === 200) {
      const copy = res.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy));
    }
    return res;
  } catch (err) {
    return (await caches.match('./index.html')) || new Response('Offline', { status: 503 });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  // Same-origin only. The app ships every asset — fonts, chart library, the
  // scanner — inside the package, so a cross-origin request would be a bug.
  if (new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(shellFirst(request));
  } else {
    event.respondWith(cacheFirst(request));
  }
});

/* Allow the page to ask for an immediate update after a redeploy. */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
