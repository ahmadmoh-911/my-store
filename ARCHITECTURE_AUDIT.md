# ARCHITECTURE_AUDIT.md

**Project:** متجري (Saher) — clothing store management, offline-first
**Scope of this document:** read-only architecture audit of the existing code
**Files inspected:** all 19 modules in `js/`, all 7 screens, `index.html`, `sw.js`, plus the project root layout
**Not done here (deliberately):** no code changed, no database change, no refactor, no feature work, no UI redesign

Every statement below is taken from the files listed above. Line references are included where a finding depends on exact code.

---

## 1. Current Architecture Overview

Saher is a **single-page application** with **no bundler and no build step**. `index.html` (line 84) loads one ES module entry point, `js/main.js`, and every other module is reached through native `import` statements. Files are plain text on disk; there is no transpilation, no `package.json`, no `node_modules`.

**Routing** is hash-based and lives in `js/router.js`. `ROUTES` (lines 26–35) is a flat array of 8 entries, each `{ order, match: RegExp, nav, screen }`. `startRouter()` (line 251) normalises an empty hash to `#/dashboard`, binds `hashchange` → `render()`, and returns the first render. Hash routing is the right choice here: it works from any static host or sub-folder with no server rewrites, which matters for a PWA that may be served from a file path or a Capacitor asset loader.

**Rendering model.** Every screen module exports `render(params)` that returns a `.screen` div, built synchronously, with its async data load started *inside* `render()` and guarded by an `isConnected` check after the await. The router's `render()` (line 154) does the following in order:

1. increment `renderToken`, read path, `match()` the route
2. call `route.screen.render(params)` inside `try/catch`; a throw becomes an error screen (line 170–174), so a broken screen never leaves a blank page
3. capture the outgoing screen as `view.lastElementChild` (line 178) — the newest child, not the first, so an interrupted swap still fades the right element
4. call the outgoing screen's `destroy()` if it has one **and** the path changed (line 181–187), wrapped in its own try/catch
5. if swapping: remove `is-entering`, add `is-leaving` to the old screen, add `is-swapping` to `#view`; otherwise `clear(view)`
6. append the new screen with `is-entering`, mount it **immediately** (before any await) — the comment at lines 191–194 explains why: screens skip painting while detached, so a deferred mount would show nothing
7. set `currentRoute`, `lastOrder`, re-render nav chrome, toggle `body.is-pos`
8. notify `onRoute` listeners
9. after `TRANSITION_MS - 40`, remove the faded-out screen and clear `is-swapping`

The `old.remove()` in step 9 is deliberately unconditional, with a comment that an interrupted swap would otherwise leak a screen on every rapid navigation.

**Persistence** is IndexedDB only, in `js/db.js`. There is no server, no sync, no cloud, and no user accounts. `DB_VERSION = 3`, six object stores.

**Delivery** is dual: a web PWA (`sw.js` + `manifest.json`) and an Android APK built with Capacitor. The APK present in the project root is 29,545,161 bytes.

**Distribution of concerns.** `js/utils.js` (DOM + formatting + animation + files), `js/components.js` (toasts, modals, sheets, dialogs, empty states), `js/db.js` (all persistence and all business transactions), `js/analytics.js` (pure read-only derivations), `js/charts.js` (Chart.js wrapper with a canvas registry), `js/native.js` (Capacitor bridge with web fallbacks), `js/cart-store.js` (shared cart state), `js/cart-bar.js` (sticky cart bar), `js/invoice-sheet.js` and `js/stock-sheet.js` (overlay modules), and 7 screen modules.

The overall shape is coherent: pure data layer, pure analytics layer, shared UI layer, and thin screens that compose them. It is a well-disciplined codebase for its size.

---

## 2. File Responsibility Map

| File | Lines | Responsibility |
|---|---|---|
| `index.html` | 86 | Document shell: boot splash, `#shell` (sidebar + topbar + offline bar + `#view` + bottomnav), overlay hosts (`#toasts`, `#fly-layer`, `#print-root`), html5-qrcode fallback `<script>`, `<script type="module" src="js/main.js">` |
| `sw.js` | 171 | Service worker: precache list, cache-first for navigations (`shellFirst`), stale-while-revalidate for sub-resources (`cacheFirst`), old-cache cleanup, `SKIP_WAITING` message channel |
| `js/main.js` | 329 | Entry point. Service-worker registration (skipped when native), settings load, first-run seeding, topbar build, store-name painting, connectivity indicator, install prompt, low-stock badge, Android back wiring, global handlers, `boot()` |
| `js/router.js` | 271 | Route table, nav chrome (`BOTTOM_NAV`, `SIDE_NAV`, `NAV_ITEMS`, `renderNav`, `setLowStockCount`), the render pipeline, `navigate`, `refresh`, `onRoute`, `getPath`, `setTopbarContext` |
| `js/db.js` | 661 | Entire IndexedDB layer: schema, migrations, `tx`/`multiTx`/`request`, generic CRUD, product domain, sales domain (`createSale`, `updateSale`, `refundSale`), supplier domain, settings, `exportAll`/`importAll`/`clearAll` |
| `js/analytics.js` | 158 | Read-only derivations: `loadAll`, `salesBetween`, `salesOn`, `revenue`, `orderCount`, `unitsSold`, `discountGiven`, `profit`, `avgBasket`, `pctChange`, `dailySeries`, `hourlySeries`, `bestSellers`, `categoryTotals`, `paymentBreakdown`, `lowStockProducts`, `outOfStock`, `stockByCategory` |
| `js/utils.js` | 489 | `el()` hyperscript, `appendAll`, `frag`, `$`/`$$`, `clear`, `fromHTML`, `escapeHTML`, `uid`, `debounce`, `clamp`, `sum`, `groupBy`, `wait`, number/currency/date formatters (`num`, `numInt`, `money`, `moneyHTML`, `fmtDate`, `fmtTime`, `fmtDayName`, `isoDate`, `startOfDay`, `endOfDay`, `addDays`, `relTime`), animations (`countUp`, `ripple`, `flyTo`, `confetti`, `nudge`), file helpers (`downloadBlob`, `downloadText`, `pickFile`, `readFileAsDataURL`, `readFileAsText`, `processImage`), `initials`, `iconEl`, `setBusy`, `toCSV` |
| `js/components.js` | 446 | `toast`, focus trap, overlay stack (`pushOverlay`/`popOverlay`/`closeTopOverlay`), `openModal`, `openSheet`, `confirmDialog`, `promptDialog`, `celebrate`, `emptyState`, `skeletonGrid`, `loadingRow`, `sectionTitle`, `pageHead`, `mountList` |
| `js/cart-store.js` | 122 | The shared cart: `cart` array, `discount` object, `paymentMethod`, `lastSale`, `subscribe`/`emit`, totals (`subtotal`, `totalItems`, `lineCount`, `discountAmount`, `grandTotal`), mutators (`clearCart`, `resetForNextSale`, `setQty`, `removeLine`). **Imports nothing.** |
| `js/cart-bar.js` | 256 | The sticky bottom cart bar. Mounted once into `document.body`; subscribes to the store; peeks open on `added` and folds after 2600 ms; `syncRoute(path)`; inline line editor with qty ±/remove and totals |
| `js/invoice-sheet.js` | 253 | Sale invoice overlay: read-only detail plus editor for discount type/value, payment method and note, wired to `updateSale` and `refundSale` |
| `js/stock-sheet.js` | 208 | Stock-raising overlay: products grouped by category with collapsible groups, per-variant "add N" / "set to N" modes, writes through `saveProduct` |
| `js/charts.js` | 223 | Chart.js wrapper: lazy `loadChartJS()`, a `registry` Map keyed by canvas, `lineChart`, `barChart`, `doughnutChart`, `destroyCharts`, `destroyChart`, `PALETTE` |
| `js/native.js` | 133 | Capacitor bridge: `isNative`, `printPage`, `saveBlob`, `shareText`, `onNativeBack`, `minimizeApp` — each with a web fallback |
| `js/scanner.js` | 253 | Barcode scanning in three layers (native ML Kit → `html5-qrcode` → manual entry), `scanBarcode`, `cameraAvailable`, `listenForScan`, `reportMissing` |
| `js/icons.js` | — | Inline SVG icon set behind `icon(name, …)` |
| `js/seed.js` | 292 | First-run demo data: catalogue with generated product images, suppliers, and sales spread over 30 days; `seedIfEmpty()` |
| `js/screens/dashboard.js` | 622 | Home: hero, day navigator, 4 stat tiles, quick actions, the selected day's invoices, low-stock side column, best sellers, trend chart |
| `js/screens/products.js` | 602 | Products & inventory: search, category chips, sort, grid/list, variant matrix stock editing, barcode scan, low-stock filter |
| `js/screens/product-form.js` | 750 | Add/edit product: image, general info, size/colour selection with derived libraries, pricing with margin chip, stock matrix, validation, save, delete |
| `js/screens/pos.js` | 872 | Point of sale: product grid, search, categories, scan, variant picker, cart column, discount entry, payment methods, complete sale, receipt (print/share) |
| `js/screens/suppliers.js` | 740 | Suppliers: list with balances, per-supplier ledger, invoice editor, payment editor, supplier editor |
| `js/screens/reports.js` | 546 | Reports: date ranges, KPI cards, bar + doughnut charts, breakdowns, best sellers, CSV and PDF export |
| `js/screens/settings.js` | 402 | Settings: store identity, currency, threshold, categories/sizes/colors, backup, restore, clear all, install hint |
| `tools/*.js` | 2 files | Build-time helpers for icon and font generation — not shipped to the app |

