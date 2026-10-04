/* ==========================================================================
   Service worker for the Saher PWA
   --------------------------------------------------------------------------
   Why this file exists in this shape
   -----------------------------------
   The previous revision cached the app shell *first, forever*. Once
   index.html was in the cache, navigations never touched the network again,
   so a redeploy was invisible: the installed app kept serving the shell it was
   built with, and the only ways out were DevTools or "clear site data". That is
   unacceptable for a shop whose sales data lives in the phone.

   The rules below keep the app offline-first while making a redeploy take
   effect on its own:

     * INSTALL  → precache the whole shell with `cache: 'reload'` (never the
                  HTTP cache), then PROVE the cache is complete. If a required
                  file did not land, the install is rejected on purpose: the
                  previous worker keeps serving the app it already has, instead
                  of a half-cached one that cannot boot.
     * ACTIVATE → take over open tabs, then drop caches belonging to older
                  builds. Old entries are removed only after the new cache is
                  complete, so there is never a window with no shell at all.
     * FETCH
         - navigations : NETWORK-FIRST with a short timeout, cache as the
           fallback. This is the piece that was missing. Online, every launch
           asks the server for the real index.html and gets the current
           build. Offline, the answer comes from the cache immediately after
           the timeout — the app still opens with no signal.
         - everything else : STALE-WHILE-REVALIDATE. Answer instantly from the
           cache so the UI never waits, and refresh in the background so an
           edited file lands on the next launch.
                  A failed subresource NEVER falls back to index.html — handing
                  an HTML document to a <script> or <link> is how an offline
                  launch used to die with a parse error instead of a real one.

   Bumping BUILD is what invalidates the old shell, so it must change whenever
   PRECACHE does. The install-time check below turns a forgotten entry into a
   loud console warning instead of a silent offline breakage, and
   `node chk-sw-precache.mjs` fails the build on the same thing.
   ========================================================================== */

// v16 — Google Auth foundation (auth-client). The licence backend itself
// lives in /server and is NOT precached (it runs on a server, not in the phone).
// PRECACHE gains the client integration; BUILD must change whenever PRECACHE does.
const BUILD = 'v16';
const CACHE_PREFIX = 'saher-shell-';
const CACHE = `${CACHE_PREFIX}${BUILD}`;

/** How long a navigation may wait on the network before the cache answers. */
const NAV_TIMEOUT_MS = 3000;

/* Everything the app needs to boot offline. Keep in sync with /js /css /fonts. */
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',

  './css/tokens.css',
  './css/base.css',
  './css/components.css',
  './css/screens.css',
  './css/invoice-sheet.css',

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
  './js/checkout.js',
  './js/invoice-sheet.js',
  './js/restock.js',
  './vendor/html5-qrcode.min.js',
  './js/screens/dashboard.js',
  './js/screens/products.js',
  './js/screens/product-form.js',
  './js/screens/pos.js',
  './js/screens/suppliers.js',
  './js/screens/reports.js',
  './js/screens/settings.js',

  // Foundation layer. Not imported by anything yet, so nothing here can change
  // how the app behaves — but precached, because the phase that wires them in
  // must find them available offline on a phone with no signal.
  './js/version.js',
  './js/platform.js',
  './js/clock.js',
  './js/identity-store.js',
  './js/license-client.js',
  './js/auth-client.js',

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

/**
 * The part of PRECACHE without which the app cannot start.
 *
 * A missing font or icon is a cosmetic problem, so those stay best-effort.
 * A missing module or stylesheet means a blank screen the moment the signal
 * drops, so an install that cannot cache all of these is refused.
 */
const REQUIRED = PRECACHE.filter((u) => /\.(?:js|css|json|html)$/.test(u) || u === './');

/* ------------------------------------------------------------------ *
 * install
 * ------------------------------------------------------------------ */

/**
 * Fetches `url` with the HTTP cache bypassed.
 *
 * `cache: 'reload'` is what makes a redeploy visible at all: without it the
 * worker can be handed the very copy it already has, and "new deploy, same
 * cache name" would install the new shell on top of the old one.
 */
function fresh(url) {
  return fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' }));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);

      const results = await Promise.all(
        PRECACHE.map(async (url) => {
          try {
            const res = await fresh(url);
            // opaque/redirect answers are not storable and would poison the
            // cache, so they count as a miss
            if (!res || res.status !== 200 || res.type === 'opaque') return { url, ok: false };
            await cache.put(url, res.clone());
            return { url, ok: true };
          } catch {
            return { url, ok: false };
          }
        })
      );

      const missing = results.filter((r) => !r.ok).map((r) => r.url);
      const missingRequired = missing.filter((u) => REQUIRED.includes(u));

      if (missingRequired.length) {
        // Refusing the install is the whole point: an old worker serving a
        // complete cache beats a new worker serving half of one.
        await caches.delete(CACHE);
        throw new Error(
          `[sw] install aborted — ${BUILD} could not precache: ${missingRequired.join(', ')}`
        );
      }

      if (missing.length) {
        // Non-fatal, but never silent: an entry nobody noticed missing is how
        // checkout.js and invoice-sheet.css ended up unloaded when offline.
        console.warn(`[sw] ${BUILD} — ${missing.length} optional asset(s) not cached:`, missing);
      }

      await auditShell(cache);
      await self.skipWaiting();
    })()
  );
});

