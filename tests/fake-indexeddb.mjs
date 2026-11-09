/**
 * A minimal IndexedDB test double.
 *
 * The project ships no package.json and no node_modules, and this file must stay
 * that way — so the Foundation tests cannot reach for `fake-indexeddb`. This is
 * the smallest implementation of the surface the app actually uses:
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
 * ── What it does on purpose, so tests cannot pass by accident ────────────
 *   - Values are deep-cloned on write and on read, exactly as a real IndexedDB
 *     does. Without that, a caller mutating a record it had just received would
 *     silently change what is "stored".
 *   - A transaction is ATOMIC. Writes are buffered in a per-transaction overlay
 *     and only applied to the backing store when the transaction completes;
 *     `abort()` throws the overlay away. Reads inside the transaction see its
 *     own writes. This is the whole point of the atomicity tests: a sale that
 *     writes lots and then aborts must leave the lots exactly as they were, and
 *     only a double that rolls back can prove that. (The previous version wrote
 *     straight through and had no rollback, so it could not.)
 *   - Auto-commit follows pending requests: a transaction finishes once no
 *     request is outstanding and a microtask has passed, which is what lets a
 *     caller chain reads and then issue writes in the same transaction.
 *
 * `getAll` / `count` / `openCursor` / index bookkeeping exist because `js/db.js`
 * — the real shop database, not a stand-in for it — is exercised through this
 * double by the accounting and backup tests.
 *
 * Backing data is kept per-database in this closure, so it survives a simulated
 * app restart as long as the test holds on to the same factory.
 */