---

## 3. Dependency / Import Map

Taken verbatim from the import statements in each file.

```
main.js
 ├── icons.js
 ├── utils.js
 ├── db.js
 ├── analytics.js          (lowStockProducts)
 ├── seed.js
 ├── components.js
 ├── router.js
 ├── cart-bar.js
 └── native.js

router.js
 ├── icons.js
 ├── utils.js
 ├── db.js                 (stockOf)
 └── screens/ dashboard, products, product-form, pos, suppliers, reports, settings

cart-bar.js
 ├── utils.js, icons.js, components.js, db.js
 ├── router.js             (navigate)
 └── cart-store.js

cart-store.js              → (no imports)

db.js                      → (no imports)

utils.js                   → icons.js, native.js
components.js              → icons.js, utils.js
charts.js                  → utils.js
analytics.js               → db.js, utils.js
native.js                  → (no imports)
icons.js                   → (no imports)
seed.js                    → utils.js
scanner.js                 → utils.js, components.js
stock-sheet.js             → icons.js, utils.js, components.js, db.js
invoice-sheet.js           → icons.js, utils.js, components.js, db.js

screens/dashboard.js       → icons, utils, db, analytics, charts,
                             components, invoice-sheet, stock-sheet, router
screens/products.js        → icons, utils, db, analytics, components,
                             scanner, ./product-form.js (PREFILL_KEY), router
screens/product-form.js    → icons, utils, db, components, scanner, router
                             (+ dynamic import of ./products.js)
screens/pos.js             → icons, utils, native, db, components,
                             scanner, router, cart-store
                             (+ dynamic import of ../db.js at line 724)
screens/suppliers.js       → icons, utils, db, components, router
screens/reports.js         → icons, native, utils, db, analytics, charts,
                             components, router
screens/settings.js        → icons, utils, db, components, router
```

**Layering observed:** `db.js` and `icons.js` and `native.js` are leaves. `utils.js` sits above `native.js`. `components.js`, `charts.js`, `analytics.js`, `cart-store.js`, `scanner.js`, `seed.js` are middle. Screens and overlay modules are the top. The only file that reaches *sideways* into another feature module is `screens/products.js` importing `PREFILL_KEY` from `screens/product-form.js`.

**Runtime cycles (not import cycles)** exist via the store, which is deliberate and documented: `main.js` mounts `cart-bar.js` and `router.js` imports `pos.js`, so the bar and the POS column are both live at once, synchronised through `cart-store.js`'s `subscribe`/`emit`.

---

## 4. Circular Dependencies

**One static import cycle, two mixed forms.**

1. `router.js` → `screens/pos.js` → `router.js` (and the same for all 7 screens). `router.js` imports every screen at module scope (lines 15–21) and every screen imports `navigate` from `router.js`. The cycle is tolerated because the screen modules only *call* `navigate` at runtime, never during module evaluation, and `ROUTES` holds a reference to each screen's namespace object rather than invoking it. This is a standard, working ES-module cycle — but it is order-sensitive: any screen that tried to call `navigate()` at top level would fail.

2. `screens/products.js` → `screens/product-form.js` → `screens/products.js`. This one is mixed: `products.js` imports `PREFILL_KEY` **statically** (line 13), while `product-form.js` imports `products.js` **dynamically** (lines 710 and 723, `import('./products.js').then(m => m.invalidate())`). Because the reverse edge is dynamic, the static cycle does not actually close, so the modules load cleanly. Note the asymmetry: `product-form.js` also exports a default of `{ render }` only, while `products.js` exports `{ render }` as default plus a named `invalidate()`.

**No other cycles exist.** `db.js`, `icons.js`, `native.js`, and `cart-store.js` are true leaves. `utils.js` → `native.js` is one-directional.

**Dynamic import sites (4 total), all intentional:**
- `components.js:347` — `import('./utils.js')` inside `celebrate()` so a confetti failure can never block the promise
- `pos.js:724` — `import('../db.js')` inside `seqForToday()` even though `db.js` is already statically imported at line 16; the dynamic form is redundant here
- `product-form.js:710, 723` — `import('./products.js')` to reach `invalidate()` and break the static edge

---

## 5. State Architecture

All application state is in module-scope variables. There is no store library, no observable wrapper, and no framework.

| State | Location | Persistence | Notes |
|---|---|---|---|
| `cart`, `discount`, `paymentMethod`, `lastSale` | `cart-store.js` (18–25) | Memory only | `cart` and `discount` are exported *live* references — screens mutate them directly and then call `emit()` |
| Cart-bar open/closed, peek timer, currency | `cart-bar.js` (27–37) | Memory only | `peekTimer` is cleared and re-armed on every `added` |
| `query`, `category`, product `cache`, `cacheReady`, `activeScreens` | `screens/pos.js` (34–38, 123–124) | Memory only | `cache` is memoised via `ensureCache()` and dropped by `invalidateCache()` after each sale |
| `viewDate`, `trendWindow` | `screens/dashboard.js` (18, 25) | Memory only | `trendWindow = 7`; `viewDate` defaults to today, walked by `setDay()` |
| `currentRoute`, `lastOrder`, `renderToken`, `lowStockCount`, `listeners` | `router.js` (65–69) | Memory only | `listeners` is a `Set`; `onRoute` returns an unsubscribe function |
| `currentSettings` | `main.js` (59) | Mirror of the `settings` store | Re-read from the DB on every route change (lines 304–310) |
| `toastTimer`, `openCount`, `overlayStack` | `components.js` (12, 41, 71) | Memory only | `overlayStack` is what the Android back button pops |
| Chart instances | `charts.js` `registry` | Memory only | Keyed by canvas; `destroyCharts()` clears the whole registry |
| Products, sales, suppliers, invoices, payments | IndexedDB | **Persistent** | 6 stores, see §9 |
| Store settings | IndexedDB `settings` | **Persistent** | Single record under key `app`, merged over `DEFAULT_SETTINGS` on read |
| Scanner state | `scanner.js` | Session | Camera stream and scan listeners |

**The state model is deliberately simple and the app lives entirely inside one process**, so nothing here needs synchronisation. Two properties are worth naming:

- **The cart is exported as a live mutable array.** `pos.js` does `cart.push(...)` (line 409) and `cart.splice(...)` (line 560) directly, and `discount.value = …` (line 602), then calls `paintCart()`. `cart-store.js`'s own `setQty`/`removeLine` mutate the same array. The single rule that keeps the two views consistent is "mutate, then `emit()`" — enforced by discipline, not by the type system or by freezing. `emit()` does isolate failures: one throwing listener cannot stop the others (lines 40–47).
- **`discount` is a shared `const` object mutated in place.** `clearCart()` resets its fields rather than reassigning (lines 87–94), with a comment explaining that reassigning would break every holder of the reference. Correct, and the reason is documented — but it means the object is a genuine shared mutable singleton across modules.

Nothing in this list is wrong. The one observation is that in-memory state does not survive a restart: `viewDate` resets to today, `trendWindow` resets to 7, and an unfinished cart is lost. For a single-device shop app that is a reasonable, defensible default.

---

## 6. Cart Architecture

This is the most recently restructured area, and it is the healthiest part of the codebase.

**The store** (`js/cart-store.js`, 122 lines) owns the cart and imports nothing. That is not an accident — the file's header comment states the reason: the bar is mounted in the app shell outside the router's `#view`, so if the store lived inside `pos.js` the bar would have to pull in the POS screen and create an import cycle through the router. The line shape is:

```js
cart → [{ key, productId, name, image, size, color, qty, price, costPrice, max }]
```

`key` is `${product.id}|${variant.size}|${variant.color}` (built in `pos.js:398`), which is what makes two lines of the same product in different sizes distinct, and two taps on the same variant merge instead of duplicating.

**Totals are single-sourced:**
- `subtotal()` = Σ `qty × price`
- `totalItems()` = Σ `qty`
- `discountAmount(sub = subtotal())` — percent is clamped at 100 and at the subtotal; fixed is clamped at the subtotal, so neither can produce a negative total
- `grandTotal()` = `max(0, subtotal − discount)`

