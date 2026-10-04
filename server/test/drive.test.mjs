/**
 * Drive backup authorisation — the backend's half of the phase.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * What these tests are actually asserting
 * ─────────────────────────────────────────────────────────────────────────
 * Two claims, and both are negative claims that are easy to state and hard to
 * guarantee:
 *
 *   1. **The backend never holds customer business data.** Not "we do not send
 *      it", but: no Drive route reads a request body, the Drive database has no
 *      column that could hold one, and posting a backup envelope at every route
 *      in the application leaves all three databases byte-identical.
 *
 *   2. **The grant is the only thing kept, and it is kept properly.** Sealed at
 *      rest, scoped to `drive.file`, addressed to exactly one account, never
 *      returned in an API response, and revocable.
 *
 * A test that only checked the happy path would pass against an implementation
 * that also quietly accepted a POST body. These are written so that such an
 * implementation fails.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTestDriveApp, request, TEST_PEPPER } from './helpers.mjs';
import {
  createDriveRepository,
  deriveGrantKey,
  sealGrant,
  openGrant,
  applyDriveMigrations,
} from '../src/drive-repository.js';
import { createDriveService, DRIVE_SCOPE } from '../src/drive-service.js';
import { ERROR_CODES } from '../src/errors.js';
import { loadConfig } from '../src/config.js';

/**
 * A stand-in for a `Response`.
 *
 * `drive-service` reads `res.text()` and `res.ok`, so a fake that only offers
 * `json()` fails with `res.text is not a function` — a shape error that looks
 * like a product bug and is not one. Anything scripted here therefore supplies
 * both, the way a real fetch does.
 *
 * @param {number} status
 * @param {object} body
 */
function fakeResponse(status, body) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

/** A successful Google token refresh. */
function tokenResponse({ accessToken = 'ya29.access-token', expiresIn = 3600, scope } = {}) {
  return fakeResponse(200, { access_token: accessToken, expires_in: expiresIn, ...(scope ? { scope } : {}) });
}

/** A backup envelope carrying unmistakable business data. */
function fakeBackupPayload() {
  return {
    format: 'storehub-backup',
    version: 1,
    createdAt: '2026-03-01T00:00:00.000Z',
    appVersion: '1.0.0',
    data: {
      products: [{ id: 'p1', name: 'قميص', price: 50, image: 'data:image/jpeg;base64,AAAA' }],
      sales: [{ id: 's1', total: 100, items: [{ productId: 'p1', qty: 2 }] }],
      purchases: [],
      suppliers: [{ id: 'sup1', name: 'مورد' }],
      supplierInvoices: [],
      supplierPayments: [],
      settings: { key: 'app', storeName: 'محلي', logo: 'data:image/png;base64,BBBB' },
    },
  };
}

/* ================================================================== *
 * 1 · GRANT STORAGE
 * ================================================================== */

test('DRIVE: a grant is stored encrypted, never in the clear', async () => {
  const app = await createTestDriveApp();
  try {
    const refreshToken = 'refresh-token-plaintext-value';
    app.connect(refreshToken);

    const row = app.driveDb.prepare('SELECT * FROM drive_grants').get();
    assert.ok(row, 'the grant was recorded');
    assert.ok(
      !JSON.stringify(row).includes(refreshToken),
      'the plaintext refresh token appears nowhere in the stored row',
    );
    assert.match(row.refresh_cipher, /^v1\./, 'the grant is sealed with a versioned envelope');

    // And it is decryptable by the holder of the pepper — otherwise the feature
    // could not work at all.
    const key = deriveGrantKey(TEST_PEPPER);
    assert.equal(openGrant(key, row.refresh_cipher), refreshToken);
  } finally {
    app.close();
  }
});

test('DRIVE: a different pepper cannot open the grant', async () => {
  const app = await createTestDriveApp();
  try {
    app.connect('refresh-token-secret');
    const row = app.driveDb.prepare('SELECT refresh_cipher FROM drive_grants').get();
    assert.throws(
      () => openGrant(deriveGrantKey('a-completely-different-pepper-value'), row.refresh_cipher),
      'a stolen database is not enough — the pepper is the second factor',
    );
  } finally {
    app.close();
  }
});

test('DRIVE: a tampered ciphertext is rejected, not silently decrypted', () => {
  const key = deriveGrantKey(TEST_PEPPER);
  const sealed = sealGrant(key, 'refresh-token-secret');
  const parts = sealed.split('.');
  // Flip a byte in the ciphertext body.
  parts[3] = Buffer.from('tampered-bytes').toString('base64url');
  assert.throws(() => openGrant(key, parts.join('.')));
});