/**
 * Compares what index.html actually asks for against what is in the cache.
 *
 * Catches the one mistake the browser cannot: a file added to the app but not
 * to PRECACHE. The install still succeeds — the file will be fetched on
 * demand while online — but the console says so instead of the app failing
 * mysteriously in a shop with no signal.
 */
async function auditShell(cache) {
  try {
    const res = await cache.match('./index.html');
    if (!res) return;
    const html = await res.text();
    const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((h) => /^\.\/?[^:]*\.(?:js|css|woff2|png|json)$/.test(h));

    const uncovered = [];
    for (const ref of new Set(refs)) {
      const url = new URL(ref, self.registration.scope).toString();
      if (!(await cache.match(url))) uncovered.push(ref);
    }
    if (uncovered.length) {
      console.warn(
        `[sw] ${BUILD} — index.html references ${uncovered.length} file(s) missing from PRECACHE:`,
        uncovered
      );
    }
  } catch (err) {
    console.warn('[sw] shell audit skipped', err);
  }
}

/* ------------------------------------------------------------------ *
 * activate
 * ------------------------------------------------------------------ */

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Take over the tabs that are already open, so nobody is left running an
      // old document against a new worker. main.js reloads once on
      // `controllerchange`, which is what clears the mixed state.
      await self.clients.claim();

      // Only ever delete caches this app owns, and only after the new cache is
      // complete (install would have thrown otherwise).
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE)
          .map((k) => caches.delete(k))
      );
    })()
  );
});

/* ------------------------------------------------------------------ *
 * fetch
 * ------------------------------------------------------------------ */

/** Resolves to the network answer, or null on timeout/error/non-OK. */
async function fromNetwork(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NAV_TIMEOUT_MS);
  try {
    const res = await fetch(request, { signal: controller.signal });
    if (!res || res.status !== 200 || res.type === 'opaque') return null;
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Network-first, cache-second, for navigations.
 *
 * The cache is the safety net, not the answer: while there is a network the
 * server decides which build is running, so a redeploy is picked up on the
 * next launch. When there is not, the cached shell is served and the SPA routes
 * normally — offline behaviour is unchanged for the shop.
 */
async function handleNavigate(request) {
  const fromNet = await fromNetwork(request);
  if (fromNet) {
    const cache = await caches.open(CACHE);
    // `./` and `./index.html` are the same document; keep them in step so a
    // later offline launch cannot find one and not the other.
    cache.put('./index.html', fromNet.clone());
    cache.put('./', fromNet.clone());
    return fromNet;
  }

  const cached =
    (await caches.match(request, { ignoreSearch: true })) ||
    (await caches.match('./index.html', { ignoreSearch: true })) ||
    (await caches.match('./', { ignoreSearch: true }));

  if (cached) return cached;
  return new Response(
    '<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:24px">' +
      'التطبيق غير متاح الآن ولا توجد نسخة محفوظة. افتح التطبيق مرة واحدة وأنت متصل.',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

/** Stale-while-revalidate: instant from cache, refreshed in the background. */
async function handleAsset(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });

  const revalidate = fromNetwork(request).then((res) => {
    if (res) cache.put(request, res.clone());
    return res;
  });

  if (cached) return cached;

  const res = await revalidate;
  if (res) return res;

  // Deliberately NOT index.html. A stylesheet or a module served an HTML body
  // fails as a parse error with a message that points nowhere near the cause.
  return new Response(
    `/* ${CACHE}: ${request.url} is not cached and the network is unreachable. */`,
    { status: 504, headers: { 'Content-Type': 'text/javascript; charset=utf-8' } }
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  // Same-origin only. The app ships every asset — fonts, chart library, the
  // scanner — inside the package, so a cross-origin request would be a bug.
  if (new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigate(request));
  } else {
    event.respondWith(handleAsset(request));
  }
});

/* ------------------------------------------------------------------ *
 * messages from the page
 * ------------------------------------------------------------------ */

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  if (event.data === 'GET_VERSION') {
    event.source && event.source.postMessage({ type: 'VERSION', build: BUILD, cache: CACHE });
  }
});
