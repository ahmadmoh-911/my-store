import { Pool } from 'pg';
import * as deasync from 'deasync';
function createPostgresClient(config) {
  const pool = new Pool({
    connectionString: config.connectionString,
  });

  /**
   * Executes a SQL query and returns the result rows.
   * This method is synchronous.
   *
   * @param {string} text - The SQL query string
   * @param {Array} [params] - Query parameters
   * @returns {Array} An array of row objects (empty array if no rows)
   * @throws {Error} If the query fails
   */
  function query(text, params) {
    let result = null;
    let error = null;
    const promise = pool.query(text, params)
      .then(res => {
        result = res.rows;
      })
      .catch(err => {
        error = err;
      });
    deasync.loopWhile(() => result === null && error === null);
    if (error) {
      throw error;
    }
    return result;
  }

  /**
   * Executes a SQL statement (e.g., INSERT, UPDATE, DELETE, DDL).
   * This method is synchronous and does not return rows.
   *
   * @param {string} text - The SQL statement string
   * @param {Array} [params] - Query parameters
   * @returns {void}
   * @throws {Error} If the statement fails
   */
  function exec(text, params) {
    let error = null;
    const promise = pool.query(text, params)
      .then(() => {
        // Success, no result to return
      })
      .catch(err => {
        error = err;
      });
    deasync.loopWhile(() => error === null);
    if (error) {
      throw error;
    }
  }

  /**
   * Closes the connection pool.
   * This method is synchronous.
   *
   * @returns {void}
   */
  function close() {
    let closed = false;
    let error = null;
    const promise = pool.end()
      .then(() => {
        closed = true;
      })
      .catch(err => {
        error = err;
      });
    deasync.loopWhile(() => !closed && error === null);
    if (error) {
      throw error;
    }
  }

  return {
    query,
    exec,
    close,
  };
}

/**
 * Creates a synchronous PostgreSQL client wrapper for Supabase.
 * Uses SUPABASE_DB_URL if available, otherwise falls back to using
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to construct the connection string.
 *
 * @param {Object} config - Configuration object with `supabaseUrl`, `supabaseServiceRoleKey`, and `supabaseDbUrl`
 * @returns {Object} An object with `query`, `exec`, and `close` methods that are synchronous.
 */
function createSupabaseClient(config) {
  // If we have a direct database URL, use it.
  if (config.supabaseDbUrl) {
    return createPostgresClient({ connectionString: config.supabaseDbUrl });
  }

  // Otherwise, use the Supabase URL and service role key to construct the connection string.
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for Supabase client');
  }
  try {
    const url = new URL(config.supabaseUrl);
    const hostname = url.hostname; // e.g., xyz.supabase.co
    const parts = hostname.split('.');
    if (parts.length < 3 || parts[parts.length - 2] !== 'supabase' || parts[parts.length - 1] !== 'co') {
      throw new Error('Invalid SUPABASE_URL format. Expected https://[projectId].supabase.co');
    }
    const projectId = parts[0];
    const connectionString = `postgresql://postgres:${config.supabaseServiceRoleKey}@db.${projectId}.supabase.co:5432/postgres?sslmode=require`;
    return createPostgresClient({ connectionString });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Invalid SUPABASE_URL')) {
      throw err;
    }
    throw new Error(`Failed to create Supabase client: ${err.message}`);
  }
}

export { createPostgresClient, createSupabaseClient };
