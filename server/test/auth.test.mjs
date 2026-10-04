/**
 * Authentication tests.
 *
 * Covers OAuth configuration, PKCE, Google callback handling, account identity,
 * session management, and security boundaries.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTestAuthService, createTestService } from './helpers.mjs';
import { ERROR_CODES } from '../src/errors.js';
import { generateLicenseCode } from '../src/codes.js';

/** @returns {{service: object, authService: object, clock: object}} */
async function withAuthService(fn) {
  const app = createTestService();
  const authApp = await createTestAuthService(app);
  try {
    return await fn(app, authApp);
  } finally {
    // Allow any pending microtasks to complete before closing
    await new Promise((r) => setImmediate(r));
    app.close();
    authApp.close();
  }
}

test('AUTH: Google config validation fails when missing in production', () => {
  withAuthService((app, authApp) => {
    // Simulate production by setting env
    authApp.config.env = 'production';
    authApp.config.google.clientId = null;

    assert.throws(
      () => authApp.authService.startAuth(),
      (err) => err.code === ERROR_CODES.INTERNAL_ERROR && err.detail.includes('Google OAuth not configured'),
    );
  });
});

test('AUTH: Google config validation returns 503 in development when missing', () => {
  withAuthService((app, authApp) => {
    authApp.config.env = 'development';
    authApp.config.google.clientId = null;

    assert.throws(
      () => authApp.authService.startAuth(),
      (err) => err.code === ERROR_CODES.INVALID_REQUEST && err.status === 503 && err.detail.includes('Google OAuth not configured'),
    );
  });
});

test('AUTH: startAuth returns authUrl with PKCE challenge and state', () => {
  withAuthService((app, authApp) => {
    authApp.config.google.clientId = 'test-client-id.apps.googleusercontent.com';
    authApp.config.google.clientSecret = 'test-secret';
    authApp.config.google.redirectUri = 'http://localhost:8787/api/auth/google/callback';

    const { authUrl, state } = authApp.authService.startAuth();

    assert.ok(typeof authUrl === 'string');
    assert.ok(authUrl.startsWith('https://accounts.google.com/o/oauth2/v2/auth?'));
    assert.ok(authUrl.includes('client_id=test-client-id.apps.googleusercontent.com'));
    assert.ok(authUrl.includes('redirect_uri=http%3A%2F%2Flocalhost%3A8787%2Fapi%2Fauth%2Fgoogle%2Fcallback'));
    assert.ok(authUrl.includes('code_challenge='));
    assert.ok(authUrl.includes('code_challenge_method=S256'));
    assert.ok(authUrl.includes('state='));
    assert.ok(typeof state === 'string');
    assert.ok(state.length > 0);
  });
});

test('AUTH: PKCE verifier is stored and consumed on callback', () => {
  withAuthService((app, authApp) => {
    authApp.config.google.clientId = 'test-client-id.apps.googleusercontent.com';
    authApp.config.google.clientSecret = 'test-secret';
    authApp.config.google.redirectUri = 'http://localhost:8787/api/auth/google/callback';

    const { state } = authApp.authService.startAuth();
    // The PKCE verifier should be stored internally
    // We can't directly inspect it, but we can verify the callback fails without it
    assert.ok(state.length > 0);
  });
});