test('DRIVE: the grant database has no column that could hold business data', async () => {
  const app = await createTestDriveApp();
  try {
    const tables = app.driveDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name);

    assert.deepEqual(tables, ['drive_grants'], 'the Drive database holds exactly one table');

    const columns = app.driveDb.prepare('PRAGMA table_info(drive_grants)').all().map((c) => c.name);
    assert.deepEqual(
      [...columns].sort(),
      ['google_sub', 'granted_at', 'refresh_cipher', 'revoked_at', 'scopes', 'updated_at'],
      'and every column is either the join key, the sealed credential, or a timestamp',
    );

    // Named explicitly, because "no column could hold it" should not depend on
    // someone reading the list above.
    for (const column of columns) {
      for (const forbidden of ['email', 'product', 'sale', 'invoice', 'backup', 'inventory', 'token']) {
        assert.ok(
          !column.toLowerCase().includes(forbidden),
          `column "${column}" must not look like a place for ${forbidden}`,
        );
      }
    }
  } finally {
    app.close();
  }
});

test('DRIVE: the grant is keyed by google sub, and only that', async () => {
  const app = await createTestDriveApp();
  try {
    app.connect('token-one', 'sub-alpha');
    app.connect('token-two', 'sub-beta');

    assert.equal(app.driveRepository.getGrant('sub-alpha').refreshToken, 'token-one');
    assert.equal(app.driveRepository.getGrant('sub-beta').refreshToken, 'token-two');
    assert.equal(app.driveRepository.getGrant('sub-gamma'), null);
    assert.deepEqual([...app.driveRepository.listGranted()].sort(), ['sub-alpha', 'sub-beta']);
  } finally {
    app.close();
  }
});

test('DRIVE: a revoked grant is treated as absent even though the row survives', async () => {
  const app = await createTestDriveApp();
  try {
    app.connect('refresh-token-alpha');
    assert.ok(app.driveRepository.getGrant('shop-sub-1'));

    assert.equal(app.driveService.disconnect('shop-sub-1'), true);
    assert.equal(
      app.driveRepository.getGrant('shop-sub-1'),
      null,
      'a revoked credential must not be usable, even though it is still on disk',
    );
    assert.equal(app.driveService.disconnect('shop-sub-1'), false, 'revoking twice is not an error');
  } finally {
    app.close();
  }
});

/* ================================================================== *
 * 2 · SCOPE
 * ================================================================== */

test('DRIVE: the scope requested is drive.file, never a broad drive grant', () => {
  assert.equal(DRIVE_SCOPE, 'https://www.googleapis.com/auth/drive.file');
  // The narrow scope is the whole point: it cannot see the owner's other files.
  assert.ok(!DRIVE_SCOPE.endsWith('/auth/drive'));
  assert.ok(!DRIVE_SCOPE.endsWith('/auth/drive.readonly'));
});

test('DRIVE: a plain sign-in asks for identity only, and Drive only on request', async () => {
  const app = await createTestDriveApp();
  try {
    const plain = app.authService.startAuth({ intent: 'customer' });
    assert.ok(!plain.authUrl.includes('drive'), 'signing in to use the till asks for no Drive scope');

    const drive = app.authService.startAuth({ intent: 'drive' });
    assert.ok(drive.authUrl.includes('drive.file'), 'connecting Drive asks for it');

    // Opt-in per flow: a customer flow cannot smuggle the scope in.
    const sneaky = app.authService.startAuth({ intent: 'customer', drive: true });
    assert.ok(!sneaky.authUrl.includes('drive'), 'drive:true is ignored outside the Drive flow');
  } finally {
    app.close();
  }
});

/**
 * Drives a whole Google consent with a scripted Google, so the assertion is
 * about `completeAuth` rather than about a hand-made pending state.
 *
 * `completeAuth` calls the global `fetch`, so the swap is global and is undone
 * by the returned disposer. Any test that throws before calling `dispose()`
 * would leak it, which is why `dispose` is returned rather than registered.
 *
 * @param {{refreshToken?: string|null}} [options]
 */
function withFakeGoogle(options = {}) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    if (String(url).includes('/token')) {
      const token = { access_token: 'access-abc', expires_in: 3600 };
      if (options.refreshToken !== null) token.refresh_token = options.refreshToken ?? 'refresh-alpha';
      return { ok: true, status: 200, json: async () => token };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ sub: 'shop-sub-1', email: 'shop@example.test', name: 'Shop' }),
    };
  };
  return { calls, dispose() { globalThis.fetch = real; } };
}

