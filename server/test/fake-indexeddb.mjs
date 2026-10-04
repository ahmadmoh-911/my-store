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
 *   db.transaction(names, mode) -> objectStore().get / getAll / count / put /
 *                                   delete / clear / openCursor / createIndex,
 *                                 oncomplete
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
 * `getAll` / `count` / `openCursor` / index bookkeeping exist because `js/db.js`
 * — the real shop database, not a stand-in for it — is exercised through this
 * double by the backup tests. A double that only spoke `identity-store.js` would
 * let those tests prove nothing about the store they claim to cover.
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

  /**
   * The set of index names on a store.
   *
   * `js/db.js` reaches for this during an upgrade to drop an orphaned index
   * (`sales.indexNames.contains('customerId')`), so a store that did not answer
   * it would fail the very first time a test opened the shop database.
   */
  function indexNameList(indexes) {
    const names = [...indexes.keys()];
    return {
      contains: (name) => names.includes(name),
      length: names.length,
      item: (i) => names[i] ?? null,
      [Symbol.iterator]: () => names[Symbol.iterator](),
    };
  }

  class FakeObjectStore {
    constructor(name, entry) {
      this.name = name;
      this._data = entry.data;
      this._keyPath = entry.keyPath;
      this._indexes = entry.indexes;
      this.indexNames = indexNameList(entry.indexes);
    }
    get(key) {
      const req = new FakeRequest();
      req.succeed(clone(this._data.get(String(key))));
      return req;
    }
    getAll() {
      const req = new FakeRequest();
      req.succeed([...this._data.values()].map(clone));
      return req;
    }
    count() {
      const req = new FakeRequest();
      req.succeed(this._data.size);
      return req;
    }
    createIndex(name, keyPath) {
      this._indexes.set(name, { name, keyPath });
      this.indexNames = indexNameList(this._indexes);
      return { name, keyPath };
    }
    deleteIndex(name) {
      this._indexes.delete(name);
      this.indexNames = indexNameList(this._indexes);
    }
    index(name) {
      const idx = this._indexes.get(name);
      if (!idx) return null;
      const self = this;
      return {
        name: idx.name,
        keyPath: idx.keyPath,
        getAll() {
          const req = new FakeRequest();
          req.succeed([...self._data.values()].map(clone));
          return req;
        },
        get(key) {
          const req = new FakeRequest();
          req.succeed(null); // Simplified - real index would look up by key
          return req;
        },
      };
    }
    /**
     * Yields nothing, once.
     *
     * A real cursor walks a store record by record. Nothing in the backup tests
     * depends on that walk, and an empty store is the honest result for one —
     * the single `null` is what tells the caller it has finished.
     */
    openCursor() {
      const req = new FakeRequest();
      queueMicrotask(() => {
        req.result = null;
        req.onsuccess && req.onsuccess({ target: req });
      });
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
      // Store names are remembered, not the store objects themselves, and
      // resolved at call time. Snapshotting them here would break the upgrade
      // path: the versionchange transaction has to reach the stores that the
      // upgrade handler creates on its very next line, which is also what a real
      // IndexedDB does.
      //
      // `storeNames === null` means "every store, including ones not created
      // yet" — the scope of a real versionchange transaction.
      this._storeNames = storeNames === null ? null : [...storeNames];
      this._resolved = new Map();
      // Auto-commit: real IndexedDB finishes a transaction once its queued
      // requests are done, which for synchronous use is the next task.
      queueMicrotask(() => queueMicrotask(() => {
        if (this._aborted) return;
        this.oncomplete && this.oncomplete({ target: this });
      }));
    }
    objectStore(name) {
      if (this._storeNames !== null && !this._storeNames.includes(name)) {
        throw new Error(`NotFoundError: no store named '${name}'`);
      }
      const cached = this._resolved.get(name);
      if (cached) return cached;
      const entry = this.db._record.stores.get(name);
      if (!entry) throw new Error(`NotFoundError: no store named '${name}'`);
      const store = new FakeObjectStore(name, entry);
      this._resolved.set(name, store);
      return store;
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
          const entry = { data: new Map(), keyPath, indexes: new Map() };
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
          // A real upgrade hands the handler a live versionchange transaction.
          // `js/db.js` uses it to scrub legacy records and throws without one,
          // which would fail every fresh-database test for a reason that has
          // nothing to do with what is being tested.
          req.transaction = new FakeTransaction(db, null, 'versionchange');
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