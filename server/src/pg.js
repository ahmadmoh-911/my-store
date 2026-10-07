/**
 * PostgreSQL connection layer for Supabase.
 *
 * The only source of the connection is `SUPABASE_DB_URL` (a Supabase pooler
 * URI). There is deliberately no fallback that builds a connection string out
 * of `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`: the service role key is an
 * API credential, not the database password, and a silently-wrong fallback is
 * how a backend ends up authenticating with a garbage password while
 * «usePostgres» is on.
 *
 * The client exposes synchronous `query` / `exec` / `close` so the repository
 * adapters keep their existing synchronous repository interface. The actual
 * `pg` pool runs inside a worker thread (see pg-worker.js): node-postgres is
 * fully asynchronous, and no event-loop pumping — including deasync — can
 * drive its handshake or a TLS session from inside a blocking call, so a
 * synchronous wrapper over pg is only possible by letting the pool run on a
 * thread whose event loop is free while the caller waits on Atomics.wait.
 *
 * Connection safety:
 *  - SSL is negotiated for every connection (the Supabase pooler requires TLS;
 *    its certificate chain is not verifiable through the system store, so cert
 *    validation is turned off — the standard pg-driver setting for Supabase).
 *  - `connectionTimeoutMillis` bounds the connect, `statement_timeout` bounds
 *    every statement, and the caller-side wait is bounded by a deadline, so a
 *    stalled connection becomes a fast, explicit error instead of a hang.
 */

import { Worker } from 'node:worker_threads';

/** Default deadline for the synchronous wait in milliseconds. */
const DEFAULT_WAIT_MS = 10_000;
/** Default shared result buffer size in bytes. */
const DEFAULT_RESULT_BYTES = 8 * 1024 * 1024;

/**
 * Parses a PostgreSQL connection URI into its components for validation and
 * diagnostics. `new URL` handles reserved characters in the URI; components are
 * percent-decoded so callers get clean values.
 *
 * The password is deliberately never returned here: it stays inside the raw
 * connection string that is handed to `pg`, so there is no decoded copy, no
 * re-encoding to get wrong, and no code path that can print it.
 *
 * @param {string} connectionString
 * @returns {{host: string, port: number, user?: string, database?: string}}
 */
export function parseConnectionUri(connectionString) {
  const parts = new URL(connectionString);
  return {
    host: parts.hostname,
    port: parts.port ? Number(parts.port) : 5432,
    user: parts.username ? decodeURIComponent(parts.username) : undefined,
    database: parts.pathname && parts.pathname.length > 1
      ? decodeURIComponent(parts.pathname.slice(1))
      : undefined,
  };
}

/**
 * Creates a synchronous PostgreSQL client backed by a `pg` pool in a worker
 * thread.
 *
 * @param {{
 *   connectionString: string,
 *   connectionTimeoutMillis?: number,
 *   idleTimeoutMillis?: number,
 *   statementTimeout?: number,
 *   max?: number,
 *   ssl?: object|false,
 *   timeoutMs?: number,
 *   resultBufferBytes?: number,
 * }} config
 * @returns {{
 *   query: (text: string, params?: Array) => Array,
 *   exec: (text: string, params?: Array) => void,
 *   transaction: (statements: Array<{text: string, params?: Array}>) => Array,
 *   close: () => void,
 * }}
 */
