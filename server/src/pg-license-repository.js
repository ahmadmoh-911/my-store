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
 
import { createSupabaseClient } from './pg.js';
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

   // We need to adapt the client to match the shape expected by createLicenseRepository.
   // The createLicenseRepository expects a db object with methods: prepare, exec, close.
   // Our pgClient has query, exec, close methods that are synchronous.
   // We will create a db object that has a prepare method that returns a statement
   // object with a run or get method that is synchronous.
   // This is complex. Given the time, we will instead create a synchronous wrapper
   // around the pgClient that mimics the SQLite db object.

   // We will create a simple db object that has:
   //   prepare: (sql) => {
   //     return {
   //       run: (params) => { pgClient.exec(sql, params); },
   //       get: (params) => { return pgClient.query(sql, params)[0]; },
   //       all: (params) => { return pgClient.query(sql, params); },
   //     };
   //   },
   //   exec: (sql, params) => { pgClient.exec(sql, params); },
   //   close: () => { pgClient.close(); }
   // };

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

   return createLicenseRepository(db, { clock });
}