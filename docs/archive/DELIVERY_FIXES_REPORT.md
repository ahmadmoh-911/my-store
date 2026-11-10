# DELIVERY_FIXES_REPORT.md

## Summary
**Date:** 2026-09-30
**Scope:** targeted delivery stabilization (only the two verified issues from the architecture audit). No refactors, no UI redesign, no features, no database schema changes, no `PROJECT_SPEC.md` edits, no Stitch/UI work.

`PROJECT_SPEC.md` was not present in the project root (only `ARCHITECTURE_AUDIT.md` was found). All changes were based on the audit's verified findings.

## Files modified

| File | Type | Changes |
|---|---|---|
| [`sw.js`](sw.js) | Fix #1 | Added 4 missing precache modules; bumped cache version. |
| [`js/utils.js`](js/utils.js) | Fix #2 | Added `dayKeyOf()` helper to centralize local-day mapping from stored timestamps; hardened against `null`/`undefined`/`''` inputs. |
| [`js/analytics.js`](js/analytics.js) | Fix #2 | Imported `dayKeyOf()`; `salesOn()` now maps timestamps to the local calendar day via `dayKeyOf`; `dailySeries()` and `hourlySeries()` bucket by local day via `dayKeyOf()` (replacing `s.timestamp.slice(0,10)`). |
| [`js/db.js`](js/db.js) | Fix #2 | `nextReceiptNo()` now derives the receipt-number date half from `dayKeyOf(new Date())` instead of a UTC `toISOString()` slice. Added the single import of `dayKeyOf`. |
| [`js/screens/pos.js`](js/screens/pos.js) | Fix #2 | Imported `dayKeyOf()`; `seqForToday()` now computes "today" in **local** time and compares timestamps with `dayKeyOf()` (replaced UTC slice). |
| [`js/screens/reports.js`](js/screens/reports.js) | Fix #2 | Imported `dayKeyOf()`; `dailyBuckets()` now groups sales by local day via `dayKeyOf()` (replaced UTC slice). |
| [`js/screens/suppliers.js`](js/screens/suppliers.js) | Fix #2 | Imported `isoDate()` from `utils.js`; replaced all calls to the private `isoDay()` with `isoDate()`; removed the private `isoDay()` helper entirely (no duplicate date logic remains). |

---

## 1. Service Worker precache (verified fix)

**What changed:**
- `const VERSION = 'v7'` → `'v8'`
- Added the following entries to `PRECACHE` (in the JS assets block):
  - `./js/cart-store.js`
  - `./js/cart-bar.js`
  - `./js/invoice-sheet.js`
  - `./js/stock-sheet.js`

**Verification (automated):**
- `sw.js` contains `const VERSION = 'v8'`
- All 4 modules are present in `PRECACHE` and exist on disk
- Strategy preserved: `shellFirst` for navigations, `cacheFirst` for sub-resources (stale-while-revalidate with background refresh)
- Lifecycle preserved: `skipWaiting()` and `clients.claim()` present; old caches deleted on activate
- Fetch policy preserved: non-GET requests ignored; same-origin check remains
- No dead entries were introduced
- The 4 modules are reachable from the app (verified via import graph analysis)

**Result:** The web PWA can now precache all live modules required at boot (including `cart-bar.js` imported by `main.js` and the sheet modules imported by `dashboard.js`). This addresses the boot failure that would occur offline after a clean install under the previous precache list.

---

## 2. Date boundary consistency (verified fix)

### Centralized helper
`dayKeyOf(timestamp)` was added to [`js/utils.js`](js/utils.js). It:
- Accepts `Date | string | number` and returns a local `yyyy-mm-dd` key using `isoDate()`
- Guards against `null`/`undefined`/`''` by returning `''` (matching the previous defensive pattern `(timestamp || '')`)
- Treats invalid dates by returning `''` rather than throwing
- Is the single point of truth for mapping a stored timestamp (UTC `toISOString()`) back to its **local** calendar day

