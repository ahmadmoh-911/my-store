/**
 * PostgreSQL worker for the synchronous Supabase client.
 *
 * node-postgres is fully asynchronous, and no event-loop pumping (e.g.
 * deasync) can drive its connection handshake or a TLS session from inside a
 * blocking call — the connection never settles and the caller would hang
 * forever. So the pool lives in a worker thread whose event loop runs freely,
 * and the caller thread blocks on `Atomics.wait` until the worker publishes
 * the result into a shared buffer. The caller therefore gets exactly the
 * synchronous `query` / `exec` / `close` interface it already expects, with
 * fast bounded failures.
 *
 * Requests are strictly serialized (one in flight at a time), which matches
 * the synchronous callers that use this client.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';

// `pg` is a CommonJS package; require it explicitly so the worker never depends
// on Node's named-export detection for the ESM wrapper.
const require = createRequire(import.meta.url);
const { Pool } = require('pg');

const {
  connectionString,
  ssl,
  connectionTimeoutMillis,
  idleTimeoutMillis,
  statementTimeout,
  max,
} = workerData;

const pool = new Pool({
  connectionString,
  ssl: ssl === undefined ? { rejectUnauthorized: false } : ssl,
  connectionTimeoutMillis,
  idleTimeoutMillis,
  statement_timeout: statementTimeout,
  max,
});

// Shared result channel: [0..3] flag, [4..7] byte length of the JSON payload,
// [8..] payload bytes.
const flag = new Int32Array(workerData.resultBuffer, 0, 1);
const sized = new Int32Array(workerData.resultBuffer, 4, 1);
const data = new Uint8Array(workerData.resultBuffer, 8);

const encoder = new TextEncoder();

/** Publishes `payload` into the shared buffer and wakes the caller. */
function publish(payload) {
  const bytes = encoder.encode(JSON.stringify(payload));
  if (bytes.length > data.byteLength) {
    const errPayload = {
      id: payload.id,
      ok: false,
      error: {
        name: 'Error',
        message: 'storehub-pg: result exceeded the sync bridge buffer size',
        code: 'STOREHUB_PG_TOO_LARGE',
      },
    };
    const errBytes = encoder.encode(JSON.stringify(errPayload));
    data.set(errBytes);
    sized[0] = errBytes.length;
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0, 1);
    return;
  }
  data.set(bytes);
  sized[0] = bytes.length;
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0, 1);
}

function serializeError(err) {
  return {
    name: (err && err.name) || 'Error',
    message: (err && err.message) || String(err),
    code: (err && err.code) || undefined,
  };
}

parentPort.on('message', async (msg) => {
  const { id, op, text, params, tx } = msg;
  try {
    if (op === 'query' || op === 'exec') {
      const res = await pool.query(text, params || []);
      publish({ id, ok: true, rows: res.rows });
    } else if (op === 'tx') {
      // Run a sequence of statements on one connection (real transaction).
      const client = await pool.connect();
      const results = [];
      try {
        await client.query('BEGIN');
        for (const statement of tx) {
          const res = await client.query(statement.text, statement.params || []);
          results.push({ rows: res.rows });
        }
        await client.query('COMMIT');
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* already aborted */ }
        throw err;
      } finally {
        client.release();
      }
      publish({ id, ok: true, results });
    } else if (op === 'close') {
      try { await pool.end(); } catch { /* draining */ }
      publish({ id, ok: true });
      setTimeout(() => process.exit(0), 0);
    } else {
      publish({ id, ok: false, error: { name: 'Error', message: `unknown op ${op}` } });
    }
  } catch (err) {
    publish({ id, ok: false, error: serializeError(err) });
  }
});