`max` on each line is a snapshot of the variant's stock taken when the item was added, and it is what the `+` buttons disable against.

**Two views, one source.** The POS column (`repaintPos()`) and the sticky bar (`paintBar()`/`paintPanel()`) both read the same store and both render the same totals. Neither keeps its own copy. The bar is mounted in `document.body` (`main.js:282`, `cart-bar.js:245`) so it survives the router replacing `#view` wholesale.

**The feedback loop is a clean two-way mirror, and it is the part most worth protecting:**

- POS mutates → `paintCart(reason)` → `repaintPos()` then `emit(reason)` (lines 500–503)
- Bar mutates → `setQty`/`removeLine`/`clearCart` → `emit()` → bar's own subscription calls `onCartChange`, and POS's subscription calls `repaintPos()`

The POS screen subscribes as `subscribe(repaintPos)` (line 101) — the column, not `paintCart`, precisely because calling `paintCart` would re-emit and loop. The comment at lines 99–100 says so. This asymmetry is correct and intentional; it is also the single most fragile line of reasoning in the codebase, since nothing enforces it.

**Route awareness.** `router.js:222` toggles `body.is-pos`; `cart-bar.js:222 syncRoute(path)` folds the bar away on every screen except POS, and `onCartChange` peeks it open on `'added'` then collapses it after 2600 ms (lines 195–203). `mountCartBar()` guards against double-mounting with `if (bar) return` (line 239).

**Teardown.** `pos.js destroy()` (lines 858–870) drains `activeScreens` and unsubscribes, with a comment that explains the reason precisely: the cart must survive navigation, but the subscription must not, or every past POS screen would keep repainting a column that is no longer on screen. The router calls this on path change (lines 181–187). This is the correct treatment of a long-lived singleton with per-screen subscribers.

**Currency.** The bar loads currency once via `loadCurrency()` (lines 39–49) and deliberately resets `currencyLoaded = false` on failure so the next repaint can retry rather than being stuck on a default.

---

## 7. Product & Variant Architecture

**Record shape** — written by `saveProduct()` (`db.js:207–223`), which normalises and stamps `updatedAt`:

```js
{ id, name, sku, category, description, price, costPrice,
  variants: [{ size, color, quantity }], image, createdAt, updatedAt }
```

**Variants are the unit of stock.** All stock is per-variant; there is no product-level quantity anywhere. The three accessors are the whole vocabulary:

- `stockOf(product)` — Σ variant quantities
- `variantStock(product, size, color)` — one variant, 0 if not found
- `availableVariants(product)` — variants with `quantity > 0`

`variantStock` matches on strict equality of both `size` and `color` (lines 233–238), which is the same predicate used by `createSale` and `refundSale`. Consistency of that predicate across the four sites is the property that makes the whole inventory system correct, and it does hold.

**The form's draft model** (`product-form.js`) is a good pattern:

- `d.sizes` / `d.colors` are arrays of strings; `NO_SIZE = ''` is the sentinel for "no breakdown"
- `d.qty` is a sparse `Map` keyed by `` `${s||''}|${c||''}` `` (line 111)
- `buildVariants(d)` (lines 113–121) materialises the **full cross product** of sizes × colours on save, defaulting missing cells to 0
- `hydrate()` (lines 86–108) derives sizes/colours from an existing product's variants, and for a new product seeds from `settings.sizes.slice(0, 4)` and the first settings colour

The sparse-map-then-materialise approach is why deselecting a size automatically drops its combinations — the comment at lines 6–8 states this as the design intent, and the code does it.

**The size/colour library is derived, not toggled** — and this is the second thing in the codebase worth protecting. `paintSizes()` rebuilds the selected chips *and* calls `paintSizeLibrary()` (lines 308–346); `paintColors()`/`paintColorLibrary()` do the same (lines 360–400). The libraries are derived from `uniq([...settings.sizes, ...d.sizes])` on every paint. The comment block at lines 287–294 records exactly why: the two used to be painted independently, the library was built once and each chip toggled its own class, and removing a size with the × left the library chip still lit — a chip claiming a selection that no longer existed. Deriving both from the same `d.sizes`/`d.colors` state is the fix, and the code now does that consistently. The only residue is cosmetic: `sizeLibrary`/`colorLibrary` are declared as `let … = null` at lines 299–300 and assigned at 412–413, a forward-declaration dance that a reader will notice but that works.

**The stock matrix** (lines 494–545) is a `<table>` with sizes as columns, colours as rows, and one `<input type="number">` per cell writing straight into `d.qty`. It also renders a per-size totals `<tfoot>` and a `#stock-summary` line, and marks cells at or below `settings.lowStockThreshold` with `is-low`. `fillAll(v)` (lines 567–574) writes one value into every cell for bulk receiving.

**Validation** (lines 651–659) is minimal and appropriate: name ≥ 2 characters, price > 0, cost price not negative. It does not require any stock, which is a product decision, not a gap.

**Where else products are written:** `products.js` (inline stock edits in the inventory screen) and `stock-sheet.js` (per-variant add/set). Both go through `saveProduct()`, so all three writers normalise and stamp `updatedAt` the same way. `stock-sheet.js commit()` (lines 181–205) is notably careful — it builds a shallow clone with a new `variants` array before writing, because `saveProduct` stamps `updatedAt` and mutating the shared object would shift the dashboard's numbers under the owner. It then updates the in-memory objects *after* a successful save, so a failed write cannot leave the UI claiming a quantity that was not stored.

---

## 8. Sales & Inventory Architecture

This is the part of the system that matters most and it is implemented with real care.

**`createSale(sale)`** (`db.js:263–339`) writes the sale and decrements stock in **one** `multiTx([sales, products], 'readwrite', …)` transaction. The algorithm and its reasoning are both in the code:

- normalise items, compute `subtotal`, clamp `discount` (percent capped at 100, fixed capped at subtotal), `total = round2(subtotal − discount)`, and snapshot `costTotal` from the item cost prices *at sale time* — which is what makes historical profit reportable without joining back to current product costs
- `receiptNo: sale.receiptNo || nextReceiptNo(sale.receiptSeq)`
- collect the distinct `productId`s, `get()` each **exactly once** into a `Map`, count completions, and only when the last read lands apply every matching line item and write each product **once** (lines 301–333)

The comment at lines 301–304 states the reason precisely: a `get`/`put` pair per line would let two lines of the same product overwrite one another, because both reads see the same snapshot and the last write silently discards the earlier decrement. The read-once/write-once pattern is the correct defence, and it is applied consistently in all three transaction functions.

**`updateSale(saleId, patch)`** (lines 351–438) moves stock **by difference**, not by the new quantities. It builds a `delta` map — `+old.qty` for every line of the stored sale, then `−new.qty` for every line of the patch, keyed by product then by `` `${size} ${color}` `` (lines 396–407) — then applies the net delta per variant with the same read-once/write-once structure. Lowering a line from 3 to 1 returns 2 units; raising it to 4 takes 1 more. The docstring (lines 341–350) explains this in the same terms. An edit also re-derives `subtotal`/`discount`/`total`/`costTotal` and stamps `updatedAt` while preserving `paymentMethod` and `note` when not patched.

**`refundSale(saleId)`** (lines 441–482) deletes the sale record and adds each line's quantity back, read-once/write-once, with no floor applied (a refund genuinely returns stock even if it has since been sold). The `deleteSale` export at line 484 is a bare `del()` with no stock restore — it exists but is not what the UI uses for refunds.

**The invariant, stated plainly:** the only two paths that move stock are `createSale` (down) and `updateSale`/`refundSale` (by delta / up). `saveProduct` changes quantities but is the owner's explicit edit, not a consequence of a sale. There is no other writer of `variants[].quantity` anywhere in the app except `products.js`'s inline editor and `stock-sheet.js`, both of which are deliberate owner actions.

**The POS side** (`pos.js:667–720`) is a faithful caller. `completeSale()` re-reads all products and re-checks every line against `variantStock` before committing (lines 674–683) — a genuine guard against stock that moved since the cart was built, and it aborts with a specific message naming the product and the real availability. It then gets the daily sequence, calls `createSale`, stores the sale via `setLastSale`, celebrates, resets for the next sale (`clearCart`, `setPaymentMethod('cash')`, `invalidateCache()`), repaints both cart and products, and opens the receipt.

**Receipt numbering** is passed in rather than computed in `db.js`: `seqForToday()` (`pos.js:723–727`) counts today's sales and `createSale` turns that into `nextReceiptNo(seq)`. The design keeps numbering in the UI layer, which is defensible, but it means the number is derived from a count rather than from a stored sequence — see §15 for the consequence.

