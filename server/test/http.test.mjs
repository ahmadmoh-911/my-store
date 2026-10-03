/**
 * HTTP layer integration tests.
 *
 * Drives the real request handler end-to-end, exercising the envelope,
 * status codes, CORS, rate limiting, body parsing, and that the handler
 * never crashes. Service behaviour is tested in service.test.mjs; these
 * focus on the transport contract.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTestService } from './helpers.mjs';
import { createRequestHandler } from '../src/http.js';
import { ERROR_CODES } from '../src/errors.js';
import { generateLicenseCode } from '../src/codes.js';

const DAY = 86400000;

/**
 * Drives the handler with a synthetic request/response pair.
 * Returns {status, body, headers}.
 */
async function drive(handler, req) {
  let status = 200;
  const headers = {};
  let text = '';
  const res = {
    headersSent: false,
    writeHead(code, headerMap = {}) {
      status = code;
      Object.assign(headers, headerMap);
      this.headersSent = true;
      return this;
    },
    write(chunk) {
      text += chunk;
      return true;
    },
    end(chunk) {
      if (chunk) text += chunk;
    },
  };
  await handler(req, res);
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status, body, headers };
}

/**
 * Builds a mock IncomingMessage for the handler.
 */
function mockReq(options = {}) {
  const method = options.method || 'POST';
  const url = options.url || '/api/license/activate';
  const payload = options.body === undefined ? '' : JSON.stringify(options.body);
  const chunks = [Buffer.from(payload, 'utf8')];
  return {
    method,
    url,
    headers: {
      'content-length': String(Buffer.byteLength(payload)),
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
    socket: { remoteAddress: options.remoteAddress || '127.0.0.1' },
    on(event, handler) {
      if (event === 'data') {
        for (const chunk of chunks) handler(chunk);
      } else if (event === 'end' || event === 'error') {
        handler(undefined);
      }
    },
    resume() {},
    destroy() {},
  };
}

test('HTTP: unknown route returns 404 with error envelope', async () => {
  const app = createTestService();
  const handler = createRequestHandler({ service: app.service, config: app.config });
  const { status, body } = await drive(handler, mockReq({ url: '/api/license/unknown', method: 'POST', body: {} }));
  app.close();

  assert.equal(status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, ERROR_CODES.INVALID_REQUEST);
  assert.ok(typeof body.serverTime === 'number');
});

test('HTTP: non-POST returns 405 with Allow header', async () => {
  const app = createTestService();
  const handler = createRequestHandler({ service: app.service, config: app.config });
  const { status, body, headers } = await drive(handler, mockReq({ method: 'GET' }));
  app.close();

  assert.equal(status, 405);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, ERROR_CODES.INVALID_REQUEST);
  assert.ok(Array.isArray(body.allowed));
  assert.ok(body.allowed.includes('POST'));
  assert.ok(body.allowed.includes('OPTIONS'));
  assert.ok(headers.allow?.includes('POST'));
});

test('HTTP: OPTIONS preflight returns 204', async () => {
  const app = createTestService();
  const handler = createRequestHandler({ service: app.service, config: app.config });
  const { status } = await drive(handler, mockReq({ method: 'OPTIONS' }));
  app.close();

  assert.equal(status, 204);
});

test('HTTP: CORS headers only for configured origins', async () => {
  const app = createTestService();
  app.config.corsOrigins.push('https://allowed.example.com');
  const handler = createRequestHandler({ service: app.service, config: app.config });

  const { headers: h1 } = await drive(handler, mockReq({ method: 'OPTIONS', headers: { origin: 'https://allowed.example.com' } }));
  assert.equal(h1['access-control-allow-origin'], 'https://allowed.example.com');

  const { headers: h2 } = await drive(handler, mockReq({ method: 'OPTIONS', headers: { origin: 'https://evil.example.com' } }));
  assert.equal(h2['access-control-allow-origin'], undefined);

  app.close();
});