export function createFakeIndexedDB() {
  /** name -> { version, stores: Map<string, Map<string, any>> } */
  const databases = new Map();

  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  const DELETED = Symbol('deleted');

  // Optional fault injection for the atomicity tests. A test sets
  // `factory.faults.write = (store, key) => Error | null` to make the next write
  // to a store fail; `read` does the same for reads. It lives on the factory so
  // it applies to the database the app already opened. Failing a request aborts
  // the transaction, exactly as a real request error does.
  const faults = { read: null, write: null };

  class FakeRequest {
    constructor(tx = null) {
      this.onsuccess = null;
      this.onerror = null;
      this.onblocked = null;
      this.result = undefined;
      this.error = null;
      this._tx = tx;
    }
    succeed(value) {
      this.result = value;
      queueMicrotask(() => {
        try {
          // Once a transaction has aborted, its queued requests behave as real
          // ones do: the success never lands.
          if (this._tx && this._tx._aborted) {
            this.onerror && this.onerror({ target: this });
            return;
          }
          this.onsuccess && this.onsuccess({ target: this });
        } catch (err) {
          // An exception thrown out of a success handler aborts the whole
          // transaction in a real database; mirror that, so a test that throws
          // mid-write sees a clean rollback instead of a half-applied change.
          if (this._tx) this._tx._failFromError(err);
          else throw err;
        } finally {
          if (this._tx) this._tx._settle();
        }
      });
    }
    fail(err) {
      this.error = err;
      queueMicrotask(() => {
        try {
          if (this.onerror) {
            // The caller handled it (e.g. `readStock` calls `fail(...)`, which
            // aborts the transaction itself).
            this.onerror({ target: this });
          } else if (this._tx) {
            // No handler: an unhandled request error aborts the transaction.
            this._tx.error = err;
            this._tx.abort();
          }
        } finally {
          if (this._tx) this._tx._settle();
        }
      });
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
    constructor(name, entry, tx = null) {
      this.name = name;
      this._data = entry.data;
      this._keyPath = entry.keyPath;
      this._indexes = entry.indexes;
      this._tx = tx;
      this.indexNames = indexNameList(entry.indexes);
    }

    /** The merged view (committed data + this transaction's own writes). */
    _read() {
      return this._tx ? this._tx._read(this.name) : this._data;
    }
    _req() {
      return this._tx ? this._tx._req() : new FakeRequest();
    }
    _overlay() {
      return this._tx ? this._tx._overlay(this.name) : null;
    }
    /** Test-only fault: returns an Error to fail the request, or null. */
    _fault(kind, key, value) {
      const fs = this._tx && this._tx.db && this._tx.db._faults;
      const fn = fs && fs[kind];
      return fn ? fn(this.name, key, value) : null;
    }

    get(key) {
      const req = this._req();
      const err = this._fault('read', key);
      if (err) { req.fail(err); return req; }
      req.succeed(clone(this._read().get(String(key))));
      return req;
    }
    getAll() {
      const req = this._req();
      const err = this._fault('read');
      if (err) { req.fail(err); return req; }
      req.succeed([...this._read().values()].map(clone));
      return req;
    }
    count() {
      const req = this._req();
      const err = this._fault('read');
      if (err) { req.fail(err); return req; }
      req.succeed(this._read().size);
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

    /** Writes a value into the transaction overlay (or straight through). */
    _write(value) {
      const key = value[this._keyPath];
      if (key === undefined || key === null) {
        throw new Error(`DataError: a key is required for the '${this._keyPath}' keyPath`);
      }
      const overlay = this._overlay();
      if (overlay) overlay.ops.set(String(key), { del: false, value: clone(value) });
      else this._data.set(String(key), clone(value));
      return String(key);
    }
    _remove(key) {
      const overlay = this._overlay();
      if (overlay) overlay.ops.set(String(key), { del: true });
      else this._data.delete(String(key));
    }

    put(value) {
      const req = this._req();
      const err = this._fault('write', value && value[this._keyPath], value);
      if (err) { req.fail(err); return req; }
      try {
        req.succeed(this._write(value));
      } catch (e) {
        req.fail(e);
      }
      return req;
    }
    delete(key) {
      const req = this._req();
      const err = this._fault('write', key);
      if (err) { req.fail(err); return req; }
      this._remove(key);
      req.succeed(undefined);
      return req;
    }
    clear() {
      const req = this._req();
      const err = this._fault('write');
      if (err) { req.fail(err); return req; }
      const overlay = this._overlay();
      if (overlay) {
        overlay.cleared = true;
        overlay.ops.clear();
      } else {
        this._data.clear();
      }
      req.succeed(undefined);
      return req;
    }

    /**
     * A real index answers by the record's own `keyPath` value, not by nothing.
     *
     * The FIFO accounting tests depend on this: `db.getStockBatches()` asks the
     * `variantKey` index for one size|colour pair and consumes the batches it
     * gets back. An index that returned *every* batch would make a sale on
     * `L|أحمر` quietly eat the stock of `M|أزرق`, and the tests would bless a
     * bug instead of catching it — so filtering lives here, in the double,
     * where the real database does it too.
     *
     * `key === undefined` is a full scan, which is what `getAll()` with no
     * argument means in IndexedDB.
     */
    index(name) {
      const idx = this._indexes.get(name);
      if (!idx) return null;
      const self = this;
      const matches = (rec, key) => (key === undefined ? true : String(rec[idx.keyPath]) === String(key));
      const rows = (key) => [...self._read().values()].filter((r) => matches(r, key)).map(clone);
      return {
        name: idx.name,
        keyPath: idx.keyPath,
        getAll(key) {
          const req = self._req();
          const err = self._fault('read', key);
          if (err) { req.fail(err); return req; }
          req.succeed(rows(key));
          return req;
        },
        get(key) {
          const req = self._req();
          const err = self._fault('read', key);
          if (err) { req.fail(err); return req; }
          const found = rows(key);
          req.succeed(found.length ? found[0] : undefined);
          return req;
        },
        openCursor(key) {
          const req = self._req();
          self._walk(rows(key), req);
          return req;
        },
      };
    }

    /**
     * Yields the values one at a time, through the same request object — the
     * shape a real cursor has. `continue()` queues the next step (and counts as
     * an outstanding request, so the transaction does not commit mid-walk);
     * stopping early lets the transaction finish.
     */
    openCursor() {
      const req = this._req();
      this._walk([...this._read().values()].map(clone), req);
      return req;
    }
    _walk(list, req) {
      const self = this;
      let i = 0;
      const step = () => {
        if (i >= list.length) {
          req.result = null;
          req.onsuccess && req.onsuccess({ target: req });
          self._tx && self._tx._settle();
          return;
        }
        const value = list[i++];
        req.result = {
          value,
          update: (v) => self.put(v),
          delete: () => self.delete(value[self._keyPath]),
          continue: () => {
            self._tx && self._tx._req();
            queueMicrotask(step);
          },
        };
        req.onsuccess && req.onsuccess({ target: req });
        self._tx && self._tx._settle();
      };
      queueMicrotask(step);
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
      this._done = false;
      this._pending = 0;
      this._commitScheduled = false;
      // storeName -> { cleared: bool, ops: Map<key, {del, value}> }
      this._overlays = new Map();
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
      // Auto-commit: a transaction finishes once it has no outstanding requests.
      // The check is scheduled rather than run inline so synchronous request
      // chains (read → write) stay inside the same transaction.
      queueMicrotask(() => this._commitSoon());
    }
    _overlay(name) {
      let o = this._overlays.get(name);
      if (!o) {
        o = { cleared: false, ops: new Map() };
        this._overlays.set(name, o);
      }
      return o;
    }
    _read(name) {
      const base = this.db._record.stores.get(name)?.data;
      const o = this._overlays.get(name);
      if (!o) return base || new Map();
      const merged = new Map(o.cleared ? [] : (base || new Map()));
      for (const [k, op] of o.ops) {
        if (op.del) merged.delete(String(k));
        else merged.set(String(k), op.value);
      }
      return merged;
    }
    _req() {
      this._pending++;
      return new FakeRequest(this);
    }
    _settle() {
      if (this._pending > 0) this._pending--;
      if (this._pending === 0) this._commitSoon();
    }
    /** An exception escaped a request handler: abort with that error. */
    _failFromError(err) {
      if (this._done || this._aborted) return;
      this.error = err;
      this.abort();
    }
    _commitSoon() {
      if (this._done || this._aborted || this._commitScheduled || this._pending > 0) return;
      this._commitScheduled = true;
      queueMicrotask(() => {
        this._commitScheduled = false;
        if (this._done || this._aborted || this._pending > 0) return;
        this._done = true;
        this._commit();
        this.oncomplete && this.oncomplete({ target: this });
      });
    }
    _commit() {
      for (const [name, o] of this._overlays) {
        const entry = this.db._record.stores.get(name);
        if (!entry) continue;
        if (o.cleared) entry.data.clear();
        for (const [k, op] of o.ops) {
          if (op.del) entry.data.delete(String(k));
          else entry.data.set(String(k), op.value);
        }
      }
      this._overlays.clear();
    }
    objectStore(name) {
      if (this._storeNames !== null && !this._storeNames.includes(name)) {
        throw new Error(`NotFoundError: no store named '${name}'`);
      }
      const cached = this._resolved.get(name);
      if (cached) return cached;
      const entry = this.db._record.stores.get(name);
      if (!entry) throw new Error(`NotFoundError: no store named '${name}'`);
      const store = new FakeObjectStore(name, entry, this);
      this._resolved.set(name, store);
      return store;
    }
    abort() {
      if (this._aborted || this._done) return;
      this._aborted = true;
      // Roll back: the buffered writes are simply dropped.
      this._overlays.clear();
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
        _faults: faults,
        // A real `IDBDatabase.objectStoreNames` is a `DOMStringList`: iterable,
        // `length`-aware, with `item()` and `contains()`. The backup layer
        // ENUMERATES it (that is how a new table gets into a backup without
        // anyone editing a list), so a double offering only `contains()` would
        // make every export look empty. Read live off `record.stores` so stores
        // created during the upgrade are visible on the very next line.
        objectStoreNames: (() => {
          const names = () => [...record.stores.keys()];
          return {
            contains: (n) => record.stores.has(n),
            get length() {
              return record.stores.size;
            },
            item: (i) => names()[i] ?? null,
            forEach: (fn, thisArg) => names().forEach(fn, thisArg),
            [Symbol.iterator]: () => names()[Symbol.iterator](),
          };
        })(),
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

    // The shared fault registry the atomicity tests drive (see `faults` above).
    faults,
  };

  return factory;
}