**Reporting on top of this** is read-only and derived on demand; there are no stored aggregates. `analytics.loadAll()` fetches products, sales and settings in one `Promise.all`, and every KPI, series and breakdown is computed from those raw records on each render. The upside is that a backup/restore can never disagree with the numbers; the cost is a full read per screen render.

---

## 9. Database Boundary

**Schema** — `DB_NAME = 'saher_db'`, `DB_VERSION = 3`, six stores created in `onupgradeneeded` (`db.js:43–109`):

| Store | keyPath | Indexes | Written by |
|---|---|---|---|
| `products` | `id` | `createdAt`, `name` | `saveProduct` |
| `sales` | `id` | `timestamp` | `createSale`, `updateSale`, `deleteSale`, `refundSale` |
| `suppliers` | `id` | `createdAt` | `saveSupplier` |
| `supplierInvoices` | `id` | `date`, `supplierId` | `createSupplierInvoice` |
| `supplierPayments` | `id` | `date`, `supplierId` | `createSupplierPayment` |
| `settings` | `key` | — | `saveSettings` (single `app` record) |

**Migration to v3** is the removal of customers, and it is done thoroughly (lines 72–106): `deleteObjectStore('customers')` if present, then — because deleting a store does not delete an index that pointed at it — `deleteIndex('customerId')` on sales if it is still there, then a cursor pass that deletes `customerId` and `customerName` from every sale record and logs the count. The stated reasoning (lines 80–83) is that an orphaned index and an invisible field are both still customer data sitting in the file, and a backup taken from that file would carry them back out. That is a genuinely careful migration.

**Transaction primitives** are two small functions, and the split is meaningful:

- `tx(store, mode, run)` — single store (accepts a name or an array but only ever opens `store[0]`)
- `multiTx(stores, mode, run)` — hands the callback a `store(name)` accessor for all of them

Both resolve on `t.oncomplete` and reject on `onerror`/`onabort`, so a caller awaiting them knows the work is committed. `multiTx` is used by exactly the three functions that must touch sales and products together; everything else uses `put`/`del`.

**The boundary itself is clean: `db.js` is the only module that talks to IndexedDB.** No screen, sheet or utility opens a database, a transaction or an object store. Screens reach storage exclusively through the exported domain functions. This is the strongest structural property in the codebase and it is worth preserving deliberately.

**Generic CRUD** — `getAll`, `get`, `put`, `del`, `clearStore`, `count` — is exported alongside the domain functions. Screens use `getAll` only through domain wrappers; `settings.js` uses the domain wrappers for export/import. The generic layer is available but not leaned on by callers, which is the right balance.

**Whole-database operations:** `exportAll()` (line 660) reads all six stores and returns a JSON document; `importAll(data)` (line 684) clears and re-inserts, stripping customer fields on the way in; `clearAll()` (line 716) wipes everything. `settings.js` owns the UI for all three and is the only caller.

**Settings** are a single record under key `app`. `getSettings()` (line 647) returns `{ ...DEFAULT_SETTINGS, ...(rec || {}), key: 'app' }`, so a record written by an older version gains new default keys on read rather than returning `undefined`. `saveSettings(patch)` reads, merges and writes the whole record (line 652) — a read-modify-write with no transaction guard, which is fine for a single-writer, single-device app but is a lost-update hazard if that ever changes.

**`dbPromise` handling** is correct for a single tab: cached promise, and `db.onversionchange` closes the connection and nulls the promise (lines 111–119) so a future upgrade in another tab does not leave this one holding a stale handle. `onblocked` logs a warning. There is no multi-tab coordination beyond this, which matches the single-device requirement.

---

## 10. Reports & Analytics

**`js/analytics.js` is a pure derivation layer** — 158 lines, no writes, no DOM, and the header comment states the design choice: nothing is stored pre-aggregated, so a restore/backup always rebuilds identical numbers. It imports `stockOf` from `db.js` and date/sum helpers from `utils.js`, which keeps its dependency footprint tiny.

**`loadAll()`** (lines 11–18) is the shared entry point: `Promise.all([listProducts(), listSales(), getSettings()])`, returning `{ products, sales, settings }`. One round-trip for both `dashboard.js` and `reports.js`.

**Filtering.** `salesBetween(sales, from, to)` compares `new Date(s.timestamp).getTime()` against the two bounds (lines 24–31). `salesOn(sales, day)` builds a key with `isoDate(day)` and compares it against `s.timestamp.slice(0, 10)` (lines 33–36). These two functions use *different* comparison strategies — one parses to epoch milliseconds, the other slices a string — and they do not agree about time zones. That is the single most consequential finding in this audit; see §15.

**Totals** are all one-liners over the sales array: `revenue` = Σ `total`, `orderCount` = length, `unitsSold` = Σ item qty, `discountGiven` = Σ `discount`, `avgBasket` = revenue / count. `profit()` (lines 50–52) is `total − costTotal` per sale, deliberately using the cost snapshotted at sale time rather than the product's current `costPrice` — so a later price change never rewrites history.

**`pctChange(now, prev)`** (lines 56–58) returns `null` when there is no baseline and `prev` is 0 but `now` is positive — the "first day, no comparison" case, which `dashboard.js:220` renders as `أول يوم` rather than as a misleading `+∞%`. A small correctness detail handled properly.

**Series.** `dailySeries(sales, days)` (line 74) builds a contiguous, zero-padded day range; `hourlySeries(sales)` (line 96) buckets today by hour. Both fill gaps with zero, which is what makes the trend chart honest on quiet days.

**Breakdowns.** `bestSellers(sales, limit)`, `categoryTotals(sales, products)`, `paymentBreakdown(sales)`, plus `lowStockProducts(products, threshold)` and `outOfStock(products)` for inventory. `stockByCategory(products)` (line 172) is the category rollup the dashboard's side column uses.

**`reports.js`** composes these with date presets (today, yesterday, 7/30 days, custom), four KPI cards, a bar chart and two doughnut charts via `charts.js`, best sellers, and two exports. Two decisions here are worth recording because they are deliberate and non-obvious:

- **PDF is the browser print pipeline, not a library.** The header comment (lines 1–7) explains: jsPDF cannot shape Arabic text correctly, so printing through a dedicated print stylesheet produces correct Arabic and works offline. The same reasoning appears in `pos.js` for receipts, writing into `#print-root` and letting `main.js`'s `afterprint` handler clear it (lines 230–233) so the DOM never holds a large table.
- **Buckets are capped.** `const MAX_BUCKETS = 120` (line 24) with a comment that a 3-year custom range would otherwise melt the canvas. A range longer than 120 buckets is aggregated rather than drawn.

CSV goes through `utils.downloadText()`, which prefixes a UTF-8 BOM specifically so Excel opens the Arabic correctly (line 377). `utils.toCSV()` handles quoting, embedded commas, newlines and doubled quotes.

**Chart lifecycle.** `charts.js` holds a `registry` Map keyed by canvas element. Each chart function calls `destroy(canvas)` before constructing, so redrawing the same canvas replaces rather than stacks. `destroyCharts()` clears everything, and it is called from `reports.js:341` and from `destroy()` in both `reports.js` and `dashboard.js`. Because the registry is global rather than per-screen, two screens cannot own charts simultaneously — which is true today only because the router destroys the outgoing screen before the incoming one paints.

**Caching.** There is none. Each screen render re-reads all sales. On a few thousand records this is fine on a modern phone, and the "no pre-aggregation" trade is worth making for a backup-restore-correctness guarantee. Worth revisiting only if the sales history grows large.

---

## 11. Supplier Architecture

The suppliers module is the clearest example in the codebase of an architectural boundary enforced *structurally* rather than by convention, and it is worth understanding exactly how.

**The rule:** a supplier bill is money owed, not stock arriving. It is enforced in the file header (lines 6–11 of `suppliers.js`), in the `db.js` header (lines 17–19), in the `createSupplierInvoice` docstring (lines 512–521), and — most importantly — in the code itself.

**`createSupplierInvoice(inv)`** (lines 522–548) ends with `return put(STORES.supplierInvoices, record)`. It is a single-store write. There is no `products` store in scope, no `variant` field on the invoice items, and no `costPrice` — the items are free text (`{ name, qty, price }`), explicitly not SKUs. The comment at lines 514–516 states the point: "there is no product store in the list, which makes it structurally impossible for this to move stock." That is a boundary you cannot break by accident later, which is a much stronger guarantee than a convention.

**`createSupplierPayment(p)`** (lines 553–566) is the mirror image: a single write to `supplierPayments`, with `amount` forced positive via `Math.abs`, an optional `invoiceId` link reserved for a future statement view, and a free-text note.

**`supplierBalance(supplier, invoices, payments)`** (lines 577–588) is pure computation: filter both ledgers to this supplier, sum `billed` and `paid`, add `openingBalance`, return `{ opening, billed, paid, remaining }` rounded to 2 dp. Positive means we owe them; negative means they are in advance. `allSupplierBalances()` (lines 591–608) does the same for every supplier in one pass using two `Map`s — a deliberate avoidance of N filtered scans, commented as such.

