/**
 * Service-worker routing — the shell must never swallow API traffic.
 *
 * Regression guard for the admin portal's "تعذّر الاتصال بالخادم / HTTP 504 /
 * UNKNOWN" screen: `sw.js` intercepted *every* same-origin GET, including
 * `/api/admin/me`. `fromNetwork()` rejects any non-200, and `handleAsset()`
 * answers a cache miss with a synthetic 504 whose body is a JS comment — so an
 * unauthenticated `401` reached the admin page as a 504, `response.json()`
 * failed, and `ApiError` fell back to `code: 'UNKNOWN'`.
 *
 * These tests run the real `sw.js` in a sandbox and drive its `fetch` handler,
 * so they assert the routing decision a browser would actually see rather than
 * the presence of a string in the source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createContext, runInContext } from 'node:vm';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(SERVER_ROOT, '..');
const ORIGIN = 'http://localhost:8787';

/**
 * Loads sw.js in a sandbox and returns its registered fetch handler plus the
 * cache keys `put()` was called with.
 */
function loadWorker() {
  const source = readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const handlers = {};
  const puts = [];

  const cache = {
    match: async () => null,
    put: async (key, value) => {
      void value;
      puts.push(typeof key === 'string' ? key : key?.url ?? String(key));
    },
  };

  const sandbox = {
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type, fn) => {
        handlers[type] = fn;
      },
      skipWaiting: () => {},
      clients: { claim: async () => {} },
    },
    caches: {
      open: async () => cache,
      keys: async () => [],
      delete: async () => false,
      match: async () => null,
    },
    // A 200 is the only answer `fromNetwork` accepts, which is exactly why a
    // real 401 became the 504 fallback before this fix.
    fetch: async () => ({ status: 200, type: 'basic', clone() { return this; } }),
    Response,
    Request,
    URL,
    AbortController,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
  };

  createContext(sandbox);
  runInContext(source, sandbox, { filename: 'sw.js' });
  return { fetchHandler: handlers.fetch, puts };
}

/** Drives the captured fetch handler with a request-shaped object. */
function dispatch(fetchHandler, request) {
  let respondWithCalled = false;
  let promise = null;
  const event = {
    request,
    respondWith: (value) => {
      respondWithCalled = true;
      promise = value;
    },
  };
  fetchHandler(event);
  return { respondWithCalled, promise };
}

test('SW-API: /api/* GETs bypass the worker entirely (no synthetic 504 for a 401)', () => {
  const { fetchHandler } = loadWorker();
  const paths = ['/api/admin/me', '/api/admin/licenses', '/api/auth/me', '/api/license/verify', '/api/drive/status'];
  for (const p of paths) {
    const { respondWithCalled } = dispatch(fetchHandler, { method: 'GET', url: ORIGIN + p, mode: 'cors' });
    assert.equal(respondWithCalled, false, `${p} must reach the network directly, not the shell cache`);
  }
});

test('SW-API: shell and asset GETs are still served by the worker', () => {
  const { fetchHandler } = loadWorker();
  assert.equal(
    dispatch(fetchHandler, { method: 'GET', url: ORIGIN + '/js/main.js', mode: 'cors' }).respondWithCalled,
    true,
    'static assets still go through handleAsset',
  );
  assert.equal(
    dispatch(fetchHandler, { method: 'GET', url: ORIGIN + '/', mode: 'navigate' }).respondWithCalled,
    true,
    'navigations still go through handleNavigate',
  );
});

test('SW-API: non-GET and cross-origin requests are left alone', () => {
  const { fetchHandler } = loadWorker();
  assert.equal(
    dispatch(fetchHandler, { method: 'POST', url: ORIGIN + '/api/admin/me', mode: 'cors' }).respondWithCalled,
    false,
    'a non-GET is never answered by this worker',
  );
  assert.equal(
    dispatch(fetchHandler, { method: 'GET', url: 'https://accounts.google.com/x', mode: 'cors' }).respondWithCalled,
    false,
    'a cross-origin request is never answered by this worker',
  );
});

test('SW-API: only the app shell navigation is cached as the offline document', async () => {
  const root = loadWorker();
  const home = dispatch(root.fetchHandler, { method: 'GET', url: ORIGIN + '/', mode: 'navigate' });
  assert.equal(home.respondWithCalled, true);
  await home.promise;
  assert.deepEqual(
    [...root.puts].sort(),
    ['./', './index.html'],
    'the app shell is cached under both ./ and ./index.html',
  );

  // The admin portal is not handled by this worker at all, so it can never
  // replace the app shell and is never served a stale admin.js after a deploy.
  const adminWorker = loadWorker();
  for (const [url, mode] of [
    ['/admin/', 'navigate'],
    ['/admin', 'navigate'],
    ['/admin/admin.js', 'cors'],
    ['/admin/admin.css', 'no-cors'],
  ]) {
    const r = dispatch(adminWorker.fetchHandler, { method: 'GET', url: ORIGIN + url, mode });
    assert.equal(r.respondWithCalled, false, `${url} must go straight to the network`);
  }
  assert.deepEqual(adminWorker.puts, [], 'an admin request must not replace the app shell');
});
