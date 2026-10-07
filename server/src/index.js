/**
 * `node server/src/index.js` — runs the licence, auth and admin backend.
 *
 * Wiring only: read config, open the databases, build the services, listen. No
 * logic belongs here; anything that does is logic that the tests cannot reach
 * without starting a socket.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { loadConfig, assertProductionRedirectUris } from './config.js';
import { createLicenseService } from './service.js';
import { createAuthService } from './auth-service.js';
import { createDriveService } from './drive-service.js';
import { createAdminLicenseService } from './admin-service.js';
import { describeAdminConfiguration } from './admin-authorization.js';
import { createLicenseServer } from './http.js';

/**
 * Builds every service the backend exposes.
 *
 * Async only because opening the identity database loads the SQLite driver; the
 * licence adapter opens synchronously.
 *
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<{
 *   config: object,
 *   licenseService: object,
 *   authService: object,
 *   adminService: object,
 *   log: (message: string, detail?: unknown) => void,
 *   close: () => void,
 * }>}
 */
export async function buildApplication(options = {}) {
   const config = loadConfig(options.env ?? process.env);

   // Before anything is opened or created, so a production start that would put
   // every Google flow back on one shared redirect URI fails here with the list
   // of variables to set, instead of shipping an admin portal and a Drive connect
   // that can never receive Google's redirect.
   assertProductionRedirectUris(config);

   // Conditionally load database adapters
   let openLicenseDatabase;
   let openAuthDatabase;
   let openDriveDatabase;
   let pgClient = null;
   if (config.usePostgres) {
     const pgLicense = await import('./pg-license-repository.js');
     const pgAuth = await import('./pg-auth-repository.js');
     const pgDrive = await import('./pg-drive-repository.js');
     const { createSupabaseClient } = await import('./pg.js');
     // One shared pool for every repository. Creating the client is cheap; the
     // boot check below is what makes a bad connection fail loudly instead of
     // surfacing as a confusing first-request hang.
     pgClient = createSupabaseClient(config);
     openLicenseDatabase = pgLicense.openLicenseDatabase;
     openAuthDatabase = pgAuth.openAuthDatabase;
     openDriveDatabase = pgDrive.openDriveDatabase;
   } else {
     const sqliteLicense = await import('./sqlite.js');
     const sqliteAuth = await import('./auth-repository.js');
     const sqliteDrive = await import('./drive-repository.js');
     openLicenseDatabase = sqliteLicense.openLicenseDatabase;
     openAuthDatabase = sqliteAuth.openAuthDatabase;
     openDriveDatabase = sqliteDrive.openDriveDatabase;
   }

   /** @param {string} message @param {unknown} [detail] */
   const log = (message, detail) => {
     if (detail === undefined) {
       process.stdout.write(`${new Date().toISOString()} ${message}\n`);
     } else {
       process.stdout.write(
         `${new Date().toISOString()} ${message} ${safeJson(detail)}\n`,
       );
     }
   };

   // The database is a plain file, so make sure its directory exists before the
   // first open rather than surfacing ENOENT as a confusing startup error.
   if (!config.useMemoryDb) mkdirSync(dirname(config.databaseFile), { recursive: true });

   const clock = () => Date.now();

   if (pgClient) {
     // PostgreSQL mode: verify the connection synchronously at boot. A missing,
     // invalid, or unreachable SUPABASE_DB_URL therefore stops the server fast
     // with a clear message instead of a silent SQLite fallback or a first-call
     // hang. The error text is classified and never contains the credentials.
     let pgHost = 'unknown';
     try {
       pgHost = config.supabaseDbUrl ? new URL(config.supabaseDbUrl).hostname : 'unknown';
     } catch {}
     try {
       pgClient.query('SELECT 1');
     } catch (err) {
       try { pgClient.close(); } catch {}
       throw new Error(
         `PostgreSQL mode is enabled but the database is unreachable ` +
         `(host=${pgHost}): ${err.message}`,
       );
     }
   }

   // Note the two different shapes, which is easy to get backwards:
   // `openLicenseDatabase` hands back the repository itself, while
   // `openAuthDatabase` hands back `{ db, repo }`. Reading `.repo` off the
   // licence one yields undefined and the first request fails with a confusing
   // "cannot read property of undefined" — so the licence repository is used
   // directly here and a test builds this same graph to keep it honest.
   const licenseRepository = openLicenseDatabase(config.databaseFile, { clock, config, pgClient });
   const licenseService = createLicenseService({ repository: licenseRepository, config, clock, log });

   const authDb = await openAuthDatabase(config.databaseFile, {
     clock,
     pepper: config.pepper,
     config,
     pgClient,
   });

   // The Drive grant gets its own database, always. `drive.db` is a *different
   // file* from `databaseFile`, because it holds a long-lived credential and the
   // licence file holds none — see ./drive-repository.js for why those must not
   // share a file.
   if (!config.useMemoryDb && config.drive.databaseFile !== ':memory:') {
     mkdirSync(dirname(config.drive.databaseFile), { recursive: true });
   }
   const driveDb = await openDriveDatabase(config.drive.databaseFile, {
     clock,
     pepper: config.pepper,
     config,
     pgClient,
   });

   // Drive first: the auth service needs the grant sink in order to record a
   // Drive grant, and the sink is the drive service. Injected as a plain function
   // rather than importing the service into auth-service.js, which keeps the
   // OAuth flow unaware that a Drive store exists and keeps the refresh token on
   // a path from the token exchange straight into encrypted storage.
   const driveService = createDriveService({
     driveRepository: driveDb.repo,
     config,
     clock,
     log,
   });

   const authService = createAuthService({
     authRepository: authDb.repo,
     config,
     clock,
     log,
     driveGrantSink: driveService,
   });

   const adminService = createAdminLicenseService({
     licenseService,
     repository: licenseRepository,
     clock,
     log,
   });

   return {
     config,
     licenseService,
     authService,
     adminService,
     driveService,
     // The repositories are returned alongside the services so a test can mint a
     // real session or read a real grant without this module growing a
     // test-only endpoint. They are wiring, and this function is wiring.
     authRepository: authDb.repo,
     driveRepository: driveDb.repo,
     licenseRepository,
     log,
     close: () => {
       driveDb.repo.close();
       authDb.repo.close();
       licenseRepository.close();
     },
   };
}

