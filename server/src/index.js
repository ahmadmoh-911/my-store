/**
 * `node server/src/index.js` — runs the licence + auth backend.
 *
 * Wiring only: read config, open the database, build the services, listen. No
 * logic belongs here; anything that does is logic that the tests cannot reach
 * without starting a socket.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { loadConfig } from './config.js';
import { openLicenseDatabase } from './sqlite.js';
import { openAuthDatabase } from './auth-repository.js';
import { createLicenseService } from './service.js';
import { createAuthService } from './auth-service.js';
import { createLicenseServer } from './http.js';

/**
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {{config: object, licenseService: object, authService: object, log: Function, close: () => void}}
 */
export function buildApplication(options = {}) {
  const config = loadConfig(options.env ?? process.env);

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

  const licenseRepository = openLicenseDatabase(config.databaseFile, {
    clock: () => Date.now(),
  });
  const licenseService = createLicenseService({ repository: licenseRepository.repo, config, clock: () => Date.now(), log });

  const authRepo = openAuthDatabase(config.databaseFile, {
    clock: () => Date.now(),
    pepper: config.pepper,
  });
  const authService = createAuthService({ authRepository: authRepo.repo, config, clock: () => Date.now(), log });

  return { config, licenseService, authService, log, close: () => { licenseRepository.repo.close(); authRepo.repo.close(); } };
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
  const { licenseService, authService, config, log, close } = buildApplication();

  const { listen } = createLicenseServer({ licenseService, authService, config, log });
  const address = await listen();

  log(`storehub licence backend listening on http://${address.host}:${address.port}`);
  log(`database ${config.databaseFile}`);

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