/**
 * Static file serving / PWA integrity — precache manifest correctness.
 *
 * Two failure modes are covered here, both of which surface only offline:
 *
 *   1. an entry in sw.js PRECACHE that names a file which does not exist;
 *   2. a module statically imported from the app entry point that is not in
 *      PRECACHE, so an offline launch throws on the missing import.
 *
 * The second check walks only *static* imports — the ones a browser resolves
 * before the app can run. Dynamic `import()` is deliberately not followed: it
 * is allowed to be optional, and the app guards it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(SERVER_ROOT, '..');

function read(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Extracts the quoted entries of the PRECACHE array in sw.js. */
function precacheEntries() {
  const source = read('sw.js');
  const block = source.match(/const PRECACHE = \[([\s\S]*?)\];/);
  assert.ok(block, 'sw.js must declare a PRECACHE array');
  // Only single-quoted `./` entries. Comments inside the array use double
  // quotes and backticks, and would otherwise be read as bogus entries.
  return [...block[1].matchAll(/'(\.\/[^']*)'/g)].map((m) => m[1]);
}

/** Normalises `./x` and `/x` to the root-relative path used on disk. */
function toRootRelative(entry) {
  return entry.replace(/^\.\//, '').replace(/^\//, '');
}

/** Static import/export-from specifiers in one module's source. */
function staticSpecifiers(source) {
  const specs = new Set();
  let m;
  const re = /\bfrom\s*['"]([^'"]+)['"]/g;
  while ((m = re.exec(source)) !== null) specs.add(m[1]);
  const sideEffect = /\bimport\s*['"]([^'"]+)['"]/g;
  while ((m = sideEffect.exec(source)) !== null) specs.add(m[1]);
  return [...specs];
}

function resolveRelative(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromFile), spec),
  );
  if (!resolved.startsWith('js/') || !resolved.endsWith('.js')) return null;
  return resolved;
}

test('SW: every PRECACHE entry exists on disk', () => {
  const missing = [];
  for (const entry of precacheEntries()) {
    const rel = toRootRelative(entry);
    if (rel === '') continue; // './' is the directory itself
    if (!existsSync(path.join(ROOT, rel))) missing.push(entry);
  }
  assert.deepEqual(missing, [], `missing files: ${missing.join(', ')}`);
});

test('SW: every statically imported js module is in PRECACHE', () => {
  const listed = new Set(precacheEntries().map(toRootRelative));
  const queue = ['js/main.js'];
  const seen = new Set();
  const missing = [];

  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);

    if (!listed.has(file)) {
      missing.push(file);
      continue;
    }

    let source;
    try {
      source = read(file);
    } catch {
      continue;
    }
    for (const spec of staticSpecifiers(source)) {
      const resolved = resolveRelative(file, spec);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }

  assert.deepEqual(missing, [], `statically imported but not precached: ${missing.join(', ')}`);
});
