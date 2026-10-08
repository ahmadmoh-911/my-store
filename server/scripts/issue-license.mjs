/**
 * Issues one licence code and prints it.
 *
 * `node server/scripts/issue-license.mjs [--days 365] [--note "customer: x"]`
 *
 * This is a local operator tool, not an API. It exists because a licence code
 * has to come from somewhere, and the server deliberately exposes no HTTP route
 * that mints one — a route for that would be an open licence-issuing endpoint for
 * anyone who found the URL.
 *
 * The code is printed once and is not recoverable afterwards: only its hash is
 * stored.
 */

import { loadConfig } from '../src/config.js';
import { openLicenseDatabase } from '../test/support/sqlite-license.js';
import { createLicenseService } from '../src/service.js';

/**
 * @param {string[]} argv
 * @returns {{days: number|null, note: string|null}}
 */
function parseArgs(argv) {
  const out = { days: null, note: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--days') out.days = Number(argv[++i]);
    else if (arg === '--note') out.note = argv[++i];
    else if (arg === '--forever') out.days = null;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const config = loadConfig(process.env);
const repository = openLicenseDatabase(config.databaseFile, { clock: () => Date.now() });
const service = createLicenseService({
  repository,
  config,
  clock: () => Date.now(),
  log: () => {},
});

const { license, code } = service.createLicense({
  expiresInDays: args.days,
  note: args.note,
});

process.stdout.write(`\n  licence id : ${license.id}\n`);
process.stdout.write(`  code       : ${code}\n`);
process.stdout.write(
  `  expires at : ${license.expiresAt ? new Date(license.expiresAt).toISOString() : 'never'}\n`,
);
if (args.note) process.stdout.write(`  note       : ${args.note}\n`);
process.stdout.write('\n  Store this code now. It is not recoverable from the database.\n\n');

repository.close();