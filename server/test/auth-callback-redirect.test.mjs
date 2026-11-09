/**
 * Regression: the OAuth callback must hand the browser an absolute origin —
 * `http://localhost:8787/…`.
 *
 * The complaint this pins down: after a successful Google sign-in the browser
 * was sent to the callback's own path with the origin pasted into it,
 * `/api/auth/google/http//localhost:8787/`, and the server answered
 * INVALID_REQUEST. The `Location` it built had the scheme stripped of its
 * colon (`http//`), which is not an absolute URL, so the browser resolved it as
 * a path relative to `/api/auth/google/callback`.
 *
 * The success redirect and all three failures are checked, because they share
 * one origin and only one of them was ever looked at.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { request, createTestService } from './helpers.mjs';

/**
 * Drives the callback with a scripted `completeAuth` (the OAuth round trip is
 * not what is under test here).
 *
 * @param {() => Promise<{sessionToken: string}>} completeAuth
 * @param {(app: object) => Promise<void>} fn
 */
async function withCallback(completeAuth, fn) {
  const app = createTestService();
  app.authService = { completeAuth, getMe: () => null };
  try {
    await fn(app);
  } finally {
    app.close();
  }
}

const HOST = { host: 'localhost:8787' };

/** @param {string} location @param {string} expected the query marker to find */
function assertAbsoluteLocalhost(location, expected) {
  assert.ok(location, 'a Location header must be set');
  assert.ok(
    location.startsWith('http://localhost:8787/'),
    `Location must be absolute on the request host, got ${location}`,
  );
  assert.ok(
    !location.includes('http//'),
    `Location must not contain a colonless scheme, got ${location}`,
  );
  assert.ok(
    location.includes(expected),
    `Location must carry ${expected}, got ${location}`,
  );
}

test('REGRESSION: success redirects to http://localhost:8787/?auth=ok', async () => {
  await withCallback(async () => ({ sessionToken: 'tok' }), async (app) => {
    const res = await request(app, '/api/auth/google/callback?code=abc&state=xyz', {
      method: 'GET',
      headers: HOST,
    });
    assert.equal(res.status, 302);
    assertAbsoluteLocalhost(res.headers.location, 'auth=ok');
  });
});

test('REGRESSION: ?error= redirects absolutely (oauth_denied)', async () => {
  await withCallback(async () => ({ sessionToken: 'tok' }), async (app) => {
    const res = await request(
      app,
      '/api/auth/google/callback?error=access_denied&state=xyz',
      { method: 'GET', headers: HOST },
    );
    assert.equal(res.status, 302);
    assertAbsoluteLocalhost(res.headers.location, 'auth=error');
    assert.ok(res.headers.location.includes('reason=oauth_denied'));
  });
});

test('REGRESSION: missing code/state redirects absolutely (invalid_request)', async () => {
  await withCallback(async () => ({ sessionToken: 'tok' }), async (app) => {
    const res = await request(app, '/api/auth/google/callback', {
      method: 'GET',
      headers: HOST,
    });
    assert.equal(res.status, 302);
    assertAbsoluteLocalhost(res.headers.location, 'auth=error');
    assert.ok(res.headers.location.includes('reason=invalid_request'));
  });
});

test('REGRESSION: a failed exchange redirects absolutely (auth_failed)', async () => {
  await withCallback(async () => {
    throw new Error('the code was rejected');
  }, async (app) => {
    const res = await request(app, '/api/auth/google/callback?code=abc&state=xyz', {
      method: 'GET',
      headers: HOST,
    });
    assert.equal(res.status, 302);
    assertAbsoluteLocalhost(res.headers.location, 'auth=error');
    assert.ok(res.headers.location.includes('reason=auth_failed'));
  });
});

test('REGRESSION: x-forwarded-proto is honoured without a double colon', async () => {
  await withCallback(async () => ({ sessionToken: 'tok' }), async (app) => {
    const res = await request(app, '/api/auth/google/callback?code=abc&state=xyz', {
      method: 'GET',
      headers: { ...HOST, 'x-forwarded-proto': 'https' },
    });
    assert.equal(res.status, 302);
    assert.ok(
      res.headers.location.startsWith('https://localhost:8787/'),
      `expected the forwarded scheme, got ${res.headers.location}`,
    );
    assert.ok(!res.headers.location.includes('https//'), 'no colonless scheme');
  });
});
