# Store Hub — Foundation Layer

Small, self-contained modules that later phases build on. Nothing here is wired
into the app yet, so none of it can change how Store Hub behaves today.

## What is here

| File | Responsibility |
|---|---|
| `js/version.js` | The **logical** Store Hub version (`1.0.0`) and semantic-version comparison. |
| `js/platform.js` | Which runtime this is: `web`, `android`, `ios`, or `unknown`. Reuses `native.js`; never sniffs the user agent. |
| `js/clock.js` | Local time vs. last **trusted** server time. Refuses to invent a server time it was not given. |
| `js/identity-store.js` | Identity / install / licence metadata in its **own** IndexedDB database, `storehub_identity`. |

## The three boundaries

```
  saher_db  (js/db.js)          storehub_identity  (js/identity-store.js)
  ─────────────────────         ────────────────────────────────
  products, sales, purchases,   install_id, platform, Google's
  suppliers, supplierInvoices,  subject id, email, display name,
  supplierPayments, settings    licence id/status/expiry,
                                lastVerifiedAt, lastServerTime
        │                                │
        │  backup (exportAll)            │  never in a backup
        ▼                                ▼
  customer's file               licence backend (a future phase)
                                identity + licence metadata ONLY
```

Three rules hold this together, and later phases must not break them:

1. **Store data never reaches the backend.** `exportAll()` reads `saher_db` only.
   A future backup destination may use the customer's own Google Drive, but it
   must not be proxied through our server.
2. **Identity is not in the store database.** Not as an eighth object store.
   `exportAll()` enumerates `saher_db`, so a separate database makes it
   *impossible* for licence state to leak into a customer backup — rather than
   merely discouraged.
3. **Admin sees licence/account/device metadata only.** Platform and app version
   describe the software; they say nothing about the shop. `platformInfo()` is
   the exact payload intended for the backend.

Also note: an `account` record is **not** proof of sign-in. There is no Google
auth yet, and `identity-store.js` deliberately offers no `isAuthenticated()`.

## The clock rule

The device's date can be changed by its owner, so it can never decide whether a
licence is valid. Until a server timestamp is supplied, `estimatedServerTime()`
returns `null` and `hasTrustedTime()` is `false` — a licence check written later
cannot accidentally trust the device clock, because the value it needs does not
exist yet. There is a 14-day offline grace period in the plan; **no enforcement
is implemented here.**

## Deliberately not here yet

Google Login · licence API · backend · Google Drive backup · admin UI · any
enforcement. `sw.js` is untouched, including its `BUILD` number.

Because nothing in the app imports these modules yet, they are deliberately
**not** in the service worker's precache list — an uncalled entry is dead weight.
Whichever phase first imports them must add them to `PRECACHE` and bump `BUILD`
in the same change, or they will not be available offline.

## Tests

```
node tests/foundation.test.mjs
```

No dependencies: the repo has no `package.json`, and `tests/fake-indexeddb.mjs`
is a small IndexedDB test double injected into the module.