### Call sites changed
- **[`analytics.js#salesOn`](js/analytics.js)** — filter by `dayKeyOf(s.timestamp) === isoDate(day)`
- **[`analytics.js#dailySeries`](js/analytics.js)** — bucket by `dayKeyOf(s.timestamp)`
- **[`analytics.js#hourlySeries`](js/analytics.js)** — day filter by `dayKeyOf(s.timestamp)`
- **[`reports.js#dailyBuckets`](js/screens/reports.js)** — group by `dayKeyOf(s.timestamp)`
- **[`pos.js#seqForToday`](js/screens/pos.js)** — use `dayKeyOf(new Date())` as "today" and compare with `dayKeyOf(s.timestamp)` (was `toISOString().slice(0,10)`)
- **[`db.js#nextReceiptNo`](js/db.js)** — receipt-number date half from `dayKeyOf(new Date())` (was `toISOString().slice(0,10)`)

### Scope was larger than the audit reported
The audit named three date sites (`analytics.salesOn`, `pos.seqForToday`, the duplicate `suppliers.isoDay`). Verification found **six** UTC day-slicing sites plus the duplicate — seven changes across seven files:

| Site | Was |
|---|---|
| `analytics.salesOn` | `s.timestamp.slice(0,10)` |
| `analytics.dailySeries` | `s.timestamp.slice(0,10)` |
| `analytics.hourlySeries` | `s.timestamp.slice(0,10)` |
| `reports.dailyBuckets` | `s.timestamp.slice(0,10)` |
| `pos.seqForToday` | `new Date().toISOString().slice(0,10)` |
| `db.nextReceiptNo` | `new Date().toISOString().slice(0,10)` |
| `suppliers.isoDay` | private duplicate (not UTC, but redundant) |

`dailySeries`, `hourlySeries` and `dailyBuckets` were **not** in the audit. They feed the dashboard trend chart, the today-by-hour figure and the reports bar chart respectively, so leaving them on UTC would have kept the visible bug alive on exactly the screens the user reads numbers from.

**Receipt numbering specifically:** `db.nextReceiptNo` built the number as `YYYYMMDD-NNNN` from the **UTC** day, while `pos.seqForToday` supplies the counter half. Fixing only the counter would have left the two halves of the same receipt disagreeing — the first sale after local midnight would count as day 1 of the new local day but carry the *previous* day's date prefix. Both halves now use `dayKeyOf`. Notably [`seed.js`](js/seed.js) already used local-day `isoDate(when)`, so `db.js` was the only path out of step.

`db.js` had zero imports (a leaf in the module graph). It now has exactly one, `dayKeyOf` from `utils.js`. This introduces **no cycle**: `utils.js` reaches only `icons.js` and `native.js`, neither of which imports `db.js`, and `native.js` keeps all `window`/`Capacitor` access inside a lazy function. This was verified programmatically.

### Removed duplicate
- **[`suppliers.js`](js/screens/suppliers.js)** — deleted the private `isoDay()` helper and replaced 3 call sites with the shared `isoDate()` from `utils.js`. No duplicate date implementation remains.

### Why this fixes the reported issue
Sales are stored with `timestamp: new Date().toISOString()` (UTC). The old code compared local keys against `timestamp.slice(0,10)` (a UTC substring), so in any timezone ahead of UTC, sales between local midnight and the offset were mis-filed under the previous day. The new code derives the local calendar day from the absolute instant (`dayKeyOf` uses `new Date(timestamp)` and `isoDate` uses local getters), so "today", "yesterday", daily buckets, hourly filtering, and receipt numbering all share the **same local-day convention**.

---

## Verification performed

1. **Static verification**
   - No remaining `slice(0,10)` or `isoDay()` anywhere in `js/` source (grep: 0 matches across all 20 modules)
   - `dayKeyOf()` imported and used at all 6 UTC-slice call sites
   - `sw.js` VERSION = `v8`, precache contains the 4 modules and all discovered reachable assets