function createPostgresClient(config = {}) {
  if (!config.connectionString || typeof config.connectionString !== 'string') {
    throw new Error('connectionString is required to create a PostgreSQL client');
  }

  const resultBuffer = new SharedArrayBuffer(
    8 + (config.resultBufferBytes || DEFAULT_RESULT_BYTES),
  );
  const flag = new Int32Array(resultBuffer, 0, 1);
  const sized = new Int32Array(resultBuffer, 4, 1);
  const data = new Uint8Array(resultBuffer, 8);
  const decoder = new TextDecoder();

  const worker = new Worker(new URL('./pg-worker.js', import.meta.url), {
    workerData: {
      connectionString: config.connectionString,
      ssl: config.ssl === undefined ? { rejectUnauthorized: false } : config.ssl,
      connectionTimeoutMillis: config.connectionTimeoutMillis ?? 10_000,
      idleTimeoutMillis: config.idleTimeoutMillis ?? 30_000,
      statementTimeout: config.statementTimeout ?? 15_000,
      max: config.max ?? 10,
      resultBuffer,
    },
  });

  // Surface a worker boot failure as the real error instead of a bare timeout.
  let workerError = null;
  worker.on('error', (err) => { workerError = err; });
  worker.on('exit', (code) => {
    if (code !== 0 && !closed) workerError = workerError || new Error(`storehub-pg worker exited with code ${code}`);
  });

  const waitMs = config.timeoutMs ?? DEFAULT_WAIT_MS;
  let nextId = 1;
  let closed = false;

  /**
   * Sends one request to the worker and blocks until its reply is published.
   * Bounded: a silent worker becomes an explicit timeout error.
   *
   * @param {string} op
   * @param {object} body
   * @param {string} what
   * @returns {object} the published payload ({ ok: true, ... } or { ok: false, error })
   */
  function call(op, body, what) {
    if (closed) {
      const err = new Error('storehub-pg: client is closed');
      err.code = 'STOREHUB_PG_CLOSED';
      throw err;
    }
    const id = nextId++;
    sized[0] = 0;
    Atomics.store(flag, 0, 0);
    worker.postMessage({ id, op, ...body });
    Atomics.wait(flag, 0, 0, Math.max(waitMs, 1));
    if (Atomics.load(flag, 0) !== 1) {
      if (workerError) throw workerError;
      const err = new Error(`storehub-pg: ${what} exceeded the ${waitMs}ms deadline (connection unreachable or stalled)`);
      err.code = 'STOREHUB_PG_TIMEOUT';
      throw err;
    }
    const payload = JSON.parse(decoder.decode(data.subarray(0, sized[0])));
    if (!payload.ok) {
      const err = new Error(payload.error.message || 'storehub-pg: unknown database error');
      if (payload.error.name) err.name = payload.error.name;
      if (payload.error.code) err.code = payload.error.code;
      throw err;
    }
    return payload;
  }

  return {
    /** @param {string} text @param {Array} [params] @returns {Array} rows */
    query(text, params) {
      const payload = call('query', { text, params: params || [] }, 'query');
      return payload.rows;
    },

    /** @param {string} text @param {Array} [params] @returns {void} */
    exec(text, params) {
      call('exec', { text, params: params || [] }, 'exec');
    },

    /**
     * Runs `statements` inside a real transaction on one connection.
     * @param {Array<{text: string, params?: Array}>} statements
     * @returns {Array<{rows: Array}>} one result per statement
     */
    transaction(statements) {
      const payload = call('tx', { tx: statements }, 'transaction');
      return payload.results;
    },

    /** Ends the pool and the worker. Idempotent. */
    close() {
      if (closed) return;
      closed = true;
      try { call('close', {}, 'close'); } catch { /* best effort */ }
      try { worker.terminate(); } catch { /* best effort */ }
    },
  };
}

/**
 * Creates the Supabase client used by every repository adapter.
 *
 * This is the only place the connection string is minted, and it is summoned
 * exactly once per application build so all repositories share one pool.
 *
 * @param {{supabaseDbUrl?: string|null}} config
 * @returns {ReturnType<typeof createPostgresClient>}
 */
function createSupabaseClient(config) {
  if (!config || !config.supabaseDbUrl) {
    throw new Error(
      'SUPABASE_DB_URL is required when the backend is in PostgreSQL mode. ' +
        'There is no fallback: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are ' +
        'API credentials, not database credentials.',
    );
  }
  return createPostgresClient({ connectionString: config.supabaseDbUrl });
}

export { createPostgresClient, createSupabaseClient };