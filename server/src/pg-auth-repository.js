/**
 * PostgreSQL adapter for the auth repository.
 *
 * This module implements the AuthRepository interface using a PostgreSQL
 * client. It is used when the backend is configured to use PostgreSQL/Supabase.
 *
 * The adapter follows the same interface as the repository port in
 * ./auth-repository.js (Phase 4: this is the only adapter the runtime loads).
 *
 * It does not contain any business logic and does not know about licences,
 * auth, or Drive beyond what is required to implement the repository methods.
 */
 
import { createSupabaseClient, createPgDatabaseAdapter } from './pg.js';
import { createAuthRepository } from './auth-repository.js';

/**
 * Opens the PostgreSQL auth database.
 *
 * @param {string} file - Ignored for PostgreSQL (kept for compatibility)
 * @param {{clock: () => number, pepper: string, config?: object, pgClient?: object}} deps
 * @returns {{db: object, repo: AuthRepository}}
 */
export async function openAuthDatabase(file, deps = {}) {
   const { clock, pepper, config, pgClient } = deps;
   if (!config) {
      throw new Error('Config is required for PostgreSQL adapter');
   }
   // One shared pool: index.js hands the client in. A standalone caller without
   // one is the only case that creates its own.
   const pgClient_ = pgClient || createSupabaseClient(config);

   // A db object matching the shape createAuthRepository expects. The adapter
   // performs the SQLite→PostgreSQL translation (named parameters, `BEGIN
   // IMMEDIATE` → real single-connection transaction) transparently.
   const db = createPgDatabaseAdapter(pgClient_);

   const repo = createAuthRepository(db, { clock, pepper });
   return { db, repo };
}