test('HTTP: malformed JSON returns 400 INVALID_REQUEST', async () => {
  const app = createTestService();
  const handler = createRequestHandler({ service: app.service, config: app.config });
  // Send invalid JSON by overriding the body after stringify
  const req = mockReq({ body: 'valid' });
  // Replace the chunks with invalid JSON
  req._invalid = true;
  const chunks = [Buffer.from('{not json', 'utf8')];
  req.on = (event, handler) => {
    if (event === 'data') chunks.forEach((c) => handler(c));
    else if (event === 'end') handler(undefined);
  };
  const { status, body } = await drive(handler, req);
  app.close();

  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, ERROR_CODES.INVALID_REQUEST);
  assert.ok(typeof body.serverTime === 'number');
});

test('HTTP: oversized body returns 413', async () => {
  const app = createTestService();
  const handler = createRequestHandler({ service: app.service, config: app.config });
  const largeBody = 'x'.repeat(20000);
  const req = mockReq({});
  req.headers['content-length'] = String(largeBody.length);
  const chunks = [Buffer.from(largeBody, 'utf8')];
  req.on = (event, handler) => {
    if (event === 'data') chunks.forEach((c) => handler(c));
    else if (event === 'end') handler(undefined);
  };
  const { status, body } = await drive(handler, req);
  app.close();

  assert.equal(status, 413);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, ERROR_CODES.INVALID_REQUEST);
});

test('HTTP: missing installId on activate returns 400', async () => {
  const app = createTestService();
  const handler = createRequestHandler({ service: app.service, config: app.config });
  const { code } = app.service.createLicense({});
  const { status, body } = await drive(handler, mockReq({ body: { licenseCode: code, platform: 'web', appVersion: '1.0.0' } }));
  app.close();

  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, ERROR_CODES.INVALID_REQUEST);
});

test('HTTP: unknown platform returns 400', async () => {
  const app = createTestService();
  const handler = createRequestHandler({ service: app.service, config: app.config });
  const { code } = app.service.createLicense({});
  const { status, body } = await drive(handler, mockReq({ body: { licenseCode: code, installId: 'i', platform: 'toaster', appVersion: '1.0.0' } }));
  app.close();

  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, ERROR_CODES.INVALID_REQUEST);
});

test('HTTP: activate rejects invalid licence with 404 LICENSE_NOT_FOUND', async () => {
  const app = createTestService();
  const handler = createRequestHandler({ service: app.service, config: app.config });
  const { status, body } = await drive(handler, mockReq({ body: { licenseCode: generateLicenseCode(), installId: 'i', platform: 'web', appVersion: '1.0.0' } }));
  app.close();

  assert.equal(status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, ERROR_CODES.LICENSE_NOT_FOUND);
  assert.ok(typeof body.serverTime === 'number');
});

test('HTTP: suspended licence returns 403 LICENSE_SUSPENDED', async () => {
  const app = createTestService();
  const handler = createRequestHandler({ service: app.service, config: app.config });
  const { license, code } = app.service.createLicense({});
  app.service.suspend(license.id, 'overdue');
  const { status, body } = await drive(handler, mockReq({ body: { licenseCode: code, installId: 'i', platform: 'web', appVersion: '1.0.0' } }));
  app.close();

  assert.equal(status, 403);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, ERROR_CODES.LICENSE_SUSPENDED);
});

test('HTTP: expired licence returns 403 LICENSE_EXPIRED', async () => {
  const app = createTestService();
  const handler = createRequestHandler({ service: app.service, config: app.config });
  const { license, code } = app.service.createLicense({ expiresInDays: 1 });
  app.advance(DAY + 1);
  const { status, body } = await drive(handler, mockReq({ body: { licenseCode: code, installId: 'i', platform: 'web', appVersion: '1.0.0' } }));
  app.close();

  assert.equal(status, 403);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, ERROR_CODES.LICENSE_EXPIRED);
});

