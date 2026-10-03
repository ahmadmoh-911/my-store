/**
 * The HTTP edge: routing, request parsing, and the single response envelope.
 *
 * Deliberately thin. This file converts bytes into a call on the licence service
 * and a result back into bytes. It holds no rules — every decision about what is
 * allowed belongs to ./service.js — because rules that live in the transport
 * layer are the ones that get bypassed the moment another entry point appears
 * (a CLI, a queue consumer, a test).
 *
 * Built on `node:http` with no framework: the whole surface is three POST
 * endpoints, and a framework would be the largest thing in the repository.
 */

import { createServer as createHttpServer } from 'node:http';

import { ERROR_CODES, LicenseError, isLicenseError, errorBody } from './errors.js';
import { pickClientFields, rejectedClientFields, effectiveStatus } from './model.js';

/** Largest request body accepted. A licence request is a few hundred bytes. */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * Routes, and nothing else. Each entry names the method it accepts so the 405
 * can be produced without a routing library.
 */
const ROUTES = Object.freeze({
  '/api/license/activate': 'activate',
  '/api/license/verify': 'verify',
  '/api/license/bind': 'bind',
});

/**
 * A fixed-window counter, in memory, keyed by IP.
 *
 * Honest about its own limits: it resets when the process restarts and it does
 * not coordinate across instances, so behind a load balancer the real limit is
 * `max × instances`. That is the right trade for this stage — the backend runs
 * as one process, and a shared counter is a Phase-6 problem with a real store
 * behind it. What matters now is that a single script cannot spin.
 */
function createRateLimiter({ windowMs, maxActivate, maxVerify }) {
  /** @type {Map<string, {count: number, resetAt: number, kind: string}>} */
  const buckets = new Map();

  return {
    /**
     * @param {string} key client identity
     * @param {'activate'|'verify'} kind
     * @param {number} now
     * @returns {{allowed: boolean, retryAfterSeconds: number}}
     */
    check(key, kind, now) {
      const max = kind === 'activate' ? maxActivate : maxVerify;
      const existing = buckets.get(key);
      if (!existing || existing.kind !== kind || existing.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + windowMs, kind });
        return { allowed: true, retryAfterSeconds: 0 };
      }
      if (existing.count >= max) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
        };
      }
      existing.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    },
    /** @returns {void} drops windows that have closed, so the map cannot grow forever. */
    sweep(now) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
    },
    get size() {
      return buckets.size;
    },
  };
}

/**
 * Reads the whole body, refusing anything oversized.
 *
 * The size check runs while the chunks arrive rather than after, so an oversized
 * request is dropped rather than buffered — otherwise the limit would be a
 * comment instead of a limit.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [maxBytes]
 * @returns {Promise<string>}
 */
function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new LicenseError(ERROR_CODES.INVALID_REQUEST, {
        status: 413,
        detail: `body exceeds ${maxBytes} bytes`,
      }));
      req.resume();
      return;
    }

    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new LicenseError(ERROR_CODES.INVALID_REQUEST, {
          status: 413,
          detail: `body exceeds ${maxBytes} bytes`,
        }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @param {string} text
 * @returns {unknown}
 */
function parseJson(text) {
  if (!text || text.trim() === '') return {};
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('body must be a JSON object');
    }
    return value;
  } catch (err) {
    throw new LicenseError(ERROR_CODES.INVALID_REQUEST, {
      detail: `malformed JSON: ${err.message}`,
    });
  }
}

/**
 * The client's IP, for rate limiting.
 *
 * `x-forwarded-for` is only honoured when the operator says the server is
 * behind a proxy. Otherwise any client could pick its own rate-limit bucket by
 * sending the header — which turns a limit into a suggestion.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} trustProxy
 * @returns {string}
 */
