# CRITICAL_BUGS_AUDIT

**Target:** `C:\Users\Lenovo\Desktop\مشروع ساهر` (official source of truth)
**Scope:** functional bug audit only — **no code was modified, no APK was rebuilt**
**Date:** 2026-09-30
**Build audited:** the delivered debug APK (`ساهر-نسخة-التسليم.apk`, `sw.js` `VERSION = 'v8'`, 22 JS modules)

Every finding below carries one of three labels:

| Label | Meaning |
|---|---|
| **CONFIRMED by code** | the defect is provable by reading the source, or was reproduced by executing the real modules |
| **SUSPECTED** | the code shows a credible defect but a real device is needed to see the symptom |
| **NOT REPRODUCIBLE from code** | I looked and the code does not explain the symptom |

---

## 1. Confirmed Bugs

| # | Bug | Label | Severity |
|---|---|---|---|
| **B1** | `supplier/<id>` route has no capture group → `params` is empty → supplier detail/balance screen is **dead code** and can never open | CONFIRMED by code (executed) | **Critical** |
| **B2** | `التقارير` (Reports) has **no entry in the phone bottom navigation** — it exists only in the desktop sidebar, which is `display:none` below 900px | CONFIRMED by code | **High** |
| **B3** | Dashboard quick action `رفع المخزون` opens the stock sheet **with no products**, so it always shows "لا توجد منتجات بعد" | CONFIRMED by code | **High** |
| **B4** | The Products/Inventory screen **never re-reads stock after a sale** — its module-level cache is only invalidated by the product form, never by the POS | CONFIRMED by code | **High** |
| **B5** | Dashboard `viewDate` is module-level and **never reset on navigation**; once the owner walks back a day, a newly completed sale is shown under the wrong day | CONFIRMED by code | **High** |
| **B6** | `moneyHTML()` output is passed to `text:` in 3 places → the currency markup is rendered as **literal text** | CONFIRMED by code | Medium |
| **B7** | `main.js` hands the route **object** to `cartBar.syncRoute()` which expects a **string** | CONFIRMED by code | Low |
| **B8** | `renderToken` in `router.js` is dead — incremented, never read | CONFIRMED by code | Low (dead code) |
| **B9** | The Reports screen contains **no invoice/sale list at all** — it is a KPI + chart screen only | CONFIRMED by code | Design gap |

### What the three reported symptoms actually map to

1. **"Completing a sale decreases inventory, but the sale/invoice is not appearing correctly in Reports / invoice history"**
   → the *data* is fine (proved in §2). What is broken is **(B2)** there is no persistent way to reach Reports on a phone, **(B9)** Reports has no invoice list to look in, and **(B5)** the dashboard can be sitting on the wrong day. Separately, **(B4)** means the inventory screen shows stale stock, which is why the sale's stock effect looks inconsistent.

2. **"In Suppliers, pressing a supplier to view its balance/status does not respond"**
   → **(B1)**, exactly and completely. The tap fires, the URL changes, the list simply re-renders.

3. **"Some buttons/actions are not visible or do not respond"**
   → **(B2)** (no Reports tab), **(B3)** (a quick action that opens an empty sheet), plus the audit items already logged as **H1** in `ARCHITECTURE_AUDIT.md`.

---

## 2. Sale → Invoice Trace

**Result: the write path and the read path are both correct. There is no data-layer bug here.**

I ran the **real** `js/db.js` and `js/analytics.js` in Node against an in-memory IndexedDB stand-in, executing the exact object that `pos.js completeSale()` builds.

```
=========== 1. what createSale stored ===========
  id        = 6f9953f5-3c04-4aae-bb09-4385cedca701
  receiptNo = 20260930-0001
  total     = 200
  timestamp = 2026-09-30T17:10:08.520Z   (local now = Wed Sep 30 2026 20:10:08 GMT+0300)
  dayKeyOf  = 2026-09-30
  isoDate(now) = 2026-09-30

  PASS  listSales() returns 1 record
  PASS  salesBetween(from=startOfDay(-6d), to=endOfDay(now)) includes it
  PASS  salesOn(sales, today) includes it
  PASS  the sale day has a matching chart bucket
  PASS  stock went 5 -> 3  (same transaction)
  PASS  sale.id / receiptNo / timestamp / total / items / paymentMethod / costTotal all present
```