test('DRIVE: only a Drive-intent consent records a grant', async () => {
  const app = await createTestDriveApp();
  const google = withFakeGoogle();
  try {
    // An ordinary sign-in. Google hands back a refresh token for identity
    // re-consent — and it must be discarded, because this customer never asked
    // for Drive.
    const customer = app.authService.startAuth({ intent: 'customer' });
    const customerResult = await app.authService.completeAuth({
      code: 'code-customer',
      state: customer.state,
      userAgent: 'node-test',
    });
    assert.equal(customerResult.intent, 'customer');
    assert.equal(customerResult.driveConnected, false);
    assert.deepEqual(
      [...app.driveRepository.listGranted()],
      [],
      'a plain sign-in leaves no Drive grant behind, even when Google sends a refresh token',
    );

    // The same Google response, but for a flow that asked for Drive.
    const drive = app.authService.startAuth({ intent: 'drive' });
    const driveResult = await app.authService.completeAuth({
      code: 'code-drive',
      state: drive.state,
      userAgent: 'node-test',
    });
    assert.equal(driveResult.intent, 'drive');
    assert.equal(driveResult.driveConnected, true);
    assert.deepEqual([...app.driveRepository.listGranted()], ['shop-sub-1']);
  } finally {
    google.dispose();
    app.close();
  }
});

test('DRIVE: the completed consent returns a boolean, never the credential', async () => {
  const app = await createTestDriveApp();
  const google = withFakeGoogle({ refreshToken: 'refresh-must-not-escape' });
  try {
    const flow = app.authService.startAuth({ intent: 'drive' });
    const result = await app.authService.completeAuth({
      code: 'code',
      state: flow.state,
      userAgent: 'node-test',
    });

    // A boolean is the whole contract: whatever else this function returns, the
    // refresh token is not in it.
    assert.equal(result.driveConnected, true);
    const serialised = JSON.stringify(result, (key, value) => (key === 'sessionToken' ? '<redacted>' : value));
    assert.ok(!serialised.includes('refresh-must-not-escape'), 'the refresh token is not in the result');
    assert.ok(!/refresh/i.test(serialised), 'and no field is even named after one');
  } finally {
    google.dispose();
    app.close();
  }
});

test('DRIVE: re-consent without the Drive scope records nothing and reports not connected', async () => {
  const app = await createTestDriveApp();
  const google = withFakeGoogle({ refreshToken: null });
  try {
    const flow = app.authService.startAuth({ intent: 'drive' });
    const result = await app.authService.completeAuth({
      code: 'code',
      state: flow.state,
      userAgent: 'node-test',
    });

    // Google withholds a refresh token when the scope was not newly granted. That
    // is not an error, but it must not read as connected.
    assert.equal(result.driveConnected, false);
    assert.deepEqual([...app.driveRepository.listGranted()], []);
  } finally {
    google.dispose();
    app.close();
  }
});

/* ================================================================== *
 * 3 · ACCESS TOKENS
 * ================================================================== */

test('DRIVE: a short-lived access token is minted for the connected account', async () => {
  let refreshCalls = 0;
  const app = await createTestDriveApp({
    fetchImpl: async () => {
      refreshCalls += 1;
      return tokenResponse();
    },
  });
  try {
    app.connect('refresh-token-alpha');

    const token = await app.driveService.getAccessToken('shop-sub-1');
    assert.equal(token.accessToken, 'ya29.access-token');
    assert.ok(token.expiresAt > app.now(), 'the token has a real expiry');
    assert.equal(refreshCalls, 1);

    // Cached, so a weekly backup does not burn a Google round trip per request.
    await app.driveService.getAccessToken('shop-sub-1');
    assert.equal(refreshCalls, 1, 'a second call reuses the cached access token');
  } finally {
    app.close();
  }
});

test('DRIVE: an account with no grant gets a refusal, not a token', async () => {
  const app = await createTestDriveApp();
  try {
    await assert.rejects(
      () => app.driveService.getAccessToken('shop-sub-1'),
      (err) => err.code === ERROR_CODES.DRIVE_NOT_CONNECTED,
    );
  } finally {
    app.close();
  }
});