function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Builds the request handler.
 *
 * @param {{
 *   service: ReturnType<typeof import('./service.js').createLicenseService>,
 *   config: ReturnType<typeof import('./config.js').loadConfig>,
 *   log?: (message: string, detail?: unknown) => void,
 * }} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createRequestHandler({ service, config, log = () => {} }) {
  const limiter = createRateLimiter({
    windowMs: config.rateLimit.windowMs,
    maxActivate: config.rateLimit.maxActivate,
    maxVerify: config.rateLimit.maxVerify,
  });
  const trustProxy = config.trustProxy === true;

  /**
   * Writes the one response shape every endpoint uses.
   *
   * `serverTime` is present on failures too, and is always the server's clock.
   * A client that hit an error still learns the time; more importantly, a
   * client that is refused still gets a clock reading it can trust, because
   * nothing in this response came from the request.
   */
  function send(res, status, body, extraHeaders = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
      ...extraHeaders,
    });
    res.end(payload);
  }

  /**
   * CORS, only for origins the operator listed.
   *
   * The Android build runs on its own origin, so this is not optional there.
   * An origin that is not on the list gets no `Access-Control-Allow-Origin`,
   * which is what makes the browser refuse the response — rather than a
   * wildcard, which would let any site on the internet query a customer's
   * licence status.
   */
  function corsHeaders(req) {
    const origin = req.headers.origin;
    if (!origin || !config.corsOrigins.includes(origin)) return {};
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
      vary: 'Origin',
    };
  }

  return async function handle(req, res) {
    const cors = corsHeaders(req);
    const path = (req.url || '').split('?')[0];

    if (req.method === 'OPTIONS') {
      // Preflight. Answered from the same allowlist as the real request so the
      // preflight cannot be more permissive than the call.
      res.writeHead(204, { ...cors, 'content-length': 0 });
      res.end();
      return;
    }

    const now = service.serverNow();
    const route = ROUTES[path];

    if (!route) {
      send(
        res,
        404,
        { ...errorBody(ERROR_CODES.INVALID_REQUEST, now), path },
        cors,
      );
      return;
    }

    if (req.method !== 'POST') {
      send(
        res,
        405,
        {
          ...errorBody(ERROR_CODES.INVALID_REQUEST, now),
          allowed: ['POST', 'OPTIONS'],
        },
        { ...cors, allow: 'POST, OPTIONS' },
      );
      return;
    }

    const rate = limiter.check(
      `${clientIp(req, trustProxy)}:${route}`,
      route === 'verify' ? 'verify' : 'activate',
      now,
    );
    if (!rate.allowed) {
      send(
        res,
        429,
        errorBody(ERROR_CODES.INVALID_REQUEST, now, 'Too many requests. Try again later.'),
        { ...cors, 'retry-after': String(rate.retryAfterSeconds) },
      );
      return;
    }

    try {
      const body = parseJson(await readBody(req));

      // The client is told what it sent that we discarded. Naming the dropped
      // keys is how a future client bug becomes visible instead of silent.
      const discarded = rejectedClientFields(body);
      if (discarded.length > 0) {
        log(`discarded unexpected fields on ${path}`, discarded);
      }

      const result = service[route](body);
      const reported = pickClientFields(body);

      send(
        res,
        200,
        {
          ok: true,
          license: result.license,
          serverTime: result.serverTime,
          appVersion: reported.appVersion ?? null,
          platform: reported.platform ?? null,
          // Echoed so a client that ignored the server's copy can see the
          // mismatch and fix its own state.
          status: effectiveStatus(result.license, now),
          ...(route === 'activate'
            ? {
              sessionToken: result.sessionToken,
              linkedAccountId: result.linkedAccountId ?? null,
            }
            : {}),
          ...(route === 'bind' ? { linkedAccountId: result.linkedAccountId ?? null } : {}),
        },
        cors,
      );
    } catch (err) {
      if (isLicenseError(err)) {
        // Client mistakes are logged without detail and answered without it too.
        if (err.status >= 500) log(`license error ${err.code}`, err.detail);
        send(res, err.status, errorBody(err.code, now), cors);
        return;
      }
      // Anything unexpected: the caller gets a generic code, the operator gets
      // the stack. A raw error message can leak a schema or a file path.
      log(`unhandled error on ${path}`, err);
      send(res, 500, errorBody(ERROR_CODES.INTERNAL_ERROR, now), cors);
    }
  };
}

/**
 * Starts the HTTP server.
 *
 * @param {{service: object, config: object, log?: Function}} deps
 * @returns {{server: import('node:http').Server, listen: (port?: number, host?: string) => Promise<{port: number, host: string}>}}
 */
export function createLicenseServer({ service, config, log = () => {} }) {
  const handle = createRequestHandler({ service, config, log });
  const server = createHttpServer((req, res) => {
    // A handler that throws asynchronously would otherwise take the process
    // down; handle() already converts errors to responses.
    handle(req, res).catch((err) => {
      log('handler escaped', err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  return {
    server,
    /**
     * @param {number} [port]
     * @param {string} [host]
     * @returns {Promise<{port: number, host: string}>}
     */
    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          const address = server.address();
          resolve({ port: address.port, host: address.address });
        });
      });
    },
  };
}