/**
 * The activate screen must hand the router a DOM element, not a wrapper object,
 * and it must lay the flow out as three ordered steps with a real code input.
 *
 * Two regressions are pinned here:
 *
 *  1. The router's line immediately after `screen.render(...)` is
 *     `next.classList.add('screen')`. This screen once returned `{ screen: root }`,
 *     so `next.classList` was undefined and boot died with
 *     "Cannot read properties of undefined (reading 'add')".
 *
 *  2. The screen once drew three unstyled buttons in one row (a container class
 *     `.actions` that no stylesheet defines, and buttons labelled `primary`
 *     instead of `btn btn--primary`) and took the code through `prompt()`, so no
 *     input field existed. The structure is asserted here so that cannot recur.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeIndexedDB } from './fake-indexeddb.mjs';
import { installDom, collectIds } from './dom-stub.mjs';
import { resetIdentityConnection } from '../../js/identity-store.js';

/** Depth-first search for the element carrying `id`. */
function findById(node, id) {
  if (!node || typeof node !== 'object') return null;
  if (node.attributes && node.attributes.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

/** Every string of text in the tree, so a hint can be asserted on. */
function collectText(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  const text = typeof node.textContent === 'string' ? node.textContent : '';
  if (text) out.push(text);
  for (const child of node.children ?? []) collectText(child, out);
  return out;
}

test('SCREEN: activate.js render() returns the .screen element the router mounts', async () => {
  installDom({ hash: '#/activate' });
  globalThis.indexedDB = createFakeIndexedDB();

  try {
    // The router is imported first because it is the real entry order (main.js
    // imports it before any screen). Importing a screen first would hit the
    // router's `ROUTES` table while the screen's binding is still in its TDZ.
    await import('../../js/router.js');
    const { default: activateScreen } = await import('../../js/screens/activate.js');

    assert.equal(typeof activateScreen.render, 'function', 'activate.js must export a render function');

    const node = activateScreen.render([]);

    // What router.js does one line after calling render(). With the old
    // `{ screen: root }` return, `node.classList` was undefined and this threw.
    assert.doesNotThrow(
      () => node.classList.add('screen'),
      'render() must return an element with a classList, not a wrapper object',
    );

    assert.equal(node.nodeType, 1, 'render() must return an element node');
    assert.equal(node.classList.contains('screen'), true, 'the root must carry the .screen class');

    // The ids the screen reads back later with getElementById must exist in the
    // tree it renders, or the status update would silently target nothing.
    const ids = collectIds(node);
    assert.ok(ids.includes('activate-screen'), `missing root id; got ${ids.join(', ')}`);
    assert.ok(ids.includes('act-status'), `missing #act-status; got ${ids.join(', ')}`);
    assert.ok(ids.includes('act-sell'), `missing #act-sell; got ${ids.join(', ')}`);

    // Let the fire-and-forget entitlement refresh settle before teardown.
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    resetIdentityConnection();
  }
});

test('SCREEN: activate.js lays out steps 1→2→3 with a real code input', async () => {
  installDom({ hash: '#/activate' });
  globalThis.indexedDB = createFakeIndexedDB();

  try {
    await import('../../js/router.js');
    const { default: activateScreen } = await import('../../js/screens/activate.js');
    const node = activateScreen.render([]);

    const ids = collectIds(node);
    for (const id of ['act-signin', 'act-code', 'act-activate', 'act-bind']) {
      assert.ok(ids.includes(id), `missing #${id}; got ${ids.join(', ')}`);
    }

    // Steps are ordered top to bottom: sign-in, then code, then bind.
    const at = (id) => ids.indexOf(id);
    assert.ok(at('act-step-signin') < at('act-step-code'), 'step 1 (sign-in) must precede step 2 (code)');
    assert.ok(at('act-step-code') < at('act-step-bind'), 'step 2 (code) must precede step 3 (bind)');
    // Inside step 2 the input comes before its activate button.
    assert.ok(at('act-code') < at('act-activate'), 'the code input must precede the activate button');

    // It is a real input, styled with the app's own class, with a hint whose
    // shape comes from the server's validator (SH-XXXX-XXXX-XXXX).
    const input = findById(node, 'act-code');
    assert.equal(input.tagName, 'INPUT', 'the code field must be an <input>');
    assert.equal(input.classList.contains('input'), true, 'the input must use the .input class');
    assert.equal(input.attributes.placeholder, 'SH-XXXX-XXXX-XXXX');

    const texts = collectText(node).join('\n');
    assert.ok(texts.includes('SH-XXXX-XXXX-XXXX'), 'a helper line must show the accepted code shape');

    // Step 3 starts hidden and is only revealed after a successful activation.
    const bindStep = findById(node, 'act-step-bind');
    assert.equal(bindStep.hidden, true, 'the bind step must start hidden');
    const signIn = findById(node, 'act-signin');
    assert.equal(signIn.classList.contains('btn'), true, 'buttons must use the .btn class');

    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    resetIdentityConnection();
  }
});

test('MESSAGES: licence errors are shown in Arabic without changing server codes', async () => {
  installDom({ hash: '#/activate' });
  globalThis.indexedDB = createFakeIndexedDB();
  try {
    await import('../../js/router.js');
    const { licenceErrorMessage, EMPTY_CODE_MESSAGE } = await import('../../js/screens/activate.js');

    // The screenshot's English text must never reach the user again.
    const formatted = licenceErrorMessage({ code: 'INVALID_LICENSE', message: 'The licence code is not in the expected format.' });
    assert.match(formatted, /[\u0600-\u06FF]/, 'the message must be Arabic');
    assert.ok(formatted.includes('SH-XXXX-XXXX-XXXX'), 'it must state the accepted shape');
    assert.ok(!formatted.includes('expected format'), 'the raw English text must not be shown');

    assert.match(licenceErrorMessage({ code: 'LICENSE_NOT_FOUND' }), /[\u0600-\u06FF]/);
    // An unknown code still falls back to the server's own message.
    assert.equal(licenceErrorMessage({ code: 'SOMETHING_NEW', message: 'raw' }), 'raw');
    assert.equal(EMPTY_CODE_MESSAGE, 'الرجاء إدخال رمز الترخيص');
  } finally {
    resetIdentityConnection();
  }
});