test('DRIVE: one account cannot obtain another account\'s Drive access', async () => {
  const app = await createTestDriveApp({
    fetchImpl: async (_url, init) => {
      // Echo back which refresh token the server was asked to use, so the test
      // can prove each account gets its own.
      const body = new URLSearchParams(String(init?.body ?? ''));
      return tokenResponse({ accessToken: `access-for-${body.get('refresh_token')}` });
    },
  });
  try {
    app.connect('token-alpha', 'sub-alpha');
    app.connect('token-beta', 'sub-beta');

    const alpha = await app.driveService.getAccessToken('sub-alpha');
    const beta = await app.driveService.getAccessToken('sub-beta');
    assert.equal(alpha.accessToken, 'access-for-token-alpha');
    assert.equal(beta.accessToken, 'access-for-token-beta');
    assert.notEqual(alpha.accessToken, beta.accessToken);
  } finally {
    app.close();
  }
});

test('DRIVE: a revoked grant cannot mint a token', async () => {
  let calls = 0;
  const app = await createTestDriveApp({
    fetchImpl: async () => {
      calls += 1;
      return tokenResponse({ accessToken: 'x' });
    },
  });
  try {
    app.connect('refresh-token-alpha');
    await app.driveService.getAccessToken('shop-sub-1');
    assert.equal(calls, 1);

    app.driveService.disconnect('shop-sub-1');
    await assert.rejects(
      () => app.driveService.getAccessToken('shop-sub-1'),
      (err) => err.code === ERROR_CODES.DRIVE_NOT_CONNECTED,
    );
    assert.equal(calls, 1, 'and no attempt was made to reach Google with the revoked credential');
  } finally {
    app.close();
  }
});

test('DRIVE: a Google refusal is reported as a Drive problem, not a session problem', async () => {
  const app = await createTestDriveApp({
    fetchImpl: async () =>
      fakeResponse(400, { error: 'invalid_grant', error_description: 'Bad refresh token' }),
  });
  try {
    app.connect('refresh-token-already-cancelled-at-google');
    await assert.rejects(
      () => app.driveService.getAccessToken('shop-sub-1'),
      (err) => {
        assert.equal(err.code, ERROR_CODES.DRIVE_NOT_CONNECTED);
        assert.notEqual(err.code, ERROR_CODES.INVALID_SESSION, 're-authenticating cannot fix a revoked grant');
        return true;
      },
    );
  } finally {
    app.close();
  }
});

/* ================================================================== *
 * 4 · HTTP: AUTHENTICATION
 * ================================================================== */

const DRIVE_ROUTES = [
  '/api/drive/status',
  '/api/drive/token',
  '/api/drive/connect/start',
  '/api/drive/connect/callback',
];

test('AUTH: an unauthenticated request is refused on every Drive route', async () => {
  const app = await createTestDriveApp({ connect: true });
  try {
    for (const path of DRIVE_ROUTES) {
      const res = await request(app, path, { method: 'GET' });
      assert.equal(res.status, 401, `${path} must refuse an unauthenticated caller`);
      assert.equal(res.body.error.code, ERROR_CODES.INVALID_SESSION);
    }
    const disconnect = await request(app, '/api/drive/disconnect', { method: 'POST' });
    assert.equal(disconnect.status, 401);
  } finally {
    app.close();
  }
});

test('AUTH: a forged or stale session cookie is refused', async () => {
  const app = await createTestDriveApp({ connect: true });
  try {
    const res = await request(app, '/api/drive/token', {
      method: 'GET',
      headers: app.cookieHeaders('not-a-real-session-token'),
    });
    assert.equal(res.status, 401);
  } finally {
    app.close();
  }
});

