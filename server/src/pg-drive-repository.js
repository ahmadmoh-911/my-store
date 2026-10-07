/**
 * PostgreSQL adapter for the drive repository.
 *
 * This module implements the DriveRepository interface using a PostgreSQL
 * client. It is used when the backend is configured to use PostgreSQL/Supabase.
 *
 * The adapter follows the same interface as the SQLite adapter in ./drive-repository.js.
 *
 * It does not contain any business logic and does not know about licences,
 * auth, or Drive beyond what is required to implement the repository methods.
 */
 
import { createSupabaseClient } from './pg.js';
import { createDriveRepository } from './drive-repository.js';

/**
 * Opens the PostgreSQL drive database.
 *
 * @param {string} file - Ignored for PostgreSQL (kept for compatibility)
 * @param {{clock: () => number, pepper: string, config?: object, pgClient?: object}} deps
 * @returns {{db: object, repo: DriveRepository}}
 */
export async function openDriveDatabase(file, deps = {}) {
   const { clock, pepper, config, pgClient } = deps;
   if (!config) {
      throw new Error('Config is required for PostgreSQL adapter');
   }
   // One shared pool: index.js hands the client in. A standalone caller without
   // one is the only case that creates its own.
   const pgClient_ = pgClient || createSupabaseClient(config);

   // Create a db object that mimics the shape expected by createDriveRepository
   const db = {
      prepare(sql) {
         return {
            run(params) {
               pgClient_.exec(sql, params);
            },
            get(params) {
               const result = pgClient_.query(sql, params);
               return result[0] || null;
            },
            all(params) {
               return pgClient_.query(sql, params);
            },
         };
      },
      exec(sql, params) {
         pgClient_.exec(sql, params);
      },
      close() {
         pgClient_.close();
      },
   };

   const repo = createDriveRepository(db, { clock, pepper });
   return { db, repo };
}