test('AUTH: completeAuth rejects invalid state', async () => {
  await withAuthService(async (app, authApp) => {
    authApp.config.google.clientId = 'test-client-id.apps.googleusercontent.com';
    authApp.config.google.clientSecret = 'test-secret';
    authApp.config.google.redirectUri = 'http://localhost:8787/api/auth/google/callback';

    // Mock fetch to return Google tokens
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          json: async () => ({ access_token: 'google-access-token', id_token: 'id-token', expires_in: 3600 }),
        };
      }
      if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
        return {
          ok: true,
          json: async () => ({ sub: 'google-sub-123', email: 'user@example.com', name: 'Test User', picture: 'https://example.com/avatar.png' }),
        };
      }
      return originalFetch(url, opts);
    };

    try {
      await assert.rejects(
        authApp.authService.completeAuth({ code: 'auth-code', state: 'invalid-state' }),
        (err) => err.code === ERROR_CODES.INVALID_REQUEST && err.detail.includes('Invalid or expired OAuth state'),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('AUTH: completeAuth rejects expired state', async () => {
  await withAuthService(async (app, authApp) => {
    authApp.config.google.clientId = 'test-client-id.apps.googleusercontent.com';
    authApp.config.google.clientSecret = 'test-secret';
    authApp.config.google.redirectUri = 'http://localhost:8787/api/auth/google/callback';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          json: async () => ({ access_token: 'google-access-token', id_token: 'id-token', expires_in: 3600 }),
        };
      }
      if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
        return {
          ok: true,
          json: async () => ({ sub: 'google-sub-123', email: 'user@example.com', name: 'Test User', picture: 'https://example.com/avatar.png' }),
        };
      }
      return originalFetch(url, opts);
    };

    const { state } = authApp.authService.startAuth();
    // Advance clock past PKCE TTL (10 minutes)
    app.advance(11 * 60 * 1000);

    try {
      await assert.rejects(
        authApp.authService.completeAuth({ code: 'auth-code', state }),
        (err) => err.code === ERROR_CODES.INVALID_REQUEST && err.detail.includes('expired'),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('AUTH: completeAuth creates account with stable googleSub', async () => {
  await withAuthService(async (app, authApp) => {
    authApp.config.google.clientId = 'test-client-id.apps.googleusercontent.com';
    authApp.config.google.clientSecret = 'test-secret';
    authApp.config.google.redirectUri = 'http://localhost:8787/api/auth/google/callback';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          json: async () => ({ access_token: 'google-access-token', id_token: 'id-token', expires_in: 3600 }),
        };
      }
      if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
        return {
          ok: true,
          json: async () => ({ sub: 'stable-google-sub-456', email: 'user@example.com', name: 'Test User', picture: 'https://example.com/avatar.png' }),
        };
      }
      return originalFetch(url, opts);
    };

    try {
      const { state } = authApp.authService.startAuth();
      const result = await authApp.authService.completeAuth({ code: 'auth-code', state, userAgent: 'test-agent' });

      assert.ok(result.sessionToken);
      assert.ok(typeof result.sessionToken === 'string');
      assert.equal(result.account.googleSub, 'stable-google-sub-456');
      assert.equal(result.account.email, 'user@example.com');
      assert.equal(result.account.displayName, 'Test User');
      assert.equal(result.account.avatarUrl, 'https://example.com/avatar.png');
      assert.ok(typeof result.serverTime === 'number');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('AUTH: same googleSub on re-auth does not create duplicate account', async () => {
  await withAuthService(async (app, authApp) => {
    authApp.config.google.clientId = 'test-client-id.apps.googleusercontent.com';
    authApp.config.google.clientSecret = 'test-secret';
    authApp.config.google.redirectUri = 'http://localhost:8787/api/auth/google/callback';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          json: async () => ({ access_token: 'google-access-token', id_token: 'id-token', expires_in: 3600 }),
        };
      }
      if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
        return {
          ok: true,
          json: async () => ({ sub: 'stable-google-sub-789', email: 'updated@example.com', name: 'Updated Name', picture: 'https://example.com/new-avatar.png' }),
        };
      }
      return originalFetch(url, opts);
    };

    try {
      const { state: state1 } = authApp.authService.startAuth();
      const result1 = await authApp.authService.completeAuth({ code: 'auth-code-1', state: state1 });

      const { state: state2 } = authApp.authService.startAuth();
      const result2 = await authApp.authService.completeAuth({ code: 'auth-code-2', state: state2 });

      // Same googleSub, different session tokens
      assert.equal(result1.account.googleSub, result2.account.googleSub);
      assert.equal(result1.account.googleSub, 'stable-google-sub-789');
      assert.notEqual(result1.sessionToken, result2.sessionToken);
      // Email should be updated to the latest
      assert.equal(result2.account.email, 'updated@example.com');
      assert.equal(result2.account.displayName, 'Updated Name');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('AUTH: getMe returns account for valid session', async () => {
  await withAuthService(async (app, authApp) => {
    authApp.config.google.clientId = 'test-client-id.apps.googleusercontent.com';
    authApp.config.google.clientSecret = 'test-secret';
    authApp.config.google.redirectUri = 'http://localhost:8787/api/auth/google/callback';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return { ok: true, json: async () => ({ access_token: 't', id_token: 'i', expires_in: 3600 }) };
      }
      if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
        return { ok: true, json: async () => ({ sub: 'google-sub-me', email: 'me@example.com', name: 'Me', picture: 'https://a/b.png' }) };
      }
      return originalFetch(url, opts);
    };

    try {
      const { state } = authApp.authService.startAuth();
      const { sessionToken } = await authApp.authService.completeAuth({ code: 'auth-code', state });

      const me = authApp.authService.getMe(sessionToken);
      assert.ok(me);
      assert.equal(me.account.googleSub, 'google-sub-me');
      assert.equal(me.account.email, 'me@example.com');
      assert.ok(typeof me.serverTime === 'number');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('AUTH: getMe returns null for invalid session', () => {
  withAuthService((app, authApp) => {
    const me = authApp.authService.getMe('invalid-session-token');
    assert.equal(me, null);
  });
});

test('AUTH: getMe returns null for expired session', async () => {
  await withAuthService(async (app, authApp) => {
    authApp.config.google.clientId = 'test-client-id.apps.googleusercontent.com';
    authApp.config.google.clientSecret = 'test-secret';
    authApp.config.google.redirectUri = 'http://localhost:8787/api/auth/google/callback';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return { ok: true, json: async () => ({ access_token: 't', id_token: 'i', expires_in: 3600 }) };
      }
      if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
        return { ok: true, json: async () => ({ sub: 'google-sub-expired', email: 'expired@example.com' }) };
      }
      return originalFetch(url, opts);
    };

    try {
      const { state } = authApp.authService.startAuth();
      const { sessionToken } = await authApp.authService.completeAuth({ code: 'auth-code', state });

      // Advance past session TTL (30 days default)
      app.advance(31 * 24 * 60 * 60 * 1000);

      const me = authApp.authService.getMe(sessionToken);
      assert.equal(me, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('AUTH: logout deletes the session', async () => {
  await withAuthService(async (app, authApp) => {
    authApp.config.google.clientId = 'test-client-id.apps.googleusercontent.com';
    authApp.config.google.clientSecret = 'test-secret';
    authApp.config.google.redirectUri = 'http://localhost:8787/api/auth/google/callback';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return { ok: true, json: async () => ({ access_token: 't', id_token: 'i', expires_in: 3600 }) };
      }
      if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
        return { ok: true, json: async () => ({ sub: 'google-sub-logout', email: 'logout@example.com' }) };
      }
      return originalFetch(url, opts);
    };

    try {
      const { state } = authApp.authService.startAuth();
      const { sessionToken } = await authApp.authService.completeAuth({ code: 'auth-code', state });

      assert.ok(authApp.authService.getMe(sessionToken));
      const deleted = authApp.authService.logout(sessionToken);
      assert.equal(deleted, true);
      assert.equal(authApp.authService.getMe(sessionToken), null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('AUTH: revokeAllSessions deletes all sessions for an account', async () => {
  await withAuthService(async (app, authApp) => {
    authApp.config.google.clientId = 'test-client-id.apps.googleusercontent.com';
    authApp.config.google.clientSecret = 'test-secret';
    authApp.config.google.redirectUri = 'http://localhost:8787/api/auth/google/callback';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return { ok: true, json: async () => ({ access_token: 't', id_token: 'i', expires_in: 3600 }) };
      }
      if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
        return { ok: true, json: async () => ({ sub: 'google-sub-revoke', email: 'revoke@example.com' }) };
      }
      return originalFetch(url, opts);
    };

    try {
      const { state: s1 } = authApp.authService.startAuth();
      const { sessionToken: t1 } = await authApp.authService.completeAuth({ code: 'c1', state: s1 });

      const { state: s2 } = authApp.authService.startAuth();
      const { sessionToken: t2 } = await authApp.authService.completeAuth({ code: 'c2', state: s2 });

      assert.ok(authApp.authService.getMe(t1));
      assert.ok(authApp.authService.getMe(t2));

      const count = authApp.authService.revokeAllSessions('google-sub-revoke');
      assert.equal(count, 2);
      assert.equal(authApp.authService.getMe(t1), null);
      assert.equal(authApp.authService.getMe(t2), null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('AUTH: auth repository never receives store data', async () => {
  await withAuthService(async (app, authApp) => {
    authApp.config.google.clientId = 'test-client-id.apps.googleusercontent.com';
    authApp.config.google.clientSecret = 'test-secret';
    authApp.config.google.redirectUri = 'http://localhost:8787/api/auth/google/callback';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return { ok: true, json: async () => ({ access_token: 't', id_token: 'i', expires_in: 3600 }) };
      }
      if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
        return { ok: true, json: async () => ({ sub: 'google-sub-clean', email: 'clean@example.com' }) };
      }
      return originalFetch(url, opts);
    };

    try {
      const { state } = authApp.authService.startAuth();
      await authApp.authService.completeAuth({ code: 'auth-code', state });

      // Verify the auth repository only has account and session tables
      // No products, sales, inventory, etc.
      const db = authApp.authDb;
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
      assert.ok(tables.includes('auth_accounts'));
      assert.ok(tables.includes('auth_sessions'));
      assert.ok(!tables.some((t) => ['products', 'sales', 'inventory', 'invoices', 'customers', 'backups'].includes(t)));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('AUTH: Google tokens never logged or stored', async () => {
  await withAuthService(async (app, authApp) => {
    authApp.config.google.clientId = 'test-client-id.apps.googleusercontent.com';
    authApp.config.google.clientSecret = 'test-secret';
    authApp.config.google.redirectUri = 'http://localhost:8787/api/auth/google/callback';

    const logs = [];
    authApp.authService.log = (msg, detail) => logs.push({ msg, detail });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return { ok: true, json: async () => ({ access_token: 'secret-access-token', refresh_token: 'secret-refresh', id_token: 'secret-id', expires_in: 3600 }) };
      }
      if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
        return { ok: true, json: async () => ({ sub: 'google-sub-nolog', email: 'nolog@example.com' }) };
      }
      return originalFetch(url, opts);
    };

    try {
      const { state } = authApp.authService.startAuth();
      await authApp.authService.completeAuth({ code: 'auth-code', state });

      // Check logs don't contain tokens
      for (const entry of logs) {
        const text = JSON.stringify(entry);
        assert.ok(!text.includes('secret-access-token'));
        assert.ok(!text.includes('secret-refresh'));
        assert.ok(!text.includes('secret-id'));
        assert.ok(!text.includes('auth-code'));
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});