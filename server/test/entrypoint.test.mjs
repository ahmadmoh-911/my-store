/**
 * The entry point must actually start when run as `node src/index.js` on
 * Linux. It used to compare import.meta.url with 'file:///' + argv[1], which is
 * 'file:////app/src/index.js' on POSIX — so in Docker it exited 0 without ever
 * listening, and Render reported the deploy as failed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

test('ENTRYPOINT: running src/index.js directly reaches main() (fails loudly, not silently)', () => {
  // No database configured: main() must run and refuse to start with exit 1.
  // The old bug skipped main() entirely and exited 0 with no output.
  const res = spawnSync(process.execPath, [ENTRY], {
    encoding: 'utf8',
    timeout: 15000,
    env: { PATH: process.env.PATH, NODE_ENV: 'test', SUPABASE_DB_URL: '', STOREHUB_WEB_ROOT: path.dirname(ENTRY) },
    cwd: path.dirname(ENTRY),
  });
  assert.equal(res.status, 1, `expected exit 1, got ${res.status}; stderr: ${res.stderr}`);
  assert.match(res.stderr, /failed to start/);
});