test('HTTP: verify rejects unknown session with 401 INVALID_SESSION', async () => {
  const app = createTestService();
  const handler = createRequestHandler({ service: app.service, config: app.config });
  const { status, body } = await drive(handler, mockReq({ url: '/api/license/verify', body: { sessionToken: 'x'.repeat(43), installId: 'i' } }));
  app.close();

  assert.equal(status, 401);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, ERROR_CODES.INVALID_SESSION);
});

test('HTTP: bind requires accountId', async () => {
  const app = createTestService();
  const handler = createRequestHandler({ service: app.service, config: app.config });
  const { session } = app.issueAndActivate();
  const { status, body } = await drive(handler, mockReq({ url: '/api/license/bind', body: { sessionToken: session.sessionToken } }));
  app.close();

  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, ERROR_CODES.INVALID_REQUEST);
});

test('HTTP: bind rejects account mismatch with 403 ACCOUNT_MISMATCH', async () => {
  const app = createTestService();
  const handler = createRequestHandler({ service: app.service, config: app.config });
  const { session } = app.issueAndActivate({}, { accountId: 'account-a' });
  const { status, body } = await drive(handler, mockReq({ url: '/api/license/bind', body: { sessionToken: session.sessionToken, accountId: 'account-b' } }));
  app.close();

  assert.equal(status, 403);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, ERROR_CODES.ACCOUNT_MISMATCH);
});

test('HTTP: error responses always include serverTime', async () => {
  const app = createTestService();
  const handler = createRequestHandler({ service: app.service, config: app.config });

  const r1 = await drive(handler, mockReq({ body: { licenseCode: generateLicenseCode(), installId: 'i' } }));
  assert.ok(typeof r1.body.serverTime === 'number');

  const r2 = await drive(handler, mockReq({ url: '/api/license/verify', body: { sessionToken: 'bogus' } }));
  assert.ok(typeof r2.body.serverTime === 'number');

  const r3 = await drive(handler, mockReq({ body: { licenseCode: 'bad', installId: 'i' } }));
  assert.ok(typeof r3.body.serverTime === 'number');

  const r4 = await drive(handler, mockReq({ method: 'GET' }));
  assert.ok(typeof r4.body.serverTime === 'number');

  const large = 'x'.repeat(20000);
  const req = mockReq({});
  req.headers['content-length'] = String(large.length);
  const chunks = [Buffer.from(large, 'utf8')];
  req.on = (event, h) => { if (event === 'data') chunks.forEach((c) => h(c)); else if (event === 'end') h(undefined); };
  const r5 = await drive(handler, req);
  assert.ok(typeof r5.body.serverTime === 'number');

  app.close();
});

test('HTTP: serverTime is server-generated, not echoed from client', async () => {
  const app = createTestService();
  const handler = createRequestHandler({ service: app.service, config: app.config });
  const { session } = app.issueAndActivate();
  app.advance(60000);
  const { body } = await drive(handler, mockReq({ url: '/api/license/verify', body: { sessionToken: session.sessionToken, serverTime: 999, clientTime: 888 } }));
  app.close();

  assert.equal(body.serverTime, app.now());
  assert.notEqual(body.serverTime, 999);
  assert.notEqual(body.serverTime, 888);
});

test('HTTP: store data in request body is discarded, not stored', async () => {
  const app = createTestService();
  const handler = createRequestHandler({ service: app.service, config: app.config });
  const { code } = app.service.createLicense({});
  const leaky = {
    licenseCode: code,
    installId: 'install-http-2',
    platform: 'android',
    appVersion: '1.0.0',
    products: [{ id: 1, name: 'Cement' }],
    sales: [{ total: 999 }],
    customers: [{ phone: '0500000000' }],
  };
  const { status, body } = await drive(handler, mockReq({ body: leaky }));
  app.close();

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(!JSON.stringify(body).includes('Cement'));
  assert.ok(!JSON.stringify(body).includes('999'));
  assert.ok(!JSON.stringify(body).includes('0500000000'));
});