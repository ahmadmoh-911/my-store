/** js/legacy-host.js: the old GitHub Pages link forwards to the live server. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(fileURLToPath(new URL('../../js/legacy-host.js', import.meta.url)), 'utf8');

function run(href) {
  const u = new URL(href);
  let to = null;
  vm.runInNewContext(SRC, {
    location: { hostname: u.hostname, pathname: u.pathname, search: u.search, hash: u.hash, replace: (x) => { to = x; } },
  });
  return to;
}

test('LEGACY HOST: github.io forwards to the live server, keeping the screen', () => {
  assert.equal(run('https://ahmadmoh-911.github.io/my-store/#/pos'), 'https://storehub-73p4.onrender.com/#/pos');
  assert.equal(run('https://ahmadmoh-911.github.io/my-store'), 'https://storehub-73p4.onrender.com/');
  assert.equal(
    run('https://ahmadmoh-911.github.io/my-store/index.html?x=1#/reports'),
    'https://storehub-73p4.onrender.com/index.html?x=1#/reports',
  );
});

test('LEGACY HOST: does nothing on the live server, localhost or the Android app', () => {
  assert.equal(run('https://storehub-73p4.onrender.com/#/pos'), null);
  assert.equal(run('http://localhost:8787/'), null);
  assert.equal(run('https://localhost/'), null);
});

test('LEGACY HOST: loaded first in index.html and precached for offline boot', () => {
  const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
  const sw = readFileSync(fileURLToPath(new URL('../../sw.js', import.meta.url)), 'utf8');
  const tag = html.indexOf('js/legacy-host.js');
  assert.ok(tag > 0 && tag < html.indexOf('<link rel="stylesheet"'), 'runs before the app loads');
  assert.ok(sw.includes("'./js/legacy-host.js'"), 'in the service worker precache');
});