test('AUTH: a signed-in customer gets exactly their own Drive state', async () => {
  const app = await createTestDriveApp();
  try {
    const token = app.signIn('shop-sub-1');
    app.connect('refresh-token-alpha', 'shop-sub-1');

    const res = await request(app, '/api/drive/status', {
      method: 'GET',
      headers: app.cookieHeaders(token),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.connected, true);
    assert.equal(res.body.scope, DRIVE_SCOPE);
    assert.equal(res.body.folderName, 'Store Hub Backups');
  } finally {
    app.close();
  }
});

/* ================================================================== *
 * 5 · HTTP: NO BUSINESS DATA EVER ARRIVES OR LEAVES
 * ================================================================== */

test('ISOLATION: no Drive route accepts a request body', async () => {
  const app = await createTestDriveApp({ connect: true });
  try {
    const token = app.signIn();
    const headers = app.cookieHeaders(token);

    // Every Drive route that exists for GET must refuse POST. A 405 is the
    // strongest possible statement: the route cannot be handed a payload at all.
    for (const path of DRIVE_ROUTES) {
      const res = await request(app, path, { method: 'POST', body: fakeBackupPayload(), headers });
      assert.equal(res.status, 405, `${path} must not accept POST`);
      assert.ok(Array.isArray(res.body.allowed), 'and must say which methods it does serve');
    }

    // The one POST route that exists accepts no parameters whatsoever.
    const disconnect = await request(app, '/api/drive/disconnect', {
      method: 'POST',
      body: fakeBackupPayload(),
      headers,
    });
    assert.equal(disconnect.status, 200);
    assert.deepEqual(
      { connected: disconnect.body.connected, wasConnected: disconnect.body.wasConnected },
      { connected: false, wasConnected: true },
      'it disconnected, and ignored the body entirely',
    );
  } finally {
    app.close();
  }
});

test('ISOLATION: posting a backup envelope anywhere changes no database', async () => {
  // Deliberately a *file*-backed application rather than the in-memory harness.
  // The claim is about where data physically lands, and an in-memory database
  // cannot answer it — with a file, the three databases can be opened
  // independently and inspected, which is the only way to show the separation
  // is structural rather than a matter of which handle you happen to hold.
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storehub-drive-iso-'));
  const licenceFile = path.join(dir, 'licence.db');
  const driveFile = path.join(dir, 'drive.db');

  const { buildApplication } = await import('../src/index.js');
  const app = await buildApplication({
    env: {
      NODE_ENV: 'test',
      STOREHUB_PEPPER: TEST_PEPPER,
      STOREHUB_DB: licenceFile,
      STOREHUB_DRIVE_DB: driveFile,
      STOREHUB_SCRYPT_N: '1024',
      STOREHUB_SCRYPT_R: '8',
      STOREHUB_SCRYPT_P: '1',
      GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
      GOOGLE_REDIRECT_URI: 'https://storehub.test/api/drive/connect/callback',
      STOREHUB_RATE_MAX_ACTIVATE: '1000',
      STOREHUB_RATE_MAX_VERIFY: '1000',
    },
  });

  try {
    assert.notEqual(app.config.databaseFile, app.config.drive.databaseFile, 'two separate files');

    // A real grant and a real session, created through the app's own wiring —
    // not through a test-only entry point — so the HTTP calls below are the same
    // calls production would make.
    app.driveService.recordGrant({ googleSub: 'sub-iso', refreshToken: 'refresh-iso', scopes: DRIVE_SCOPE });
    const headers = { cookie: `storehub_session=${mintSession(app, 'sub-iso')}` };
    const payload = fakeBackupPayload();

    const { DatabaseSync } = await import('node:sqlite');
    const dumpFile = (file) => {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all()
          .map((r) => r.name)
          .sort();
        const rows = tables.map((t) => db.prepare(`SELECT * FROM ${t}`).all());
        // `auth_sessions.last_used_at` is session bookkeeping: every authenticated
        // request stamps it, so it necessarily moves. It is not data arriving from
        // the request, and holding it still would mean the guard had stopped
        // working. Normalising exactly this one column is what keeps the assertion
        // honest — anything else that moves is a real finding.
        for (const row of rows.flat()) {
          if ('last_used_at' in row) row.last_used_at = '<normalised>';
        }
        return { tables, rows };
      } finally {
        db.close();
      }
    };

    // Snapshot before.
    const licenceBefore = dumpFile(licenceFile);
    const driveBefore = dumpFile(driveFile);

    // Throw the payload at every route that exists, by every method.
    //
    // Two routes are deliberately absent, and for the same reason each:
    //
    //   - `/api/auth/logout` is *supposed* to delete the session.
    //   - `/api/drive/disconnect` is *supposed* to revoke the grant.
    //
    // Including a route that is supposed to change something would make
    // "nothing changed" the wrong assertion, and would invite someone to
    // normalise the change away instead of noticing a real one. Both are covered
    // on their own terms above; here the question is only whether a request body
    // can leave a mark.
    const paths = [
      ...DRIVE_ROUTES,
      '/api/admin/licenses',
      '/api/license/activate',
      '/api/license/verify',
      '/api/license/bind',
      '/api/admin/me',
      '/api/admin/licenses/lic-1',
    ];
    for (const path of paths) {
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        await request(app, path, { method, body: payload, headers });
      }
    }

    // Snapshot after.
    assert.deepEqual(dumpFile(licenceFile), licenceBefore, 'the licence database is byte-for-byte unchanged');
    assert.deepEqual(dumpFile(driveFile), driveBefore, 'the Drive database is byte-for-byte unchanged');

    // The product name reached neither file.
    for (const file of [licenceFile, driveFile]) {
      assert.ok(!fs.readFileSync(file).includes('قميص'), `${path.basename(file)} must not contain the product name`);
    }
  } finally {
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Creates a live session through the repository `buildApplication` wired. */
function mintSession(app, googleSub) {
  const repo = app.authRepository;
  assert.ok(repo, 'buildApplication returns its repositories, so no test hook is needed');
  repo.upsertAccount({ googleSub, email: 'iso@example.test', displayName: null, avatarUrl: null });
  const { sessionToken } = repo.createSession(googleSub, app.config.session.ttlMs, 'node-test');
  return sessionToken;
}

test('ISOLATION: no Drive response contains store data', async () => {
  const app = await createTestDriveApp({ connect: true });
  try {
    const token = app.signIn();
    const headers = app.cookieHeaders(token);

    const status = await request(app, '/api/drive/status', { method: 'GET', headers });
    const text = JSON.stringify(status.body);
    for (const forbidden of ['products', 'sales', 'purchases', 'suppliers', 'invoices', 'settings', 'image']) {
      assert.ok(!text.includes(forbidden), `status must not mention ${forbidden}`);
    }
  } finally {
    app.close();
  }
});

test('ISOLATION: the Drive service exposes no method that takes customer data', async () => {
  const app = await createTestDriveApp();
  try {
    const surface = Object.keys(app.driveService).sort();
    assert.deepEqual(
      surface,
      ['describe', 'disconnect', 'forgetCachedTokens', 'getAccessToken', 'isConfigured', 'recordGrant', 'scope'],
      'the Drive service is authorisation only: there is no put/upload/store method to mistake for one',
    );

    // Every repository method is about the grant, and none of them accepts
    // anything but a google sub, a refresh token or a scope.
    const repoSurface = Object.keys(app.driveRepository).sort();
    assert.deepEqual(
      repoSurface,
      ['close', 'deleteGrant', 'getGrant', 'listGranted', 'revokeGrant', 'saveGrant'],
    );
  } finally {
    app.close();
  }
});

test('ISOLATION: the backend holds no Google access token on disk', async () => {
  const app = await createTestDriveApp({
    fetchImpl: async () => tokenResponse({ accessToken: 'ya29.short-lived-access-token' }),
  });
  try {
    app.connect('refresh-token-alpha');
    await app.driveService.getAccessToken('shop-sub-1');

    const token = app.signIn();
    const res = await request(app, '/api/drive/token', {
      method: 'GET',
      headers: app.cookieHeaders(token),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.accessToken, 'ya29.short-lived-access-token');

    // It went out to the caller, but nothing stored it.
    const grantRows = app.driveDb.prepare('SELECT * FROM drive_grants').all();
    assert.ok(!JSON.stringify(grantRows).includes('ya29.short-lived-access-token'));

    // The accounts/sessions database does not hold it either. Read through the
    // repository's own read surface — the licence repository deliberately exposes
    // no raw handle, and reaching around it would undercut that decision.
    const account = app.authRepository.getAccount('shop-sub-1');
    assert.ok(account, 'the account is there');
    assert.ok(!JSON.stringify(account).includes('ya29.short-lived-access-token'));

    // And no licence row holds it. `listLicenses()` is the licence database's own
    // read surface; Phase 5 already asserts the licence schema has no column
    // that could hold customer data, so this only has to prove the token did not
    // get smuggled into a legitimate column.
    assert.ok(
      !JSON.stringify(app.repository.listLicenses()).includes('ya29.short-lived-access-token'),
      'no licence row holds an access token',
    );

    // The on-disk case is covered by the file-backed isolation test above, which
    // greps both files byte for byte.
  } finally {
    app.close();
  }
});

/* ================================================================== *
 * 6 · HTTP: DRIVE FLOW
 * ================================================================== */

test('FLOW: connecting Drive starts the existing Google OAuth flow', async () => {
  const app = await createTestDriveApp();
  try {
    const token = app.signIn();
    const res = await request(app, '/api/drive/connect/start', {
      method: 'GET',
      headers: app.cookieHeaders(token),
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.authUrl.startsWith('https://accounts.google.com/'));
    assert.ok(res.body.authUrl.includes('code_challenge='), 'PKCE, as in every other Store Hub flow');
    assert.ok(res.body.authUrl.includes('drive.file'));
    assert.match(res.body.authUrl, /[?&]state=[^&]+/, 'the state travels with the URL');
  } finally {
    app.close();
  }
});

test('FLOW: the callback refuses a consent that was started elsewhere', async () => {
  const app = await createTestDriveApp();
  // The callback drives a real `completeAuth`, so Google must be scripted —
  // otherwise this test would depend on the network and on Google's opinion of
  // a made-up code.
  const google = withFakeGoogle();
  try {
    const token = app.signIn();
    const headers = app.cookieHeaders(token);

    // A *customer* sign-in produces a state this callback must not honour.
    const customer = app.authService.startAuth({ intent: 'customer' });

    const res = await request(app, `/api/drive/connect/callback?code=abc&state=${encodeURIComponent(customer.state)}`, {
      method: 'GET',
      headers,
    });
    assert.notEqual(res.status, 200, 'a customer flow cannot be finished as a Drive consent');
    assert.deepEqual([...app.driveRepository.listGranted()], [], 'and no grant was recorded');
  } finally {
    google.dispose();
    app.close();
  }
});

test('FLOW: a drive consent completes, sets the session, and reports connected', async () => {
  const app = await createTestDriveApp();
  const google = withFakeGoogle({ refreshToken: 'refresh-from-callback' });
  try {
    const headers = app.cookieHeaders(app.signIn());
    const flow = app.authService.startAuth({ intent: 'drive' });

    const res = await request(
      app,
      `/api/drive/connect/callback?code=abc&state=${encodeURIComponent(flow.state)}`,
      { method: 'GET', headers },
    );

    assert.equal(res.status, 200, 'the popup is answered with a page, not a redirect');
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /postMessage/, 'the result travels back to the opener by postMessage');
    assert.match(
      [].concat(res.headers['set-cookie']).join(';'),
      /storehub_session=/,
      'and the popup is signed in',
    );
    assert.deepEqual([...app.driveRepository.listGranted()], ['shop-sub-1']);
  } finally {
    google.dispose();
    app.close();
  }
});

test('FLOW: the callback reads no return URL from the request', async () => {
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/http.js', import.meta.url), 'utf8'),
  );
  const block = source.slice(source.indexOf("route.handler === 'driveConnectCallback'"));
  const body = block.slice(0, block.indexOf('driveDisconnect'));

  // `portalUrl` is the admin flow's redirect and must not have leaked into the
  // Drive one, and nothing may be redirected to a caller-supplied value.
  assert.ok(!/portalUrl/.test(body), 'the Drive callback does not redirect to a configured portal URL');
  assert.ok(!/readQueryParam\(query, ['"](url|next|redirect|return)/.test(body), 'no return URL is read');
  assert.ok(/postMessage/.test(body), 'the result is handed back by postMessage instead');
});

test('FLOW: drive.file means the app can only find its own folder', async () => {
  // A behavioural consequence of the scope, asserted on the queries the client
  // actually builds. There is no user-wide listing to fall back on: the folder
  // search names the folder and its mime type, and the file search can only
  // address a parent folder id.
  const client = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../../js/drive-client.js', import.meta.url), 'utf8'),
  );

  assert.ok(!/corpora/.test(client), 'no drive-wide listing query exists');
  assert.ok(!/spaces\/drive/.test(client), 'nothing enumerates the whole drive');

  // The folder lookup is by exact name *and* folder mime type.
  assert.match(
    client,
    /name='\$\{name\}' and mimeType='\$\{FOLDER_MIME\}' and trashed=false/,
    'the folder search requires the exact name and the folder mime type',
  );

  // The file listing is scoped to a parent folder id, never to a bare name.
  assert.match(
    client,
    /escapeQueryValue\(options\.folderId\)\}' in parents and trashed=false/,
    'file listings are scoped to the folder the app itself created',
  );

  // Every listing passes an explicit `fields` list, so Drive cannot hand back
  // more than the app asked for.
  const listCalls = client.match(/files\?q=/g) ?? [];
  const withFields = client.match(/files\?q=[^\n]*fields=/g) ?? [];
  assert.equal(listCalls.length, withFields.length, 'every list query asks for named fields only');
});

/* ================================================================== *
 * 7 · CONFIGURATION
 * ================================================================== */

test('CONFIG: Drive settings are configurable and default to off-the-clock', () => {
  const base = { NODE_ENV: 'test', STOREHUB_PEPPER: TEST_PEPPER, STOREHUB_DB: ':memory:' };

  const defaults = loadConfig(base);
  assert.equal(defaults.drive.folderName, 'Store Hub Backups');
  assert.equal(defaults.drive.enabled, true);
  assert.equal(
    defaults.drive.databaseFile,
    ':memory:',
    'memory mode covers the Drive database too — a test must not write a real credential store to disk',
  );

  const custom = loadConfig({ ...base, STOREHUB_DRIVE: '0', STOREHUB_DRIVE_FOLDER: ' backups ', STOREHUB_DRIVE_DB: '/tmp/d.db' });
  assert.equal(custom.drive.enabled, false);
  assert.equal(custom.drive.folderName, 'backups', 'trimmed, and an empty name falls back to the default');
  assert.equal(custom.drive.databaseFile, '/tmp/d.db');

  const blank = loadConfig({ ...base, STOREHUB_DRIVE_FOLDER: '   ' });
  assert.equal(blank.drive.folderName, 'Store Hub Backups', 'a blank folder name cannot create an unnamed folder');
});

test('CONFIG: the Drive database is a different file from the licence database', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    STOREHUB_PEPPER: TEST_PEPPER,
    STOREHUB_DB: './data/storehub.db',
  });
  assert.notEqual(
    config.drive.databaseFile,
    config.databaseFile,
    'a long-lived credential must not share a file with licence tables',
  );
});

