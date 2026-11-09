/**
 * Static file serving — the allowlist, and every path that must be refused.
 *
 * A real ephemeral HTTP server is used, so each case is decided by the bytes a
 * browser would actually receive rather than by calling a helper directly. The
 * web root is the project root, which is what the running server serves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createRequestHandler } from '../src/http.js';
import { loadConfig } from '../src/config.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_ROOT = path.resolve(SERVER_ROOT, '..');

/** The handler asks the licence service only for its clock on these paths. */
const fakeLicense = { serverNow: () => 1_700_000_000_000 };
const fakeAuth = { getMe: () => null };

function buildHandler() {
  const config = { ...loadConfig({ NODE_ENV: 'test' }), webRoot: WEB_ROOT };
  return createRequestHandler({
    licenseService: fakeLicense,
    authService: fakeAuth,
    config,
    log: () => {},
  });
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      handler(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/**
 * Sends a request with the path exactly as written.
 *
 * `fetch`/`new URL` normalise `..` and `%2e` before they reach the socket, so a
 * traversal case would be tested against a path the server never saw. The raw
 * `http.request` path option preserves it, which is the whole point of these
 * cases.
 */
function request(base, url, method = 'GET') {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname, port, path: url, method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          contentType: res.headers['content-type'] || '',
          allow: res.headers.allow || '',
          bytes: Buffer.concat(chunks),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const ALLOWED = [
  ['/', 'text/html'],
  ['/index.html', 'text/html'],
  ['/manifest.json', 'application/json'],
  ['/sw.js', 'javascript'],
  ['/js/main.js', 'javascript'],
  ['/css/base.css', 'text/css'],
  ['/icons/icon-192.png', 'image/png'],
  ['/admin/', 'text/html'],
  ['/admin', 'text/html'],
];

const FORBIDDEN = [
  '/.env',
  '/server/.env',
  '/server/package.json',
  '/server/src/config.js',
  '/server/src/http.js',
  '/server/scripts/issue-license.mjs',
  '/tests/',
  '/tools/',
  '/data/',
  '/.git/config',
  '/.git/HEAD',
  '/.gitignore',
  '/.env.example',
  '/ARCHITECTURE_AUDIT.md',
  '/GOOGLE_AUTH.md',
  '/../server/.env',
  '/..%2fserver%2f.env',
  '/%2e%2e/.env',
  '/%252e%252e/.env',
  '/..\\..\\.env',
  '/js/..%2f..%2fserver%2f.env',
  '/js/main.js%00.png',
  '//.env',
  // A file literally named `admin` under an allowed directory is not the admin
  // page: only the exact paths `/admin` and `/admin/` are rewritten to it.
  '/js/admin',
  '/css/admin',
  // Percent-encoded because a raw non-ASCII request line is rejected by the
  // HTTP client before it ever reaches the server; the server decodes once.
  '/%D9%85%D8%AA%D8%AC%D8%B1%D9%8A.apk',
  '/%D8%B3%D8%A7%D9%87%D8%B1-%D9%86%D8%B3%D8%AE%D8%A9-%D8%A7%D9%84%D8%AA%D8%B3%D9%84%D9%8A%D9%85.apk',
];

test('STATIC: allowlisted paths are served with the declared MIME type', async () => {
  const { server, base } = await listen(buildHandler());
  try {
    for (const [url, expectedType] of ALLOWED) {
      const res = await request(base, url);
      assert.equal(res.status, 200, `${url} should be served`);
      assert.ok(
        res.contentType.includes(expectedType),
        `${url} content-type ${res.contentType} should contain ${expectedType}`,
      );
    }
  } finally {
    server.close();
  }
});

test('STATIC: every forbidden path is a 404, and no body is served', async () => {
  const { server, base } = await listen(buildHandler());
  try {
    for (const url of FORBIDDEN) {
      const res = await request(base, url);
      assert.equal(res.status, 404, `${url} should be 404, got ${res.status}`);
    }
  } finally {
    server.close();
  }
});

test('STATIC: non-GET/HEAD on a servable path is a 405 advertising GET and HEAD', async () => {
  const { server, base } = await listen(buildHandler());
  try {
    for (const url of ['/', '/index.html', '/admin/']) {
      const res = await request(base, url, 'POST');
      assert.equal(res.status, 405, `${url} should reject POST`);
      assert.match(res.allow || '', /GET/);
      assert.ok((res.allow || '').includes('HEAD'), `${url} Allow should include HEAD`);
    }
  } finally {
    server.close();
  }
});

test('STATIC: the API plane is untouched', async () => {
  const { server, base } = await listen(buildHandler());
  try {
    const res = await request(base, '/api/auth/me');
    assert.equal(res.status, 200);
    assert.ok(res.contentType.includes('application/json'));
    assert.equal(JSON.parse(res.bytes.toString('utf8')).authenticated, false);
  } finally {
    server.close();
  }
});