Step by step:

| Step | Location | Finding |
|---|---|---|
| Checkout button | `js/screens/pos.js:653-659` → `onClick: completeSale` | OK |
| `completeSale()` | `js/screens/pos.js:667-716` | OK — awaits `seqForToday()` then `createSale()` |
| Receipt sequence | `js/screens/pos.js` `seqForToday()` → `dayKeyOf` | OK — counts sales whose `dayKeyOf(timestamp)` equals today |
| Write | `js/db.js:269` `createSale()` | OK — one `multiTx` over `sales` + `products`; the sale put and every stock decrement commit or abort together |
| Record shape | `js/db.js:281-300` | OK — `id`, `receiptNo`, `subtotal`, `discount`, `discountType`, `discountValue`, `total`, `paymentMethod`, `costTotal`, `items[]`, `timestamp` (UTC ISO), `note` |
| Receipt number | `js/db.js:751` `nextReceiptNo()` | OK — `dayKeyOf(new Date())` + per-day counter |
| Read back | `js/db.js:259` `listSales()` = `getAll(sales)` | OK |
| Reports range | `js/analytics.js:24-31` `salesBetween()` | OK — numeric `getTime()` compare, no string slicing |
| Reports buckets | `js/screens/reports.js:156-165` `dailyBuckets()` | OK — `dayKeyOf(s.timestamp)` vs `isoDate(d)`, same local convention |
| Invoice history | `js/analytics.js:35` `salesOn()` via `js/screens/dashboard.js:301` | OK — same local day key |
| Invoice sheet | `js/invoice-sheet.js:36` `openInvoiceSheet()` | OK — honours `opts.onChanged` (L272) and `opts.onRefund` (L253) |

**Verdict for the sale flow: NOT REPRODUCIBLE from code.** No sale record is lost, mis-dated, mis-ranged, or mis-summed. The "not appearing" experience is a **navigation and state** problem, not a data problem — see **B2**, **B5**, **B9**.

One genuine presentation defect exists on this path — **(B6)**, `js/invoice-sheet.js:120`: the discount line in the invoice editor is built with `text:` and a template literal containing `moneyHTML(...)`, so the user sees the raw markup instead of a formatted amount.

---

## 3. Supplier → Balance Trace

**Result: the tap works, the navigation works, the parameter is thrown away. CONFIRMED.**

```
supplier/2f1c9a80-1111-4222-8333-444455556666  =>  route order 5 | params = []  | renderList()   <-- detail NEVER opens
supplier/1750000000000-a3f2c1                   =>  route order 5 | params = []  | renderList()   <-- detail NEVER opens
product/2f1c9a80-1111-4222-8333-444455556666    =>  route order 2 | params = ["2f1c9a80-…"] | edit form
pos/2f1c9a80-1111-4222-8333-444455556666        =>  route order 3 | params = ["2f1c9a80-…"] | preselect
```