/** @param {unknown} value @returns {string} */
function safeJson(value) {
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Starts the server when invoked directly. @returns {Promise<void>} */
async function main() {
   const { licenseService, authService, adminService, driveService, config, log, close } =
     await buildApplication();

   const { listen } = createLicenseServer({ licenseService, authService, adminService, driveService, config, log });
   const address = await listen();

   log(`storehub licence backend listening on http://${address.host}:${address.port}`);
   log(`database ${config.databaseFile}`);
   log(`drive grants ${config.drive.databaseFile} → "${config.drive.folderName}" in the customer's own Drive`);
   log(describeAdminConfiguration(config.admin));

   if (config.env !== 'production') {
     // Named explicitly, because a dev server that looks like production is how
     // a development pepper reaches a real deployment.
     log('DEVELOPMENT MODE — development pepper in use unless STOREHUB_PEPPER is set');
     if (!config.google.clientId) {
       log('Google OAuth not configured — auth endpoints will return configuration errors');
     }
   }

   const shutdown = (signal) => {
     log(`${signal} received, closing`);
     close();
     process.exit(0);
   };
   process.on('SIGINT', () => shutdown('SIGINT'));
   process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// `import.meta.url === pathToFileURL(process.argv[1])` is the check for "run
// directly" that survives symlinks and Windows path quirks.
const invokedDirectly =
   process.argv[1] &&
   import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;

if (invokedDirectly) {
   main().catch((err) => {
     process.stderr.write(`failed to start: ${err.stack || err.message}\n`);
     process.exit(1);
   });
}