**`openingBalance`** is the escape hatch that makes the no-inventory rule workable. A shop that already owed a supplier money before installing the app types that figure in when creating the supplier, and the whole ledger balances from there (line 499–500: "their opening credit line"). The owner then records restocks the ordinary way — through the product form or the stock sheet — which keeps cost prices and variants under the product model's control.

**The screen** (`suppliers.js`, 740 lines) is a well-structured two-route module: `render()` dispatches to `renderList()` or `renderDetail(id)` (lines 27–30). The list shows every supplier with `remaining`, sorted by heaviest debt first — the comment at line 124 says that is "the list the owner actually needs" — and shows the total owed across all suppliers in a summary card. The detail view shows balance, three mini-stats (billed / paid / opening), an actions row, then the two ledgers with view/edit/delete per row, then a destructive delete that cascades to the supplier's invoices and payments first (lines 384–398) with a confirmation message that explicitly reassures: "المخزن لن يتأثر إطلاقاً" (inventory will not be affected at all).

**The invoice editor** is a small line-item grid with live recalculation, and it repeats the boundary in the UI: line 531 renders the note "هذه الفاتورة لا تغيّر المخزن — الكميات والأسعار تعمل فقط هنا" (this invoice does not change the inventory — quantities and prices work only here). The boundary is stated where the owner is actually looking.

**Two real robustness details in this file**, both of which fix a class of bug the earlier code had:

- `paintToken` (line 79) guards against overlapping paints. The comment explains the failure it prevents: typing in the search box while a save finishes can start a second paint, and without a token the slower one appends its cards on top of the newer list, duplicating rows. Line 87 is a good line to keep in mind for the connectivity check too — see §15.
- The `isConnected` check placement (lines 81–95) is documented at length. Checking connectivity *above* the first `await` is always false, because the screen is built before the router mounts it, so the list never loaded at all and sat on its `…` badge forever. The check now sits after the await, alongside the token check. The comment states the general rule: every screen checks connectivity after awaiting, which is what discards a paint whose screen was swapped out mid-load.
- `openEditor.save()` wraps `saveSupplier` in try/catch and, on failure, reports via toast and **leaves the modal open** so nothing the user typed is lost (lines 712–725). The comment records that a rejected promise used to leave the modal open with no message, which read as "the save never happened".

**Settings-adjacent coupling worth noting:** `suppliers.js` imports `PAYMENT_METHODS` from `db.js` (line 20) for its payment-method labels, and `pos.js` defines its own separate `PAYMENTS` array (lines 28–32) with its own icon names. Two sources of truth for the same three payment methods. Cosmetic today, but it is the kind of duplication that produces a receipt labelled one way and a supplier payment labelled another.

---

## 12. UI / Screen Architecture

**The screen contract** is small and uniform: export `render(params)` returning a `.screen` div, and optionally export `destroy()`. Seven screens conform. The `products.js` / `supplier/:id` case is handled by dispatching inside `render()` rather than by adding routes, which keeps `ROUTES` at 8 entries.

**Every screen follows the same internal rhythm**, and the consistency is the main reason the app feels coherent:

1. build the shell synchronously — `pageHead` (or a hand-rolled equivalent), then content containers with ids
2. return the root immediately, having only *started* the async load
3. inside the async load, `await` the data, then check `isConnected`, then paint into the id'd hosts

`pageHead({ title, sub, actions, back, badge })` (`components.js:424`) and `sectionTitle(title, { iconName, count, action })` (line 413) are the shared headers, and `emptyState`, `skeletonGrid`, `loadingRow` and `mountList` are the shared states. `pos.js` hand-rolls its `page-head` rather than calling `pageHead` (lines 43–58) because it needs the live `#pos-count` badge in the title — a justified exception, but it means the head layout exists in two places.

**Async painting is the recurring hazard, and the codebase defends against it in three distinct ways:**

- **`isConnected` after the await** — the standard guard. `dashboard.js:101`, `product-form.js:49`, `pos.js:159`, `suppliers.js:230`, `product-form.js:64`.
- **`paintToken` counters** — for screens that can legitimately repaint themselves while a previous paint is still in flight. `suppliers.js:79` for the list, and `dashboard.js` builds its own `refresh` closure that re-checks `isConnected` before re-booting (lines 206–209, 304–307, 391–394). Three near-identical `refresh` closures in one file.
- **`cache` + `cacheReady` memoisation** in `pos.js` (lines 123–147). This one solves a different problem: `paintProducts()` is async, so a fast tap on a product card, or the `#/pos/<id>` pre-select path, can run before the first load has resolved. `ensureCache()` returns an in-flight promise rather than `undefined`, and `invalidateCache()` drops both the cache and the pending promise.

**The router's screen lifecycle** (see §1 for the sequence) is the other half. `destroy()` is optional per screen and only called on a path change. Three screens implement it:

- `dashboard.js:618` → `destroyCharts()`
- `pos.js:858` → drains `activeScreens`, unsubscribing the cart store
- `reports.js:542` → `destroyCharts()`

`products.js`, `product-form.js`, `settings.js` and `suppliers.js` export `default { render }` with no `destroy`, and correctly so: none of them hold a subscription, a timer or a chart. `product-form.js` and `settings.js` hold only DOM listeners, which die with their nodes.

**Overlays are a second, independent UI layer.** `openModal` and `openSheet` both build scrim + panel, both mount into `document.body` (not `#view`, so they survive navigation), both take a focus trap, both lock `body.overflow` through a shared `openCount`, and both register their `close` in an `overlayStack`. `closeTopOverlay()` (lines 77–82) pops that stack and is what the Android back button calls first — a genuinely thoughtful mapping of a hardware key onto "close the topmost thing", since a WebView has no Escape key. Overlay modules (`invoice-sheet.js`, `stock-sheet.js`) compose `openSheet`/`openModal` and receive an `onChanged` callback so the screen behind them can refresh — `dashboard.js` passes a `refresh` closure into both, and `stock-sheet.js` calls `opts.onChanged` after each successful write. That callback convention is the cleanest part of the overlay API.

**Two mechanisms are structurally important enough to name:**

- **The sticky cart bar lives in `document.body`, outside `#view`.** `#view` is cleared and rebuilt on every navigation, so anything inside it that must persist has to be re-mounted each time. `main.js:279–282` states this in a comment and mounts the bar *before* the first screen renders so it is never missing. The same reasoning applies to the toast host, the fly layer and the print root in `index.html` (lines 70–73) — all four are in `body`, all four survive navigation.
- **`toast()` never throws.** `components.js:15–21` auto-creates `#toasts` if it is absent, with a comment that gives the real reason: callers often have real work queued after a toast, and a throw would skip that work. Since `index.html:71` does ship a `#toasts` element, the guard is belt-and-braces — but it is the correct kind of belt-and-braces, because a notification must never be able to abort a sale.

**Animation** is done with the Web Animations API and no library: `countUp` (rAF, ease-out cubic, runs on KPI tiles), `ripple`, `flyTo` (clone the thumbnail, animate to the cart, resolve on `finished` with a `.catch` that still removes the node), `confetti`, `nudge`. `celebrate()` is the only one that touches the DOM globally — it appends a full-screen overlay to `body` and resolves after a timeout. It imports `confetti` **dynamically** with a `.catch(() => {})` (lines 346–350) and the comment is explicit: the burst is decorative, and a failure must never stop the promise from resolving, or whatever awaited it stalls forever. That is a correctness-of-the-happy-path decision made correctly.

**A note on `main.js`'s `onRoute` handler** (lines 301–311), which runs on every navigation: it calls `cartBar.syncRoute(path)`, then `getSettings()` and `refreshLowStockBadge()` — and `refreshLowStockBadge` itself calls `listProducts()` (lines 179–188). So every single navigation triggers a full product read plus a settings read, purely to keep a cosmetic badge in sync. On a large catalogue that is the most wasteful thing in the app.

---

## 13. Service Worker / Offline Architecture

**`sw.js` is 171 lines and follows a documented three-phase strategy** (header comment, lines 1–17): precache everything on install, cache-first for navigations with a network fallback, stale-while-revalidate for same-origin sub-resources, and drop older caches on activate.

**`VERSION = 'v7'`** (line 19), cache name `saher-v7`. The comment at lines 15–16 gives the maintenance rule: bump `VERSION` whenever any precached file changes, or clients keep the old copy.

**The precache list** (lines 23–82) contains 4 root files, 4 stylesheets, 18 modules, 2 vendor scripts, 15 font files, and 7 icon files. Every entry is fetched with `cache: 'reload'` and each is individually `.catch(() => null)`-tolerated (lines 89–95), so one missing file cannot fail the whole install.