(That is `router.js`'s own `match()` executed verbatim against real UUID-shaped ids.)

The chain:

1. `js/screens/suppliers.js:157` — the card's `onClick` is `navigate(\`supplier/${s.id}\`)`. **The handler is correct and does fire.**
2. `js/router.js:32` — the route is declared `match: /^supplier\/[\w-]+$/`. **It has no capturing group.**
3. `js/router.js:97` — `if (m) return { route: r, params: m.slice(1) }`. With no group, `m.slice(1)` is `[]`.
4. `js/router.js:168` — `next = route.screen.render(params)` passes `[]`.
5. `js/screens/suppliers.js:28` — `const id = params[0] && … : null` → `id = null`.
6. `js/screens/suppliers.js:29` — `return id ? renderDetail(id) : renderList();` → **`renderList()`**.

Compare with the two sibling routes, which are written correctly:

| Route | Declaration | Group? |
|---|---|---|
| product detail | `js/router.js:30` `/^product\/(new\|[\w-]+)$/` | yes — `(new\|[\w-]+)` |
| POS pre-select | `js/router.js:29` `/^pos(?:\/([\w-]+))?$/` | yes — `([\w-]+)` |
| **supplier detail** | **`js/router.js:32` `/^supplier\/[\w-]+$/`** | **NO** |

The user-visible effect: tapping a supplier changes the address bar to `#/supplier/<uuid>`, re-renders the same list, and appears to do nothing. From `render(params)` onward the id is gone.

**Blast radius:** `renderDetail()` at `js/screens/suppliers.js:206-460` — roughly 250 lines covering the balance header, the invoice ledger, the payment ledger, add-invoice, add-payment, and delete actions — **has never executed once**. `supplierBalance()`, `listSupplierInvoices()`, `listSupplierPayments()` are imported at `js/screens/suppliers.js:16-21` and used only inside that dead function.

What the owner *can* still see: the list-level total owed (`js/screens/suppliers.js:115`) and each supplier's remaining balance row (`js/screens/suppliers.js:175`). So balances are visible **in aggregate and as a per-row figure**, but the per-supplier ledger/status page is unreachable.

---

## 4. Missing / Non-responsive UI

### 4.1 Reports is invisible on phones — **B2**
- `js/router.js` `BOTTOM_NAV` = `dashboard, products, pos, suppliers, settings` — **no `reports`**.
- `js/router.js` `SIDE_NAV` = `products, pos, reports, settings`.
- `renderNav()` builds `BOTTOM_NAV` into `.bottomnav` and `SIDE_NAV` into `.sidebar`.
- `css/base.css:340` → `.sidebar { display: none; }` (the mobile default)
- `css/base.css:639` → `@media (min-width: 900px)` re-enables the sidebar, and `css/base.css:719` hides `.bottomnav` at the same breakpoint.

So on **any phone**, the only "التقارير" label the user can ever see is the one on the POS header button (`js/screens/pos.js:55`, "السجل") and one dashboard quick action. There is no tab, no drawer, no overflow menu.

### 4.2 A quick action that always reports "no products" — **B3**
```js
// js/screens/dashboard.js:397
{ label: 'رفع المخزون', icon: 'package', to: null, cls: 'quick--emerald',
  onClick: () => openStockSheet({ onChanged: refresh }) }     // <-- no `products`
```
`js/stock-sheet.js:40` — `const products = opts.products || [];`
`js/stock-sheet.js:55-59` — `if (!groups.length)` → renders *"لا توجد منتجات بعد. أضف منتجاً أولاً لتتمكن من رفع مخزونه."*

Both sibling call sites do it correctly (`js/screens/dashboard.js:250` and `:259` both pass `products`). The quick action is permanently broken **and actively misinforms** the owner into thinking the shop is empty.

### 4.3 Inventory screen does not reflect a completed sale — **B4**
- `js/screens/products.js:169` — `let cache = { products: [], settings: null };` (module scope)
- `js/screens/products.js:176` — `if (!cache.settings) { …load once… }` — the load is guarded by a **permanent** flag
- `js/screens/products.js:598` — `export function invalidate()` exists
- Its **only** callers are `js/screens/product-form.js:710` and `:723` (product save / delete)
- `js/screens/pos.js:715` calls its own private `invalidateCache()` (`js/screens/pos.js:144`), which clears the **POS** cache, not the products one

Net effect: complete a sale → the POS list updates (it re-reads) → walk to المخزن and the stock numbers are the ones from before the sale, indefinitely. This is the direct cause of the reported "inventory and sales don't agree" impression.

### 4.4 Dashboard can be stuck on a past day — **B5**
- `js/screens/dashboard.js:25` — `let viewDate = new Date();` (module scope)
- `js/screens/dashboard.js:151-154` — `setDay()` walks it; the only reset is `if (viewDate.getTime() > Date.now()) viewDate = new Date();`
- `render()` never resets it

Press "السابق" once, go sell something, come back: the header reads "فواتير أمس", and the sale you just made is genuinely not in the list — it is filed under today. The "العودة لليوم" button (`js/screens/dashboard.js:141`) is the only escape.

### 4.5 Handlers pointing at the wrong thing / wrong shape — **B7**
- `js/router.js:225` fires `fn(currentRoute, old)`, where `currentRoute = { path, route, params, order }` (`js/router.js:217`)
- `js/main.js:301-303` — `onRoute((path) => { cartBar.syncRoute(path); … })` passes the **object**
- `js/cart-bar.js:223` — `currentPath = path || currentPath;` stores the object
- `js/cart-bar.js:230` — `if (currentPath !== 'pos') setOpen(false);` — an object is never `=== 'pos'`, so **the condition is always true** and the bar always folds, including while on the POS screen

Cosmetic (the bar folds), but the comparison is meaningless and any future route-aware logic in that module will be silently wrong.

### 4.6 Dead state — **B8**
`js/router.js:67` `let renderToken = 0;` and `js/router.js:155` `const token = ++renderToken;` — `token` is never compared against anything. Harmless, but it means there is **no** stale-render guard in the router.

### 4.7 `text:` vs `html:` — **B6**
`el()`'s `text:` writes `textContent`, so HTML passed to it is displayed verbatim. Three real call sites:

| File:line | What the user sees |
|---|---|
| `js/invoice-sheet.js:120` | `خصم 50<span class="cur">₪</span>` instead of a formatted discount |
| `js/screens/dashboard.js:236` | the day-invoices sheet footer total |
| `js/screens/dashboard.js:516` | the price on each low-stock row |

The identical expression is used correctly with `html:` in ~30 other places (e.g. `js/screens/dashboard.js:358`, `js/screens/pos.js:778`, `js/invoice-sheet.js:125-127`), so this is a slip, not a convention.

### 4.8 Also carried over from `ARCHITECTURE_AUDIT.md` (not re-audited here, still open)
- **H1** — `ILS` hardcoded in the POS discount toggle, ignoring the Settings currency.

---

## 5. Root Cause of Each Bug

| # | Root cause |
|---|---|
| **B1** | A missing capturing group in `js/router.js:32`. The route was written to *match* a supplier id but never to *capture* it, so the screen receives an empty `params` array and falls back to the list. The supplier detail feature was never reachable. |
| **B2** | `reports` was added to `SIDE_NAV` only. The phone chrome renders `BOTTOM_NAV`; the sidebar that renders `SIDE_NAV` is `display:none` under 900px. A desktop-only nav edit shipped into a phone app. |
| **B3** | `openStockSheet`'s `products` argument is optional (`opts.products || []`), so omitting it is silent. One of three call sites omitted it. No caller-side assertion, no empty-arg distinction between "no products" and "no argument". |
| **B4** | `products.js` uses a module-level cache guarded by a flag that is only ever cleared by the product form. A sale mutates `products` through `db.createSale`, which knows nothing about the screen cache. The invalidation contract is incomplete. |
| **B5** | `viewDate` is screen state stored at module scope, so it outlives the screen instance the router destroys on every navigation. The router's `#view` is replaced wholesale, but the module variable is not. |
| **B6** | `moneyHTML()` returns an HTML string. Three call sites pass it to `el(..., { text })`, which uses `textContent`. |
| **B7** | `onRoute` delivers a route object; `main.js` names the parameter `path` and forwards it to a function whose contract is a string. Nothing validates the shape. |
| **B8** | Leftover from a cancelled stale-render guard. The increment survived, the comparison did not. |
| **B9** | The Reports screen was scoped to aggregates (KPIs, 3 charts, best-sellers, category ranking) and never given a transaction list. The only invoice history in the app lives on the Dashboard, under a 8-row preview plus a sheet. |

---

## 6. Exact Files / Functions

**Bug 1 — supplier detail unreachable (Critical)**
- `js/router.js:32` — ROUTES entry `order: 5`
- `js/router.js:97` — `match()` → `params: m.slice(1)`
- `js/router.js:168` — `route.screen.render(params)`
- `js/screens/suppliers.js:28` — `const id = params[0] && …`
- `js/screens/suppliers.js:29` — `return id ? renderDetail(id) : renderList();`
- `js/screens/suppliers.js:157-158` — the card `onClick` / `onkeydown` (these are correct; not the fault)
- `js/screens/suppliers.js:206-460` — `renderDetail()`, unreachable

**Bug 2 — Reports missing from the phone nav (High)**
- `js/router.js` — `BOTTOM_NAV`, `SIDE_NAV`, `NAV_ITEMS`, `renderNav()`
- `css/base.css:340` — `.sidebar { display: none; }`
- `css/base.css:639` — `@media (min-width: 900px)` (sidebar restored)
- `css/base.css:719` — `.bottomnav { display: none; }` inside the same breakpoint

**Bug 3 — empty stock sheet (High)**
- `js/screens/dashboard.js:397` — `openStockSheet({ onChanged: refresh })`
- `js/stock-sheet.js:39-40` — `openStockSheet(opts)`, `opts.products || []`
- `js/stock-sheet.js:52-60` — `paint()` empty branch
- (correct for comparison: `js/screens/dashboard.js:250`, `:259`)

**Bug 4 — stale inventory screen (High)**
- `js/screens/products.js:169` — module `cache`
- `js/screens/products.js:176` — `if (!cache.settings)` one-shot load
- `js/screens/products.js:598` — `invalidate()` (under-called)
- `js/screens/product-form.js:710`, `:723` — the only callers
- `js/screens/pos.js:144` — `invalidateCache()` (private, POS-only)
- `js/screens/pos.js:715` — its call site
- `js/db.js:269` `createSale()` — the writer that invalidates nothing

**Bug 5 — dashboard stuck on a past day (High)**
- `js/screens/dashboard.js:25` — `let viewDate = new Date();`
- `js/screens/dashboard.js:151-154` — `setDay()`
- `js/screens/dashboard.js:141` — the "العودة لليوم" escape hatch
- `js/screens/dashboard.js:301` — `renderDayInvoices()` reading `viewDate`

**Bug 6 — HTML rendered as text (Medium)**
- `js/invoice-sheet.js:120`
- `js/screens/dashboard.js:236`
- `js/screens/dashboard.js:516`
- contract: `js/utils.js` `el()` — `text` → `textContent`, `html` → `innerHTML`

**Bug 7 — route object passed as a path (Low)**
- `js/router.js:217`, `js/router.js:225` — `onRoute` payload
- `js/main.js:301-303` — `onRoute((path) => cartBar.syncRoute(path))`
- `js/cart-bar.js:222-223`, `:230` — `syncRoute()` / `currentPath`

**Bug 8 — dead state (Low)**
- `js/router.js:67`, `js/router.js:155`

---

## 7. Severity

| Sev | Bugs | Why |
|---|---|---|
| **Critical** | B1 | A headline feature — per-supplier balance and status — is 100% unreachable. No error, no crash, no feedback. The owner cannot diagnose it and will conclude the app is broken. |
| **High** | B2, B3, B4, B5 | Each produces a **silently wrong or empty screen** where correct data exists one tap away. B4 in particular makes inventory and sales disagree, which is the exact contradiction the owner reported. |
| **Medium** | B6 | Cosmetic but visible on money figures. No data loss. |
| **Low** | B7, B8 | Cosmetic / dead code. No user-visible data error today. |
| **Gap** | B9 | Not a defect; a missing capability. Worth confirming with the owner before treating it as a bug. |

---

## 8. Minimal Fix Required

Descriptions only — nothing was implemented.

| # | Minimum change |
|---|---|
| **B1** | One character-level edit: `js/router.js:32` → `/^supplier\/([\w-]+)$/`. The capture group alone restores `renderDetail()`. Nothing in `suppliers.js` needs to change — it already reads `params[0]` correctly. **Afterwards `renderDetail()` executes for the first time; it has never been run, so it must be exercised end-to-end (balance header, invoice list, payment list, add invoice, add payment, delete) before shipping.** |
| **B2** | Add `{ id: 'reports', label: 'التقارير', icon: 'chart', href: '#/reports' }` to `BOTTOM_NAV`, or raise `.sidebar` to a phone-visible drawer. The first is the smaller change; note it makes the bar 6 items. |
| **B3** | `js/screens/dashboard.js:397` → pass `products`, matching lines 250 and 259. Separately, make `openStockSheet` distinguish `opts.products === undefined` (caller error) from `[]` (genuinely empty shop) so a future omission is not silent again. |
| **B4** | Call `products.invalidate()` after a sale completes — `js/screens/pos.js:715` next to the existing `invalidateCache()` — or drop the module cache and read on every navigation. The first is the one-line option. |
| **B5** | Reset `viewDate` in `js/screens/dashboard.js` `render()`, e.g. `viewDate = new Date();`, or hold the day in the route/URL so it is naturally scoped to the screen instance. |
| **B6** | Change `text:` → `html:` at `js/invoice-sheet.js:120`, `js/screens/dashboard.js:236`, `js/screens/dashboard.js:516`. |
| **B7** | `js/main.js:301` → `onRoute((r) => cartBar.syncRoute(r.path))`. |
| **B8** | Delete `js/router.js:67` and `:155`, or finish the stale-render guard. |
| **B9** | Confirm intent with the owner. If an invoice list belongs in Reports, it is a new screen section, not a fix. |

---

## 9. Verification Needed After Fix

**B1 — must be done on a real device, no exceptions.** `renderDetail()` is untested code. Verify: tap a supplier → header shows that supplier's name and remaining balance → invoice ledger lists past bills → payment ledger lists past payments → add an invoice → balance and stock do **not** change (purchases must never touch inventory) → add a payment → balance drops by the right amount → delete both → balance returns → hardware back returns to the list.

**B2** — on a 360–430px-wide viewport, confirm a persistent "التقارير" target exists and opens `#/reports`; re-check at ≥900px that the sidebar still shows it and the bottom bar is hidden; confirm the active-item highlight is correct on both.

**B3** — open `رفع المخزون` from the dashboard quick action with a populated shop: categories must appear, a category must expand, "إضافة" and "تعيين" must both commit, and the dashboard must refresh afterwards. Then confirm the message only appears when the shop is genuinely empty.

**B4** — with a known stock (e.g. 5), sell 2 from POS, then navigate to المخزن without touching the product form. The card must read 3. Repeat after a refund and after an edit from the invoice sheet.

**B5** — open the dashboard, press "السابق", leave to POS, complete a sale, return. The invoice must be listed under **today**. Also verify the "العودة لليوم" button still works and that a genuinely-past-day view is still reachable on purpose.

**B6** — open the invoice editor on a discounted invoice; the discount line must show a formatted amount, not markup. Check the day-invoices sheet footer and the low-stock rows.

**B7** — with a non-empty cart, switch to another tab and back to POS; the bar should not fold while on POS. Confirm the bar peeks correctly elsewhere.

**Regression gates before any rebuild**
1. `node --check` on all 22 JS modules + `sw.js` (copy to `.mjs` first — the package is `"type": "commonjs"`).
2. Re-walk the import graph and confirm `sw.js PRECACHE` still covers every module (bump `VERSION`).
3. Re-run the sale-flow harness in §2 — it must stay 7/7.
4. Re-run the route table check in §3 and confirm `supplier/<uuid>` now yields `params = ["<uuid>"]`.
5. Re-sync to `C:\Users\Lenovo\saher-apk` and rebuild with `JAVA_HOME=C:\Users\Lenovo\.jdks\jbr-21.0.11`, `ANDROID_HOME=C:\Users\Lenovo\AppData\Local\Android\Sdk`, using the local Capacitor CLI binary rather than `npx`.

**Out of scope but worth stating:** `PROJECT_SPEC.md` does not exist anywhere in the project, so there is no written source of truth to check these behaviours against — only the code and the owner's report. This project is not under version control, so none of the above has a commit to revert to.
