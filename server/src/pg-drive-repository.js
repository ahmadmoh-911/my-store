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
 
const { createSupabaseClient } = require('./pg.js');
const { createDriveRepository } = require('./drive-repository.js');

/**
 * Opens a PostgreSQL drive database.
 *
 * @param {string} file - Ignored for PostgreSQL (kept for compatibility)
 * @param {{clock: () => number, pepper: string, config: object}} deps
 * @returns {{db: object, repo: DriveRepository}}
 */
export async function openDriveDatabase(file, deps = {}) {
   const { clock, pepper, config } = deps;
   if (!config) {
      throw new Error('Config is required for PostgreSQL adapter');
   }
   const pgClient = createSupabaseClient(config);

   // Create a db object that mimics the shape expected by createDriveRepository
   const db = {
      prepare(sql) {
         return {
            run(params) {
               pgClient.exec(sql, params);
            },
            get(params) {
               const result = pgClient.query(sql, params);
               return result[0] || null;
            },
            all(params) {
               return pgClient.query(sql, params);
            },
         };
      },
      exec(sql, params) {
         pgClient.exec(sql, params);
      },
      close() {
         pgClient.close();
      },
   };

   const repo = createDriveRepository(db, { clock, pepper });
   return { db, repo };
}