/**
 * Regression: the browser must request the sign-in *start endpoint*, never a
 * URL with an origin/href pasted into its path.
 *
 * The complaint this file pins down: pressing "تسجيل الدخول بـ Google" opened
 * `/api/auth/google/http://localhost:8787/`, and the server answered
 * `INVALID_REQUEST` (404) for that made-up path. The one correct request is
 * `GET /api/auth/google/start` (server/src/http.js:127 · 770–774), which returns
 * the Google `authUrl` the caller then redirects to. Nothing else belongs in the
 * path — the server takes no parameters on this route.
 *
 * The cause is how a client turns its configured base into a URL.
 * `resolveClientBase('auth')` (js/api-config.js) returned a *bare origin* when
 * `window.STOREHUB_API_BASE` was set, so `${base}/google/start` became
 * `https://api.example.com/google/start`: the `/api/auth` segment was dropped
 * and the request went to the wrong path. With a base that happened to look
 * like a page URL, the origin ended up as a path segment — exactly the reported
 * `/api/auth/google/<origin>/` shape. The fix makes `resolveClientBase` always
 * return the *group* base, so every client appends its endpoint to a base that
 * already carries `/api/<group>`.
 *
 * `returnTo`: this flow has none. The start route accepts no parameters, so the
 * only correct shape is the bare start path. The assertions below reject any
 * query string or embedded scheme, which is what keeps an origin or href from
 * ever being smuggled in as a path segment or an unencoded parameter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeIndexedDB } from './fake-indexeddb.mjs';
import { installDom } from './dom-stub.mjs';

/** A fetch that records the exact URL it was handed and answers like the route. */
function recordingFetch() {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', state: 's' }),
    };
  };
  return { fetchImpl, seen };
}

test('REGRESSION: sign-in requests /api/auth/google/start with no embedded origin', async () => {
  installDom({ hash: '#/activate' });
  globalThis.indexedDB = createFakeIndexedDB();

  try {
    const apiConfig = await import('../../js/api-config.js');
    const { startGoogleAuth } = await import('../../js/auth-client.js');

    // 1 · Same-origin dev (localhost:8787): the start endpoint verbatim.
    apiConfig.clearApiBaseForTesting();
    const sameOrigin = recordingFetch();
    await startGoogleAuth({ fetchImpl: sameOrigin.fetchImpl });

    assert.equal(
      sameOrigin.seen[0],
      '/api/auth/google/start',
      'same-origin sign-in must call the start endpoint exactly',
    );
    assert.equal(
      sameOrigin.seen[0].includes('?'),
      false,
      'the start route takes no query parameters',
    );
    assert.equal(
      /:\/\//.test(sameOrigin.seen[0]),
      false,
      'no scheme may appear in the path the browser requests',
    );

    // 2 · A configured backend origin (Android / production). The `/api/auth`
    //     segment must survive: `<origin>/api/auth/google/start`, never
    //     `<origin>/google/start`.
    apiConfig.setApiBaseForTesting('https://api.example.com');
    const configured = recordingFetch();
    await startGoogleAuth({ fetchImpl: configured.fetchImpl });

    assert.equal(
      configured.seen[0],
      'https://api.example.com/api/auth/google/start',
      'a configured origin must keep the /api/auth segment',
    );
    assert.equal(
      new URL(configured.seen[0]).pathname,
      '/api/auth/google/start',
      'only the start path may follow the configured host',
    );
    assert.equal(
      new URL(configured.seen[0]).search,
      '',
      'no origin or href may be appended as a query parameter',
    );
  } finally {
    const apiConfig = await import('../../js/api-config.js').catch(() => null);
    apiConfig?.clearApiBaseForTesting();
    delete globalThis.indexedDB;
  }
});
