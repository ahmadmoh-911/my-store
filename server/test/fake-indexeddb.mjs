/**
 * A minimal IndexedDB test double.
 *
 * The project ships no package.json and no node_modules, and this file must stay
 * that way — so the Foundation tests cannot reach for `fake-indexeddb`. This is
 * the smallest implementation of the surface `js/identity-store.js` actually
 * uses:
 *
 *   open(name, version)  -> onupgradeneeded / onsuccess / onerror / onblocked
 *   db.objectStoreNames.contains(name)
 *   db.createObjectStore(name, { keyPath })
 *   db.transaction(names, mode) -> objectStore().get / put / delete, oncomplete
 *   db.close(), db.onversionchange
 *   deleteDatabase(name)
 *
 * Two things it does on purpose, so the tests cannot pass by accident:
 *   - Values are deep-cloned on write and on read, exactly as a real IndexedDB
 *     does. Without that, a caller mutating a record it had just received would
 *     silently change what is "stored".
 *   - Transactions fire `oncomplete` on a fresh task after the caller has
 *     synchronously issued its requests, which is what real auto-commit does.
 *
 * Backing data is kept per-database in this closure, so it survives a simulated
 * app restart as long as the test holds on to the same factory.
 */
export function createFakeIndexedDB() {
  /** name -> { version, stores: Map<string, Map<string, any>> } */
  const databases = new Map();

  const clone = (v) => (v === undefined ? undefined : structuredClone(v));

  class FakeRequest {
    constructor() {
      this.onsuccess = null;
      this.onerror = null;
      this.onblocked = null;
      this.result = undefined;
      this.error = null;
    }
    succeed(value) {
      this.result = value;
      queueMicrotask(() => this.onsuccess && this.onsuccess({ target: this }));
    }
    fail(err) {
      this.error = err;
      queueMicrotask(() => this.onerror && this.onerror({ target: this }));
    }
    blocked() {
      queueMicrotask(() => this.onblocked && this.onblocked({ target: this }));
    }
  }

  class FakeObjectStore {
    constructor(name, entry) {
      this.name = name;
      this._data = entry.data;
      this._keyPath = entry.keyPath;
    }
    get(key) {
      const req = new FakeRequest();
      req.succeed(clone(this._data.get(String(key))));
      return req;
    }
    put(value) {
      const req = new FakeRequest();
      const key = value[this._keyPath];
      if (key === undefined || key === null) {
        req.fail(new Error(`DataError: a key is required for the '${this._keyPath}' keyPath`));
        return req;
      }
      this._data.set(String(key), clone(value));
      req.succeed(String(key));
      return req;
    }
    delete(key) {
      const req = new FakeRequest();
      this._data.delete(String(key));
      req.succeed(undefined);
      return req;
    }
    clear() {
      const req = new FakeRequest();
      this._data.clear();
      req.succeed(undefined);
      return req;
    }
  }

  class FakeTransaction {
    constructor(db, storeNames, mode) {
      this.db = db;
      this.mode = mode;
      this.oncomplete = null;
      this.onerror = null;
      this.onabort = null;
      this.error = null;
      this._aborted = false;
      this._stores = storeNames.map((n) => {
        const entry = db._record.stores.get(n);
        if (!entry) throw new Error(`NotFoundError: no store named '${n}'`);
        return new FakeObjectStore(n, entry);
      });
      // Auto-commit: real IndexedDB finishes a transaction once its queued
      // requests are done, which for synchronous use is the next task.
      queueMicrotask(() => queueMicrotask(() => {
        if (this._aborted) return;
        this.oncomplete && this.oncomplete({ target: this });
      }));
    }
    objectStore(name) {
      const found = this._stores.find((s) => s.name === name);
      if (!found) throw new Error(`NotFoundError: no store named '${name}'`);
      return found;
    }
    abort() {
      if (this._aborted) return;
      this._aborted = true;
      this.onabort && this.onabort({ target: this });
    }
  }

  const factory = {
    open(name, version = 1) {
      const req = new FakeRequest();
      const existing = databases.get(name);
      const record = existing || { version: 0, stores: new Map() };
      databases.set(name, record);

      const db = {
        name,
        _record: record,
        objectStoreNames: {
          contains: (n) => record.stores.has(n),
        },
        createObjectStore(storeName, { keyPath }) {
          if (record.stores.has(storeName)) throw new Error(`ConstraintError: '${storeName}' exists`);
          const entry = { data: new Map(), keyPath };
          record.stores.set(storeName, entry);
          return new FakeObjectStore(storeName, entry);
        },
        transaction(storeNames, mode = 'readonly') {
          return new FakeTransaction(db, Array.isArray(storeNames) ? storeNames : [storeNames], mode);
        },
        close() {
          db._closed = true;
        },
        onversionchange: null,
      };

      queueMicrotask(() => {
        // result must be populated BEFORE onupgradeneeded, because that handler
        // is where a real app creates its object stores off req.result.
        req.result = db;
        if (record.version < version) {
          const oldVersion = record.version;
          record.version = version;
          req.onupgradeneeded && req.onupgradeneeded({ target: req, oldVersion });
        }
        req.succeed(db);
      });

      return req;
    },

    deleteDatabase(name) {
      const req = new FakeRequest();
      queueMicrotask(() => {
        databases.delete(name);
        req.succeed(undefined);
      });
      return req;
    },

    databases() {
      return databases;
    },
  };

  return factory;
}