**Install** ends with `self.skipWaiting()` (line 96), and **activate** deletes every cache whose name is not the current one and then calls `self.clients.claim()` (lines 100–107). So both mechanisms the project needs are already in place.

**`shellFirst(request)`** (lines 139–152) is used for navigations and is deliberately **cache-first**, not network-first. The comment at lines 130–138 explains the change: this app is offline by design, has no server to sync with and no deployment to discover, so the old network-first handler meant every launch stalled on a request that could only ever fail before falling back to the cache it already had. Cache-first makes startup instant and removes the network dependency entirely. If there is no cache entry it tries the network, caches a good response, and finally falls back to `index.html` so the SPA router can handle the route.

**`cacheFirst(request)`** (lines 110–128) is stale-while-revalidate for sub-resources: answer immediately from cache if present, kick off a fetch in the background, and refresh the cache only for `200` same-origin responses. If neither cache nor network produces anything, it returns `index.html` — the last-resort SPA fallback.

**The `fetch` handler is careful** (lines 154–166): non-GET requests are ignored, and same-origin is enforced with an explicit comment — the app ships every asset inside the package (fonts, chart library, the scanner), so a cross-origin request would be a bug, not a feature.

**A `message` listener** (lines 169–171) lets the page post `SKIP_WAITING` to activate an update immediately.

**Native builds opt out entirely.** `main.js:26–29` returns before registering anything when `isNative()`, with the reasoning that inside the Android shell every file is already in the APK, so a second cache layer is redundant and can only serve stale assets. The web build gets the full SW treatment: registration on `load`, an `updatefound` → `statechange` listener that toasts "يتوفر تحديث للتطبيق — أعد التشغيل لتطبيقه" when a new build finishes installing while the app is open, and a `controllerchange` listener that deliberately swallows the extra reload some browsers fire on first claim (lines 50–52).

**This is a sound design, and the precache list is where it has a real, verifiable defect.** The list was not updated when four modules were added: `js/cart-store.js`, `js/cart-bar.js`, `js/invoice-sheet.js` and `js/stock-sheet.js` are all imported by the app (`main.js` imports `cart-bar.js`; `dashboard.js` imports `invoice-sheet.js` and `stock-sheet.js`; `cart-bar.js` and `pos.js` import `cart-store.js`) and none of them appear in `PRECACHE`. This is analysed in §15.

**Everything else about offline is sound** because it follows from the data layer: IndexedDB is local, there is no API call anywhere in the app, fonts and icons are bundled, Chart.js and html5-qrcode are vendored locally, and print/share/save have web fallbacks. The app does not depend on the network for any feature.

---

## 14. Capacitor / Android Architecture

**Native bridge: `js/native.js`, 133 lines.** It is the single place that knows whether it is running inside a shell:

- `isNative()` — capability detection via `window.Capacitor`
- `printPage()` — NativePrint on Android, `window.print()` on the web
- `saveBlob(blob, filename)` — Filesystem + Share on Android, anchor-download on the web. `utils.downloadBlob()` (lines 355–374) routes through it when native, because the anchor `download` attribute is inert in a WebView, and the web branch is left completely untouched
- `shareText(title, text)` — native share sheet, returning the string `'unavailable'` on the web so callers can fall through. `pos.js:820–843` uses exactly that contract: try native, then `navigator.share`, then clipboard, then download a text file
- `onNativeBack(handler)` — Android hardware back, no-op on the web
- `minimizeApp()` — send to background, resolves immediately on the web

**Hardware back is mapped thoughtfully.** `main.js:199–222` maintains a session trail of visited paths, seeded with the current screen so the first press has somewhere to go. The handler closes the topmost overlay first, then walks the trail, and only minimizes once the trail has one entry — with the comment "already at the start of the session — don't kill the app outright". The overlay check is `closeTopOverlay()` from `components.js`, so the back button correctly dismisses a modal, a sheet or the cart panel before it does anything navigational. `router.js:199` sets `body.is-pos` for the POS-specific layout.

**Barcode scanning is the only three-layer fallback** (`js/scanner.js`, 253 lines): native ML Kit, then the vendored `html5-qrcode` loaded as a plain `<script>` in `index.html:76`, then manual entry. The header comment notes that a static `import('@capacitor-mlkit/barcode-scanning')` "can only ever fail to resolve" without the dependency installed, which is why the layer order and the manual fallback exist. `scanBarcode()` returns a code or null; `reportMissing(code)` handles an unmatched scan; `listenForScan(onCode)` supports a continuous listener. Consumed by `pos.js`, `products.js` and `product-form.js`.

**The APK is 29,545,161 bytes** (≈28.2 MiB) and sits in the project root. It bundles the full web app plus fonts, icons and both vendor scripts. No Capacitor config file is present in this directory, so the native project itself lives outside this folder.

**Platform-specific styling is minimal and contained** — the `body.is-pos` class, a `has-cartbar` class toggled by `cart-bar.js:155`, and the desktop sidebar, which `router.js:128–136` renders unconditionally and CSS shows from the tablet breakpoint up.

---

## 15. Architecture Problems

### Critical

**C1 — `sw.js` precache list is missing four live modules.**
`PRECACHE` (`sw.js:23–82`) lists 18 modules. It does not list `js/cart-store.js`, `js/cart-bar.js`, `js/invoice-sheet.js` or `js/stock-sheet.js`. All four are reachable from the entry point: `main.js:19` imports `cart-bar.js`, which imports `cart-store.js`; `dashboard.js:14–15` imports `invoice-sheet.js` and `stock-sheet.js`. In the Android build this is invisible, because `main.js:29` skips SW registration when native and the APK already contains the files. In the **web/PWA build it is a boot failure**: after a fresh install and then going offline, the browser fetches the shell from cache, `main.js` loads from cache, and its `import './cart-bar.js'` misses the cache, falls through `cacheFirst` to the network (which fails offline), and is answered with `./index.html` — an HTML document served to a module request, which fails on MIME type. The app does not start at all. The same failure hits `invoice-sheet.js` and `stock-sheet.js` as soon as the dashboard is reached, and `cart-store.js` breaks the POS screen. This is the highest-priority item in the audit and the cheapest to fix: add four strings. It is also exactly the failure mode the "bump the version" maintenance rule is meant to prevent, which suggests the version bump was done for `v7` without re-checking the list.

**C2 — Day boundaries mix local dates with UTC timestamps, so "today" can be wrong.**
`analytics.salesOn` (`analytics.js:33–36`) computes `isoDate(day)` — a **local** calendar date built from `getFullYear/getMonth/getDate` (`utils.js:175–179`) — and compares it against `s.timestamp.slice(0, 10)`, while `createSale` writes `timestamp: new Date().toISOString()` (`db.js:294`), which is a **UTC** string. In any timezone ahead of UTC these are different calendars for part of every day. In Asia/Jerusalem (UTC+2/+3), sales between local midnight and 02:00 or 03:00 are filed under the *previous* UTC day, so `salesOn` misses them for the day they happened. The visible effects: the dashboard's "مبيعات اليوم" and "فواتير اليوم" under-count in the early morning, the previous day over-counts, the day-to-day percentage change (`pctChange`, `dashboard.js:199`) is computed from two wrong numbers, and the day navigator's `renderDayInvoices` (`dashboard.js:301`) lists invoices under the wrong date. `salesBetween` (`analytics.js:24–31`) has the same class of problem in a milder form, comparing local `startOfDay`/`endOfDay` bounds against UTC timestamps, which shifts custom report ranges by up to the UTC offset. And `pos.js:725` uses a third convention — `new Date().toISOString().slice(0, 10)` — to count today's sales for the receipt sequence, so around local midnight the receipt counter can repeat a number already used that day or skip one. Three conventions for the same concept, in three files, with no shared helper. The correct fix is one helper used by all three sites (store and compare local dates, or compare everything in UTC consistently) — but deciding *which* convention is a product decision, so it is flagged rather than prescribed.

### High

**H1 — Hardcoded `ILS` in the POS discount control.**
`pos.js:617–630` renders the discount-type toggle as two buttons labelled `'ILS'` and `'%'`, and the value is written as a literal string. Every other amount on the screen uses `cache.settings.currency` — the prices, the line totals, the grand total, the payment buttons. `db.js:DEFAULT_SETTINGS` makes currency user-configurable, and `settings.js` exposes it, so a shop that changes its currency gets a control that still claims ILS while the number beside it is in the new currency. `cart-bar.js:43` also caches the currency, so the two surfaces can disagree independently.

**H2 — `renderToken` in the router is dead.**
`router.js:155` computes `const token = ++renderToken;` and the variable is never read again — a search of the file for `token` returns exactly that one line. The counter therefore provides no protection whatsoever, while *looking* like the in-flight guard the rest of the codebase uses (`paintToken` in `suppliers.js`). The practical effect is that the router has no cancellation mechanism of its own and relies entirely on each screen's post-await `isConnected` check. That reliance is currently sound — every screen does it correctly — but a screen author reading `render()` would reasonably believe a guard is in place when it is not.

