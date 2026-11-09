/**
 * A minimal DOM for importing the app's screen modules under `node --test`.
 *
 * This is not a browser. It implements exactly what `js/utils.js`'s `el()` and
 * the screen modules touch, so a test can call a screen's `render()` and inspect
 * the element it returns. `el()` uses `document.createElement`, the class list,
 * a few property setters (`textContent`, `innerHTML`, `style`, `dataset`),
 * `setAttribute`, and `appendChild` — nothing more is required.
 */

/** @returns {object} a DOM-element stand-in. */
export function makeElement(tag = 'div') {
  const classes = new Set();
  const node = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [],
    style: {},
    dataset: {},
    attributes: {},
    _text: '',
    _html: '',
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text; },
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k]; },
    hasAttribute(k) { return k in this.attributes; },
    removeAttribute(k) { delete this.attributes[k]; },
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { cs.forEach((c) => this.children.push(c)); },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      return c;
    },
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    replaceChildren() { this.children = []; },
    focus() {},
    closest() { return null; },
    matches() { return false; },
    get firstChild() { return this.children[0] || null; },
    get parentNode() { return null; },
    get isConnected() { return true; },
    classList: {
      add(...c) { c.forEach((x) => classes.add(x)); },
      remove(...c) { c.forEach((x) => classes.delete(x)); },
      toggle(x, force) {
        const on = force === undefined ? !classes.has(x) : Boolean(force);
        if (on) classes.add(x); else classes.delete(x);
        return on;
      },
      contains(x) { return classes.has(x); },
    },
  };
  Object.defineProperty(node, 'className', {
    get() { return [...classes].join(' '); },
    set(v) {
      classes.clear();
      String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
    },
  });
  return node;
}

/**
 * Installs the minimal browser globals the screen modules read. Call this
 * *before* dynamically importing any screen (static imports are hoisted and
 * would run first).
 *
 * @param {{hash?: string}} [options]
 */
export function installDom({ hash = '#/' } = {}) {
  globalThis.document = {
    createElement: (t) => makeElement(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    createDocumentFragment: () => makeElement('#fragment'),
    getElementById: () => makeElement(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    body: makeElement('body'),
    documentElement: makeElement('html'),
    head: makeElement('head'),
    visibilityState: 'visible',
    title: '',
  };
  globalThis.window = globalThis;
  globalThis.location = { hash, href: `http://localhost:8787/${hash}`, origin: 'http://localhost:8787' };
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: true, userAgent: 'node' },
    configurable: true,
  });
  const storage = { getItem() { return null; }, setItem() {}, removeItem() {}, clear() {} };
  globalThis.localStorage = storage;
  globalThis.sessionStorage = storage;
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}

/** Collects every `id` attribute in an element tree, in document order. */
export function collectIds(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.attributes && node.attributes.id) out.push(node.attributes.id);
  for (const child of node.children ?? []) collectIds(child, out);
  return out;
}
