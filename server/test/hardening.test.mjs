/**
 * Production hardening found in the 2026-11-10 audit:
 *  - /api/health must probe the database (keep-alive also keeps Supabase awake,
 *    and a dead database answers 503 instead of "ok").
 *  - HTML pages carry CSP / frame / referrer / nosniff headers; code revalidates.
 *  - Expired sessions are actually deleted by cleanupExpiredSessions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequestHandler } from '../src/http.js';
import { loadConfig } from '../src/config.js';
import { openAuthDatabase } from './support/sqlite-auth.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function serve(extra = {}, env = {}) {
  const config = loadConfig({ NODE_ENV: 'test', STOREHUB_WEB_ROOT: REPO_ROOT, ...env });
  const handler = createRequestHandler({
    licenseService: { serverNow: () => Date.now() },
    authService: { getMe: () => null },
    config,
    log: () => {},
    ...extra,
  });
  const srv = createServer((q, s) => handler(q, s));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { base, close: () => new Promise((r) => srv.close(r)) };
}

test('HEALTH: probes the database and reports ok', async () => {
  let probes = 0;
  const app = await serve({ checkDatabase: () => { probes += 1; } });
  try {
    const res = await fetch(`${app.base}/api/health`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.db, 'ok');
    assert.equal(probes, 1, 'each health call must touch the database');
  } finally {
    await app.close();
  }
});

test('HEALTH: a failing database answers 503, never ok', async () => {
  const app = await serve({ checkDatabase: () => { throw new Error('connection refused'); } });
  try {
    const res = await fetch(`${app.base}/api/health`);
    const body = await res.json();
    assert.equal(res.status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.db, 'down');
    assert.doesNotMatch(JSON.stringify(body), /connection refused/, 'driver errors are not echoed');
  } finally {
    await app.close();
  }
});

test('HEALTH: without a probe it says not-checked rather than pretending', async () => {
  const app = await serve();
  try {
    const body = await (await fetch(`${app.base}/api/health`)).json();
    assert.equal(body.db, 'not-checked');
  } finally {
    await app.close();
  }
});

test('HEADERS: app and admin pages carry CSP, frame and referrer protection', async () => {
  const app = await serve({}, { NODE_ENV: 'test' });
  try {
    for (const p of ['/', '/admin/']) {
      const res = await fetch(app.base + p);
      assert.equal(res.status, 200, p);
      const csp = res.headers.get('content-security-policy') || '';
      assert.match(csp, /frame-ancestors 'none'/, `${p} must not be frameable`);
      assert.match(csp, /script-src 'self'(;|$)/, `${p} allows only same-origin scripts`);
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(res.headers.get('referrer-policy'));
      assert.equal(res.headers.get('cache-control'), 'no-cache');
      // HSTS only in production.
      assert.equal(res.headers.get('strict-transport-security'), null);
    }
    const js = await fetch(`${app.base}/admin/admin.js`);
    assert.equal(js.headers.get('cache-control'), 'no-cache', 'admin.js revalidates after a deploy');
    assert.equal(js.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(js.headers.get('content-security-policy'), null, 'policy headers belong on pages');
    const font = await fetch(`${app.base}/icons/icon-192.png`);
    assert.match(font.headers.get('cache-control'), /max-age=86400/);
  } finally {
    await app.close();
  }
});

test('HEADERS: production pages add HSTS', async () => {
  const app = await serve({}, {
    NODE_ENV: 'production',
    STOREHUB_PEPPER: '9f1c2b7e4a0d6c3e8b5a1f7d2c9e4b60',
    STOREHUB_ADMIN_SUB: '123456789012345678901',
  });
  try {
    const res = await fetch(`${app.base}/`);
    assert.match(res.headers.get('strict-transport-security') || '', /max-age=31536000/);
  } finally {
    await app.close();
  }
});

test('SESSIONS: cleanupExpiredSessions deletes expired rows and keeps live ones', async () => {
  let t = 1_000_000;
  const { repo } = await openAuthDatabase(':memory:', { clock: () => t, pepper: 'x'.repeat(32) });
  try {
    repo.upsertAccount({ googleSub: 's1', email: 'a@example.test', displayName: null, avatarUrl: null });
    const shortLived = repo.createSession('s1', 1000, 'ua');
    const longLived = repo.createSession('s1', 10 * 60 * 1000, 'ua');
    t += 5000;
    assert.equal(repo.cleanupExpiredSessions(), 1);
    assert.equal(repo.cleanupExpiredSessions(), 0);
    assert.ok(longLived.sessionToken && shortLived.sessionToken);
  } finally {
    repo.close();
  }
});