**H3 — `charts.js` registry is global, so chart ownership is a cross-screen invariant.**
`registry` is a module-level `Map` keyed by canvas, and `destroyCharts()` empties it entirely. That works today only because the router destroys the outgoing screen (lines 181–187) before the incoming one paints, and because `dashboard.js boot()` calls `destroyCharts()` immediately before `drawTrend()` (lines 112–113) and `switchTrend` checks `isConnected` before redrawing. The invariant is real but implicit and unenforced: nothing ties a chart to the screen that created it, so any future code path that draws a chart after an await — a slow Chart.js load, for instance — can destroy or overwrite another screen's chart. The `loadChartJS()` await inside every chart function is exactly such a window.

**H4 — A DB read on every navigation for a cosmetic badge.**
`main.js:301–311` registers an `onRoute` handler that runs on **every** navigation. It calls `cartBar.syncRoute(path)` (correct and necessary), then `getSettings()`, then `refreshLowStockBadge()`, which itself calls `listProducts()` (lines 179–188) and runs `lowStockProducts` over the result. So navigating between two screens reads every product record. The comment shows the intent — keep the store name and the badge current — and the code even guards the badge with a comment saying it is "cosmetic — never block the UI on it", then makes it do the most expensive read in the app on the most frequent event.

**H5 — Unused imports in four screens.**
Verified by counting identifier occurrences; a count of 1 means the name appears only in its import statement:

| File | Imported but never used |
|---|---|
| `screens/dashboard.js` | `salesBetween`, `discountGiven`, `numInt`, `escapeHTML`, `wait`, `toast` |
| `screens/pos.js` | `uid`, `confirmDialog`, `lineCount` |
| `screens/product-form.js` | `readFileAsDataURL`, `wait`, `confetti`, `openModal`, `stockOf` |
| `screens/reports.js` | *(none — all imports used)* |

These are harmless at runtime and several are leftovers from features that moved to `invoice-sheet.js` and `stock-sheet.js`. `product-form.js` importing `confetti` while `celebrate()` now handles the burst internally is the clearest example of a migration that left its old imports behind. They add noise to the largest files and make a real import easy to miss.

### Medium

**M1 — Two sources of truth for payment methods.** `db.js:610` exports `PAYMENT_METHODS` as a `{ id: label }` map of four entries including `cheque`. `pos.js:28` defines a separate `PAYMENTS` array of three with icon names and no `cheque`. `suppliers.js:32` uses the `db.js` map; `pos.js` uses its own; `analytics.paymentBreakdown` groups by the stored id. A sale can therefore be recorded with a method that the supplier ledger has no label for, and the two screens label the same three methods from different tables. `receiptText` and the receipt modal both fall back with `|| 'نقداً'`, which hides the mismatch rather than surfacing it.

**M2 — Three duplicate `refresh` closures in `dashboard.js`.** Lines 206–209 (`renderStats`), 304–307 (`renderDayInvoices`) and 391–394 (`renderQuick`) each define an identical function that re-finds `#screen-dashboard`, checks `isConnected` and calls `boot(root)`. A fourth variant exists in `dashboard.js:613` inside `switchTrend`, which reuses `root` from closure. Four copies of the same re-entrancy guard, none of which reference a shared helper, and a change to the refresh strategy would need four edits.

**M3 — `isConnected` and paint-token ordering is a documented but unenforced convention.** `suppliers.js:81–95` carries an eight-line comment explaining that a connectivity check *above* the first await is always false because the screen is built before it is mounted, and that this bug made the list never load at all. The rule is correct and the fix is in place — but the rule lives in a comment in one file, and the failure mode it prevents is silent (a screen that simply never populates). A shared helper such as `paintInto(host, token, fn)` would make the correct order the easy one.

**M4 — `pageHead` is duplicated.** `components.js:424` is the shared header builder; `pos.js:43–58` hand-rolls an equivalent `div.page-head` because it needs the live count badge inside the title. The CSS class structure is duplicated, so a change to the header layout has to be made in two places.

**M5 — `pos.js` reaches `db.js` dynamically for no reason.** `pos.js:724` does `await import('../db.js').then(m => m.listSales())` inside `seqForToday()`, while `db.js` is already statically imported at line 16. The dynamic import adds an await point and a second module resolution for something already in scope. `listSales` is simply not in the static import list at lines 16–19, which is why the dynamic form was reached for.

**M6 — `saveSettings` is an unguarded read-modify-write.** `db.js:652` does `getSettings().then(cur => put(..., {...cur, ...patch}))`. The read and the write are separate transactions, so a concurrent `saveSettings` from another part of the app between them would lose one of the two patches. `product-form.js:269` and `354` call `saveSettings` to append a category or a size, so this is a live path. With a single user on a single device the window is small, but `product-form.js:354` in particular fires `saveSettings({sizes})` without awaiting it, so the form can continue before the write lands.

**M7 — Receipt numbers are derived from a count, not a sequence.** `pos.js:723–727` computes the next receipt number as "how many sales exist today" and hands it to `db.js` as `receiptSeq`. Any deletion, import or refund that removes a sale shifts subsequent numbers, and two rapid sales can in principle compute the same count. A stored monotonic counter in `settings` would be exact. The scale of the risk is low — this is a single-device shop — but it is the one number a customer may see on a printed receipt.

### Low

**L1 — `setTopbarContext` is exported and never used.** `router.js:260` exports it, and a search finds no caller. The topbar's context element is written directly by `main.js:107–109` instead. Dead export.

**L2 — `tx()` accepts an array but only opens the first store.** `db.js:127–133` takes `store`, then does `t.objectStore(Array.isArray(store) ? store[0] : store)`. The array branch is misleading in a codebase where `multiTx` is right below it and does the real multi-store work. No caller passes an array, so the branch is simply confusing.

**L3 — `components.js` imports `wait` and never uses it** (line 6), same category as H5.

**L4 — `utils.js init`… `initials()` and `iconEl()` are near-duplicates of patterns screens write inline.** `initials` is used by `suppliers.js`; `iconEl` has no callers that the grep found. Minor dead surface.

**L5 — `router.js NAV_ITEMS`** (line 61) is exported and has no consumer; the two arrays are used individually by `renderNav`.

**L6 — `db.js` exports several helpers that no screen uses:** `totalStock` (line 245), `inventoryValue` (line 246), `get` (line 181), `put` (line 185), `del` (line 189), `clearStore` (line 193), `count` (line 197), `deleteSale` (line 484). The generic CRUD layer is a reasonable API to keep; `deleteSale` is the one worth a second look, because it deletes a sale *without* restoring stock, and its existence next to `refundSale` is an easy mistake for whoever writes the next feature.

**L7 — `stock-sheet.js` self-mutates the products it was handed.** `commit()` (lines 198–199) writes `p.variants[i] = {...v, quantity: next}` and `v.quantity = next` on the caller's object after saving. This is deliberate — the comment explains that a second edit on the same row must add to the quantity that was actually stored — but it means the sheet mutates the dashboard's snapshot, which is the opposite of the clone-first discipline two lines above. It is correct today because the values match what was saved; it would be a bug if the save were ever partial.

---

## 16. Duplicate / Old / New Patterns

| # | Older pattern | Where it still lives | Newer pattern | Status |
|---|---|---|---|---|
| 1 | Cart owned privately by the POS screen | Superseded — the store is now separate | `js/cart-store.js` as a leaf module with `subscribe`/`emit` | **Clean.** No residue in `pos.js`: it imports the store, mutates through it, and emits. The old inline cart bar is gone from `pos.js` entirely. |
| 2 | Size/colour library built once, chips toggling their own class | Superseded by derivation from `d.sizes`/`d.colors` | `paintSizeLibrary()` / `paintColorLibrary()` re-derive on every paint | **Clean.** Both libraries are derived; the chip × and the library chip can no longer disagree. |
| 3 | Discount, payment and last-sale state in `pos.js` | Superseded | `cart-store.js` | **Clean.** |
| 4 | Invoice viewing/editing inside a screen | Superseded | `js/invoice-sheet.js` as a reusable overlay taking `onChanged`/`onRefund` | **Clean.** `dashboard.js` consumes it. No duplicate implementation remains. |
| 5 | Stock raising one variant at a time through the product form | Still the only *per-variant* path | `js/stock-sheet.js` for category-scoped bulk receiving | **Both live, deliberately.** The form is right for one product; the sheet is right for a delivery. Both write through `saveProduct`. |
| 6 | Day selector as a chart window only | Superseded | `viewDate` + `renderDayNav` + `setDay` with a future-date clamp (`dashboard.js:151–157`) | **Clean.** The clamp at line 154 prevents walking into a day that cannot have sales. |
| 7 | `refresh` guard closures | Copied four times in `dashboard.js` | none — no shared helper | **Duplication.** See M2. |
| 8 | Payment method definitions | Two independent definitions | none | **Duplication.** See M1. |
| 9 | `pageHead` | Shared builder in `components.js` | Hand-rolled copy in `pos.js` | **Duplication.** See M4. |
| 10 | Day-key derivation | Three conventions: `utils.isoDate` (local), `suppliers.isoDay` (local, private copy), `pos.js` `toISOString().slice(0,10)` (UTC) | none | **Duplication with a correctness cost.** See C2. `suppliers.isoDay` is a local reimplementation of `utils.isoDate` that exists because it was written independently. |
| 11 | Chart instances | Global `registry` in `charts.js` | none | **Single shared global.** Works today; see H3. |
| 12 | SW precache maintenance | Manual list + manual version bump | none | **Not maintained.** The list drifted from the import graph; see C1. |
| 13 | Old imports left after features moved out | `product-form.js` (`confetti`, `openModal`), `dashboard.js` (six names) | none | **Residue.** See H5. |

