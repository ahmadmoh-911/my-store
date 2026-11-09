/**
 * A `localStorage` double faithful enough for the backup layer.
 *
 * The one property that matters — and the one a naive `{ getItem, setItem }`
 * object gets wrong — is that a real `Storage` exposes its KEYS AS OWN
 * ENUMERABLE PROPERTIES. `js/data-transfer.js` enumerates shop data with
 *
 *     Object.keys(localStorage)
 *
 * because that is how a real browser lets you find out what is in there. An
 * object whose methods are own properties would answer `Object.keys` with
 * `['getItem', 'setItem', …]` and the enumerator would then try to back up
 * functions, so the double has to keep the API non-enumerable and the data
 * enumerable, exactly as the real thing does.
 */

export function createFakeLocalStorage() {
  const data = new Map();

  const api = {};
  // Non-enumerable (the `defineProperties` default), so `Object.keys()` — and
  // `for…in` — never see the API, only the data.
  Object.defineProperties(api, {
    getItem: { value: (k) => (data.has(String(k)) ? data.get(String(k)) : null) },
    setItem: { value: (k, v) => { data.set(String(k), String(v)); } },
    removeItem: { value: (k) => { data.delete(String(k)); } },
    clear: { value: () => { data.clear(); } },
    key: { value: (i) => [...data.keys()][i] ?? null },
    length: { get: () => data.size },
  });

  return new Proxy(api, {
    // The target's own keys must stay in the list (the proxy invariant refuses
    // to hide a non-configurable property), but they are non-enumerable so
    // `Object.keys` filters them out and only data keys survive.
    ownKeys: (t) => [...Reflect.ownKeys(t), ...data.keys()],
    getOwnPropertyDescriptor: (t, p) =>
      typeof p === 'string' && data.has(p)
        ? { value: data.get(p), enumerable: true, configurable: true, writable: true }
        : Reflect.getOwnPropertyDescriptor(t, p),
    get: (t, p, r) => {
      if (p in t) return Reflect.get(t, p, r);
      if (typeof p === 'string' && data.has(p)) return data.get(p);
      return undefined;
    },
    set: (t, p, v) => {
      if (p in t) return Reflect.set(t, p, v);
      data.set(String(p), String(v));
      return true;
    },
    has: (t, p) => p in t || (typeof p === 'string' && data.has(p)),
    deleteProperty: (t, p) => {
      if (p in t) return Reflect.deleteProperty(t, p);
      data.delete(String(p));
      return true;
    },
  });
}