/* ================================================================== *
 * 8 · NO SECRETS IN THE SOURCE
 * ================================================================== */

test('SECURITY: no hardcoded credential or client secret exists in the Drive source', async () => {
  const fs = await import('node:fs');
  const dir = new URL('../src/', import.meta.url);
  const files = ['drive-service.js', 'drive-repository.js', 'http.js', 'config.js', 'index.js'];

  for (const name of files) {
    const source = fs.readFileSync(new URL(name, dir), 'utf8');
    assert.ok(
      !/['"][0-9]+-[a-z0-9]{20,}\.apps\.googleusercontent\.com['"]/.test(source),
      `${name} must not hardcode a Google client id`,
    );
    assert.ok(
      !/GOCSPX-/.test(source),
      `${name} must not hardcode a Google client secret`,
    );
    assert.ok(!/BEGIN [A-Z ]*PRIVATE KEY/.test(source), `${name} must not contain a private key`);
    // The client secret may only ever be *read*, never written down.
    assert.ok(!/clientSecret\s*[:=]\s*['"][^'"]+['"]/.test(source), `${name} must not assign a literal client secret`);
  }

  // And the repository has no default pepper that would silently make the
  // encryption decorative.
  const repo = fs.readFileSync(new URL('drive-repository.js', dir), 'utf8');
  assert.ok(!/pepper\s*=\s*['"][^'"]+['"]/.test(repo), 'the grant key is derived from a passed-in pepper only');
});

test('SECURITY: the repository is built from an injected pepper', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    applyDriveMigrations(db);
    const repo = createDriveRepository(db, { clock: () => 1, pepper: 'pepper-one-value-0123456789abcdef' });
    repo.saveGrant('sub-x', 'refresh-secret', DRIVE_SCOPE);
    assert.equal(repo.getGrant('sub-x').refreshToken, 'refresh-secret');
  } finally {
    db.close();
  }
});

test('SECURITY: the client Drive code carries no client secret and no token store', async () => {
  const fs = await import('node:fs');
  for (const name of ['backup.js', 'drive-client.js', 'drive-auth-client.js', 'backup-scheduler.js']) {
    const source = fs.readFileSync(new URL(`../../js/${name}`, import.meta.url), 'utf8');
    assert.ok(!/GOCSPX-/.test(source), `${name} must not contain a Google client secret`);
    assert.ok(!/client_secret/.test(source), `${name} must not exchange an auth code (no secret to use)`);
    // No persistence of a credential: the only storage keys in the scheduler are
    // the metadata ones.
    assert.ok(
      !/localStorage\.setItem\(['"](access|refresh|token)/i.test(source),
      `${name} must not persist a Google token`,
    );
  }
});

test('SECURITY: the backup record carries no token field', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('../../js/identity-store.js', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('export async function saveBackupRecord'));
  assert.ok(!/token/i.test(block), 'no token may be added to the local backup record');
  assert.ok(!/access_token|refresh_token/i.test(block));
});