The pattern across all of these is consistent and worth naming: **whenever a concern has been extracted into its own module, the extraction was done properly** — the old code is gone from the old home, the new module is a proper leaf or a proper composable, and the caller is wired with a callback. The residual duplication is not in the extracted features but in the *plumbing*: refresh closures, header markup, payment labels, date helpers, and the manually maintained precache list.

---

## 17. Minimal Cleanup Recommendations

Scoped to what is genuinely necessary for delivery. No redesign, no new architecture, no feature work.

### Must fix before delivery

1. **Add the four missing modules to `sw.js` `PRECACHE` and bump `VERSION` to `v8`.** `js/cart-store.js`, `js/cart-bar.js`, `js/invoice-sheet.js`, `js/stock-sheet.js`. This is the PWA boot failure in C1, it is four lines, and it is the single highest-value change in this document. The bump is required in the same edit because otherwise existing clients keep the v7 cache and never see the new list. `skipWaiting()` and `clients.claim()` are already present (lines 96, 105) — no change needed there.
2. **Decide the day-boundary convention and apply it in all three places.** `analytics.salesOn`, `analytics.salesBetween`, `pos.js:seqForToday`, plus the duplicated `suppliers.isoDay`. One helper, one convention, applied everywhere. This is a correctness issue in the numbers the owner is shown, not a stylistic one. It does require a decision (local-day grouping vs. UTC grouping) and a re-verification of the seeded demo data under that decision.
3. **Fix the hardcoded `ILS` in the POS discount toggle** (`pos.js:621`) to read `cache.settings.currency`. One string, and it is wrong in a user-configurable field.
4. **Verify the web build boots offline from a clean cache on a real device.** Item 1 fixes a defect that the Android build structurally cannot exhibit, so the only way to confirm the fix is to install the PWA, go offline, cold-start, and complete a sale. This belongs in the delivery checklist, not in a code change.

### Should fix

5. **Remove `renderToken` from `router.js`, or make it work** (H2). Deleting the dead line is the safer option; implementing the guard would change router behaviour and deserves its own testing. As it stands the variable implies a protection that does not exist.
6. **Drop the unused imports** (H5) — 12 names across `dashboard.js`, `pos.js` and `product-form.js`. Mechanical, zero behavioural risk, and it shrinks the import surface of the three largest files.
7. **Stop reading all products on every navigation** (H4). Refresh the low-stock badge on an explicit trigger — a sale, a stock edit, a settings change — instead of on every `onRoute`. The `onRoute` handler should keep only `cartBar.syncRoute(path)` and the store-name check.
8. **Collapse the four `refresh` closures in `dashboard.js` into one shared helper** (M2), and take `PREFILL_KEY` out of `product-form.js` so `products.js` no longer imports a screen module (the one sideways import in the graph).
9. **Verify `charts.js` ownership holds under a slow Chart.js load** (H3), or bind the registry to the owning screen. A quick test — navigate away from Reports while its charts are still resolving — is enough to confirm or disprove it.
10. **Re-verify the three transaction paths after any change to C2's fix.** `createSale`, `updateSale` and `refundSale` are the parts of this codebase that must not break. If the day-key fix touches `timestamp` handling at all, re-run the stock-delta cases.

### Can wait

11. Reconcile the two payment-method tables (M1) — decide whether `cheque` is supported, then have one source.
12. Replace the hand-rolled `pageHead` in `pos.js` with a variant of the shared one that accepts a badge (M4).
13. Make `saveSettings` a single transaction, and await the two fire-and-forget calls in `product-form.js` (M6).
14. Move receipt numbering to a stored counter (M7).
15. Remove the dead exports: `setTopbarContext`, `NAV_ITEMS`, the array branch in `tx()`, `iconEl`, and the unused `db.js` helpers — with a decision on `deleteSale`, which is the only one with a real footgun (L1, L2, L4–L6).
16. Rewrite the `stock-sheet.js commit()` self-mutation into a pure update (L7).
17. Consider a memoisation or incremental strategy for sales aggregation **only if** the sales history grows large enough to make per-render full reads noticeable. The current no-pre-aggregation choice is correct for backup-restore fidelity and should not be changed speculatively.

---

## 18. Final Architecture Decision

**Can this project ship with a limited, targeted cleanup, or does it need a large restructuring?**

### **Limited, targeted cleanup. No large restructuring is needed.**

The architecture is sound for what this application is: a single-device, offline-first, single-owner shop tool. The decisions that matter have all been made deliberately, and in several cases the code documents *why* the decision is the right one — which is the strongest signal that they will not need revisiting.

**Structurally sound, and worth protecting explicitly:**

- **`db.js` is the only module that touches IndexedDB.** Screens reach storage exclusively through exported domain functions. This boundary has never been crossed and is what makes the rest of the system safe to change.
- **Inventory is owned by exactly two paths.** `createSale` down, `updateSale`/`refundSale` by delta, all inside one `multiTx` with a read-once/write-once pattern whose failure mode is explained in the code. The supplier ledger is kept out of inventory *structurally* — the product store is not in scope inside `createSupplierInvoice` — so it cannot be violated by accident. This is the strongest part of the system and the thing most worth not disturbing.
- **The cart has one source of truth and two views.** `cart-store.js` imports nothing, exists specifically so the bar can live outside the router's `#view` without creating a cycle, and both views derive from it. The two-way mirror is explicit and documented, and the POS subscription deliberately repaints the column rather than calling `paintCart` to avoid the loop.
- **Extraction has been done properly every time.** `cart-store.js`, `cart-bar.js`, `invoice-sheet.js`, `stock-sheet.js`, `analytics.js`, `charts.js` are all real modules with real responsibilities and no leftover implementations in their old homes. The residual duplication is in plumbing, not in the extracted features.
- **The async-painting hazard is understood.** Every screen checks `isConnected` after the await; the one place that got it wrong is documented at length in the file where it was fixed. This is the kind of institutional knowledge that usually lives only in someone's head.
- **No server, no sync, no accounts, no cloud.** The offline story is inherited from the data layer rather than maintained separately, so it cannot drift. Charts, fonts, icons and the scanner are all vendored. Print, share and file-save all have web fallbacks.

**The problems that exist are mostly in maintenance, not in design** — and the four that matter are narrow:

- The service-worker precache list drifted from the import graph when four modules were added. That is a four-line fix, and it is a **web-build boot failure** that the Android build structurally cannot reveal, which is exactly why it went unnoticed.
- Day boundaries mix local dates with UTC timestamps in three places. This produces wrong numbers in the dashboard and reports around local midnight, and it is a correctness bug in what the owner is shown, not a design flaw.
- A handful of hardcoded or dead values: `ILS` in the discount control, `renderToken` that guards nothing, twelve unused imports, four copies of one refresh closure, two payment-method tables.
- Every navigation reads the full product catalogue to refresh a cosmetic badge.

None of these require a new architecture, a state-management library, a bundler, a routing rewrite, or a data-model change. All of them are edits inside files that already exist. And each of the three stock-movement transactions — the part that must not break — is untouched by all of them.

**What this audit is explicitly not recommending:** no rewrite, no framework migration, no store library, no router replacement, no pre-aggregation layer, no module reorganisation, no database migration, no UI redesign. The instinct to reach for a "cleaner" architecture here would be a mistake: the current structure is a good fit for the actual requirements, and the handful of real defects are all small, local, and independently verifiable.

**Recommended order:** the four Must Fix items, then a real-device offline cold-start test of the web build, then the Should Fix list as time allows. The Can Wait list is genuinely optional and can be deferred to the next feature cycle.

---

*Audit performed by reading the source. No code, database, schema or `PROJECT_SPEC.md` was modified in producing this document.*