2. **Boundary logic tests (time-zone sweep)**
   - Tested with Node across **9 timezones**: Asia/Jerusalem (+3), Asia/Tokyo (+9), Asia/Dubai (+4), Europe/Berlin (+2), America/New_York (−4), America/Los_Angeles (−7), UTC (+0), Pacific/Kiritimati (+14), Pacific/Midway (−11)
   - Total assertions: **350 passed, 0 failed**
   - The tests import the real `utils.js` and `analytics.js` and exercise the shipped code, not a copy
   - Cases covered: local-midnight boundary (00:30 sale), evening (20:00), previous-day late (23:00), `salesOn()` totals per local day, empty adjacent days, `dailySeries()` window bucketing, `hourlySeries()` per-local-hour aggregation (including that a 00:30 sale lands in hour 0 and yesterday's 23:00 sale is excluded), "today" alignment, invalid/missing timestamp handling
   - Each run also asserts the **old** UTC-slice logic to confirm the bug was real at that offset (and coincidentally correct only at UTC+0)
   - Receipt numbering asserted: `nextReceiptNo` no longer slices `toISOString()`, builds its day from `dayKeyOf`, keeps the `YYYYMMDD-NNNN` format, and agrees with `seed.js`'s existing local-day numbering

3. **Precache verification (automated)**
   - Import graph walked from `index.html` + `js/main.js` (static and dynamic imports)
   - All reachable modules are precached; the 4 required modules are present and exist on disk
   - Caching strategy, lifecycle (skipWaiting/clients.claim), and fetch policy remain unchanged
   - One benign validator note (extra precached files not reached from the index.html graph) — no functional impact

4. **Key sanity checks**
   - `seqForToday()` now uses `dayKeyOf(new Date())` and compares against `dayKeyOf(s.timestamp)` (local-day consistent)
   - `nextReceiptNo()` now uses `dayKeyOf(new Date())` for the receipt date half (local-day consistent with the counter)
   - `salesBetween()` remains unchanged and continues to compare epoch instants against local `startOfDay`/`endOfDay` bounds (already correct — instants are timezone-absolute)
   - No duplicate date implementation in `suppliers.js`; all three call sites (`invoice` date, `payment` date, initial values) use `isoDate()`
   - `db.js → utils.js` creates no import cycle (verified: `utils.js` deps are `icons.js`, `native.js` only)
   - `DB_NAME` / `DB_VERSION` unchanged (`saher_db` / 3); no schema migration
   - `node --check` passes on every `.js` file in the project including `sw.js`

---

## Any remaining risks

**None identified for the stated fixes.** The changes are minimal and behaviour-preserving except for the specific timezone boundary cases the audit called out.

**Notes (not risks, informational):**
- The precache still contains a small superset of files not directly reachable from the current `index.html` graph (harmless; the SW caches what's listed, and runtime code only fetches what it imports).
- `dayKeyOf()` treats `timestamp === null` as invalid and returns `''` — this aligns with the codebase's existing null-guarding pattern and does not affect real sale records (which are created with ISO timestamps).
- The stored timestamp format remains **UTC ISO strings** (`toISOString()`); no DB migration was performed and `DB_VERSION` was not changed. Reading is what was corrected, so existing records are grouped correctly without being rewritten.
- `db.js` now has one import (`utils.js`) instead of none. No cycle was introduced and no DOM/database behaviour changed. Flagged explicitly because the audit called the zero-import leaf a structural strength — it is worth a second opinion if you prefer `db.js` kept strictly standalone, in which case the alternative is threading a day key in from `pos.js` instead.
- **Not verifiable here (needs a real device):** the PWA offline cold-start. The precache list is now complete per the import graph, but confirming it requires installing the web build, going offline, cold-starting, and completing a sale. This remains on the delivery checklist.

---

**Fixes complete and verified.**