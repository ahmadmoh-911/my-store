/**
 * Static import/dependency checks for the browser modules.
 *
 * The bug this pins down: completing a sale in the browser failed with
 * "promptDialog is not defined", because `js/checkout.js` calls `promptDialog`
 * (the price-increase dialog) without importing it from `./components.js`. The
 * minimal fix is one imported name; the regression test below makes it
 * impossible to remove again.
 *
 * A second, general check walks every module under `js/` and looks for the same
 * class of mistake: any name that `components.js` exports (toast, dialog,
 * modal, sheet, …) called as a bare function in a module that neither imports
 * it nor declares it locally. Only the exported helper names are tested, so
 * strings that merely *look* like calls (`translateY(...)`, `scale(...)`) are
 * not flagged.
 *
 * There is no parser dependency here — the files are read as plain text — so
 * the check runs where the rest of the suite runs and needs no new package.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const JS_DIR = path.join(REPO_ROOT, 'js');

/** @param {string} dir @returns {string[]} every `.js` file under `dir`. */
function listJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listJsFiles(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

/** @param {string} body of one `{…}` import block */
function importNames(body) {
  const names = new Set();
  for (const part of body.split(',')) {
    const piece = part.trim();
    if (!piece) continue;
    const alias = piece.match(/^[\w$]+\s+as\s+([A-Za-z_$][\w$]*)/);
    names.add(alias ? alias[1] : piece);
  }
  return names;
}

/** @param {string} src @returns {Set<string>} locally declared identifiers */
function declaredNames(src) {
  const names = new Set();
  const patterns = [
    /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s*([A-Za-z_$][\w$]*)\s*\(/g,
    /(?:^|\n)\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src)) !== null) names.add(m[1]);
  }
  return names;
}

/** @returns {Set<string>} every helper `components.js` exports. */
function componentsExports() {
  const src = readFileSync(path.join(JS_DIR, 'components.js'), 'utf8');
  const names = new Set();
  const re = /\bexport\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(src)) !== null) names.add(m[1]);
  return names;
}

/**
 * Names exported by `components.js` that `file` calls but neither imports from
 * `components.js` nor declares locally.
 *
 * @param {string} file
 * @param {Set<string>} componentNames
 * @returns {string[]} `file:line — name` reports
 */
function undefinedComponentCalls(file, componentNames) {
  const src = readFileSync(file, 'utf8');
  const defined = declaredNames(src);

  const componentsImport = src.match(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*components\.js['"]/);
  const imported = componentsImport ? importNames(componentsImport[1]) : new Set();

  const lines = src.split('\n');
  const out = [];
  for (const name of componentNames) {
    if (defined.has(name) || imported.has(name)) continue;
    const callRe = new RegExp(`(?<![.\\w$])${name}\\s*\\(`);
    for (let i = 0; i < lines.length; i += 1) {
      callRe.lastIndex = 0;
      if (callRe.test(lines[i])) {
        out.push(`${path.relative(REPO_ROOT, file)}:${i + 1} — ${name}`);
        break;
      }
    }
  }
  return out;
}

test('REGRESSION: checkout.js wires the inline price increase and the lot picker', () => {
  const src = readFileSync(path.join(JS_DIR, 'checkout.js'), 'utf8');

  // The price increase is now an INLINE field on the cart panel (cart-bar.js),
  // not a separate promptDialog: the sale flow must read priceIncrease from
  // cart-store and must NOT open its own prompt for it again.
  assert.doesNotMatch(src, /promptDialog\s*\(/, 'checkout.js must not open a separate promptDialog for the increase');

  const storeImport = src.match(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/cart-store\.js['"]/s);
  assert.ok(storeImport, 'checkout.js must import from ./cart-store.js');
  assert.ok(importNames(storeImport[1]).has('priceIncrease'), 'checkout.js must read priceIncrease from cart-store.js');

  // A cart line can name its batch; the picker helpers must be imported or the
  // browser throws "needsLotPicker is not defined" mid-sale.
  assert.match(src, /needsLotPicker\s*\(/, 'checkout.js must call needsLotPicker');
  assert.match(src, /openLotPicker\s*\(/, 'checkout.js must call openLotPicker');
  const lotImport = src.match(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/lot-picker\.js['"]/);
  assert.ok(lotImport, 'checkout.js must import from ./lot-picker.js');
  const lotNames = importNames(lotImport[1]);
  assert.ok(lotNames.has('needsLotPicker'), 'checkout.js calls needsLotPicker but does not import it');
  assert.ok(lotNames.has('openLotPicker'), 'checkout.js calls openLotPicker but does not import it');
});

test('STATIC: no module calls a components.js helper without importing or declaring it', () => {
  const componentNames = componentsExports();
  assert.ok(componentNames.size > 10, `expected many helpers, found ${componentNames.size}`);

  const missing = [];
  for (const file of listJsFiles(JS_DIR)) {
    missing.push(...undefinedComponentCalls(file, componentNames));
  }

  assert.deepEqual(
    missing,
    [],
    `modules call components.js helpers that are neither imported nor declared:\n${missing.join('\n')}`,
  );
});