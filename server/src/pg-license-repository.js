/**
 * PostgreSQL adapter for the licence repository.
 *
 * This module implements the LicenseRepository interface using a PostgreSQL
 * client. It is used when the backend is configured to use PostgreSQL/Supabase.
 *
 * The adapter follows the same interface as the SQLite adapter in ./sqlite.js
 * and the repository interface in ./repository.js.
 *
 * It does not contain any business logic and does not know about licences,
 * auth, or Drive beyond what is required to implement the repository methods.
 */
 
import { createSupabaseClient, createPgDatabaseAdapter } from './pg.js';
import { randomUUID } from 'node:crypto';
import { createLicenseRepository } from './repository.js';

/**
 * Opens the PostgreSQL licence repository.
 *
 * @param {string} file - Ignored for PostgreSQL (kept for compatibility)
 * @param {{clock: () => number, config?: object, pgClient?: object}} deps
 * @returns {import('./repository.js').LicenseRepository}
 */
export function openLicenseDatabase(file, deps = {}) {
   const { clock, config, pgClient } = deps;
   if (!config) {
      throw new Error('Config is required for PostgreSQL adapter');
   }
   // One shared pool: index.js hands the client in. A standalone caller without
   // one is the only case that creates its own.
   const pgClient_ = pgClient || createSupabaseClient(config);

   // A db object matching the shape createLicenseRepository expects. The adapter
   // performs the SQLite→PostgreSQL translation (named parameters, `BEGIN
   // IMMEDIATE` → real single-connection transaction) transparently.
   const db = createPgDatabaseAdapter(pgClient_);

   return createLicenseRepository(db, { clock });
}