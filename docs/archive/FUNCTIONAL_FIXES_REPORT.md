# تقرير إصلاح الأخطاء الوظيفية — Functional Fixes Report

**المشروع:** مشروع ساهر (Saher) — تطبيق إدارة متجر ملابس
**المصدر الرسمي:** `C:\Users\Lenovo\Desktop\مشروع ساهر`
**التاريخ:** 30 سبتمبر 2026
**النطاق:** إصلاح الأخطاء الوظيفية التسعة المؤكدة (B1–B9) في مصدر الويب فقط

---

## 1. ملخص تنفيذي (Executive Summary)

تم إصلاح **تسعة أخطاء وظيفية** مؤكدة، **دون تغيير في البنية**، و**بلا إضافة أو حذف أي وحدة نمطية**، و**لا تغيير في مخطط قاعدة البيانات** (`DB_VERSION` بقي `3`).

| # | الخطأ | الملف الأساسي | الحالة |
|---|-------|----------------|-------|
| B1 | صفحة تفاصيل المورد لا تُفتح أبداً | `js/router.js` | ✅ مُصلح ومُتحقَّق |
| B2 | التقارير غير متاحة على الجوال | `js/router.js` | ✅ مُصلح ومُتحقَّق |
| B3 | «رفع المخزون» لا يفتح / يفتح فارغاً | `js/screens/dashboard.js` + **`js/stock-sheet.js`** | ✅ مُصلح ومُتحقَّق |
| B4 | المخزون لا يتحدث بعد البيع | `js/screens/pos.js` | ✅ مُصلح ومُتحقَّق |
| B5 | لوحة التحكم تبقى على يوم قديم | `js/screens/dashboard.js` | ✅ مُصلح ومُتحقَّق |
| B6 | مبالغ مالية تظهر كـ HTML خام | 4 مواقع في 3 ملفات | ✅ مُصلح ومُتحقَّق |
| B7 | شريط السلة يتعامل مع المسار خطأً | `js/main.js` | ✅ مُصلح ومُتحقَّق |
| B8 | `renderToken` كود ميت | `js/router.js` | ✅ مُصلح |
| B9 | لا يوجد سجل فواتير في التقارير | `js/screens/reports.js` | ✅ مُصلح ومُتحقَّق |

**اكتشافان إضافيان أثناء التحقق** (خارج النطاق المعلن مسبقاً، لكنهما من نفس الأعراض المُبلَّغ عنها):
- **B3b:** `stock-sheet.js` كان يقرأ `sheet.body` وهي **غير مُرجَعة** من `openSheet` — سبب ثانٍ مستقل يمنع فتح الورقة.
- **B6-4:** موقع رابع لمشكلة `moneyHTML` عبر `text:` في `dashboard.js` (لم تلتقطه الأداة الأولى).

**لم يُبنَ APK. لم يُمسّ `saher-apk`. لم يبدأ عمل المصادقة/الوحة الإدارية.**

---

## 2. الأخطاء المُصلَحة (Bugs Fixed)

### B1 — صفحة تفاصيل المورد لا تُفتح أبداً

**السبب الجذري:** نمط المسار `supplier` كان `/^supplier\/[\w-]+$/` — بلا **مجموعة التقاط**. الـ router يمرّر للشاشات `m.slice(1)`، فكانت `params` تصل فارغة، فكان `suppliers.js:28` يسقط دائماً إلى عرض القائمة. نتيجةً لذلك، **~250 سطراً في `renderDetail()` لم تُنفَّذ قط** في عمر التطبيق.

**الإصلاح** — `js/router.js:34`:
```js
// The id MUST be captured: the router hands screens `m.slice(1)`, so without
// the group `params` arrives empty and suppliers.js falls back to the list.
{ order: 5, match: /^supplier\/([\w-]+)$/, nav: 'suppliers', screen: suppliersScreen },
```
تعديل حرف واحد. لماذا كان خطيراً: النقطة الأولى تُوقظ 250 سطراً لم يُكتب لها اختبار.

**التحقق:** شغّلت `renderDetail()` الحقيقية فعلياً (انظر §4) — تعرض الاسم ورقم الهاتف والرصيد (700 مفوتر − 250 مدفوع = **450**) وبنود الفاتورة والدفعة، دون Exceptions.

---

### B2 — التقارير غير متاحة على الجوال

**السبب الجذري:** `reports` كانت في `SIDE_NAV` فقط. و`css/base.css:340` فيه `.sidebar { display: none }`، بينما `css/base.css:639` `@media (min-width: 900px)` هي وحدها التي تُعيد إظهاره. أي أن **على الجهاز المستهدف (جوال) لم يكن هناك أي رابط للتقارير إطلاقاً**.

**الإصلاح** — `js/router.js`، إضافة `reports` إلى `BOTTOM_NAV` (5 ← 6 عناصر):
```js
{ id: 'reports', label: 'التقارير', icon: 'chart', href: '#/reports' },
```
الاختيار: الشريط السفلي صف `flex` بعناصر `flex: 1 1 0`، فيستوعب العنصر السادس دون أي تعديل تخطيط. لم أُحاول تحويل الشريط الجانبي إلى درج للجوال — تغيير أكبر وأخطر.

**حماية مرافقة** — `css/base.css`، قاعدة واحدة بعد `.bottomnav .nav-item svg`:
```css
/* Six destinations now share the bar, so a long Arabic label must not wrap to a
   second line and push past the fixed bar height — clip it instead. */
.bottomnav .nav-item > span {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```
لازمة: الشريط ارتفاعه ثابت، فعنصر إضافي كان سي 허용 التفاف «الموردون»/«الإعدادات»سطراً ثانياً.

**ملاحظة تصميمية:** عند 360px، يحجز زر «بيع جديد» ‏68px، فتتساوى العناصر الخمسة الباقية على ‏~58px لكل منها بخط ‏10.5px. التسمية العربية تتّسع. إن ظهر قصّ غير مقبول على جهاز صغير فيُعدَّل `font-size` أو `flex-basis` — وهو تعديل CSS محلي، لا هندسة جديدة.

---

### B3 — «رفع المخزون» لا يفتح / يفتح فارغاً

كان هذا **سببين مستقلين**؛ إصلاح واحد فقط كان سيترك العطل قائماً.

**B3a — `products` لم تكن تُمرَّر** (`js/screens/dashboard.js`)

**السبب الجذري:** `renderQuick(root)` لم يستقبل `products`، فكان `openStockSheet({ onChanged: refresh })` بلا `products`، و`stock-sheet.js:40` يفعل `opts.products || []` ← قائمة فارغة ← فرع «لا توجد منتجات» دائماً. أما نداءا السطرين 250 و259 فكانا يمرّران `products` بشكل صحيح.

**الإصلاح** — تمرير `products` من `boot()` (حيث هو في النطاق أصلاً) حتى `renderQuick` ثم إلى الورقة:
```js
renderQuick(root, products);              // in boot()
function renderQuick(root, products) {    // signature
{ label: 'رفع المخزون', icon: 'package', to: null, cls: 'quick--emerald',
  onClick: () => openStockSheet({ products, onChanged: refresh }) },
```

**B3b — `openSheet` لا يُرجع `body` أصلاً** (`js/stock-sheet.js`) ⚠️ **اكتشاف أثناء التحقق**

**السبب الجذري:** `stock-sheet.js` كان يفعل:
```js
const sheet = openSheet({ title: 'رفع المخزون' });
const body = sheet.body;          // ← undefined
```
لكن `openSheet` في `components.js:219` يُرجع `{ close, root: sheet }` — **بدون `body`**. أما `openModal` (سطر 167) فيُرجع `{ close, root, panel, body: bodyWrap }`. فكان `body` هو `undefined`، و`clear(undefined)` في `utils.js:68` يرمي `TypeError` **قبل** أن يُرسَم أي شيء. أي أن B3a وحده كان سيترك العطل قائماً.

**الإصلاح** — بناء الـ body هنا وتمريره، كما تفعل الشاشات الأربع الأخرى تماماً (`invoice-sheet.js:48`، `pos.js`، `products.js`، `dashboard.js`):
```js
// Build the body here and hand it to openSheet, the way every other overlay
// does (invoice-sheet, pos, products, dashboard). Reading `sheet.body` back
// out cannot work: openSheet returns { close, root } and — unlike openModal —
// it does not expose the body element, so that read was `undefined` and
// clear(undefined) threw on the first paint.
const body = el('div.stk');
const sheet = openSheet({ title: 'رفع المخزون', body });
```
اخترت توحيد `stock-sheet.js` مع الأنماط القائمة بدل تعديل عقد `openSheet` المشترك — تغيير ملف واحد، بلا لمس المساعد المشترك الذي تعتمد عليه مسار مُتحقَّق منه (B9).

**ملاحظة معمارية:** فجوة العقد بين `openModal` و`openSheet` فخّ مؤجَّل. من يُنشئ ورقة-sheet جديدة سيواجه نفس الخطأ دون سابق إنذار. الإصلاح الأقوى طويل الأمد هو جعل `openSheet` يُرجع `body` أيضاً، لكن ذلك يغيّر عقداً مشتركاً فتجاوزتُ النطاق.

---

### B4 — المخزون لا يتحدث بعد البيع

**السبب الجذري:** `js/screens/products.js` يحمل ذاكرة مؤقتة على مستوى الوحدة (`cache`). `createSale()` في `db.js` يغيّر الكميات داخل معاملة واحدة، لكن لا أحد يُبطل ذاكرة المنتجات. النتيجة: بعد البيع، التنقل إلى «المخزن» يعرض كميات ما قبل البيع.

**الإصلاح** — `js/screens/pos.js:715`، بجوار `invalidateCache()` القائم:
```js
// createSale() just rewrote quantities in IndexedDB, so the Inventory screen's
// module-level cache is stale too — otherwise walking to المخزن after a sale
// shows pre-sale stock. Same dynamic import the product form already uses,
// so no static import (and no import cycle) is introduced.
import('./products.js').then((m) => m.invalidate()).catch(() => {});
```
استخدمتُ `invalidate()` الموجودة أصلاً بدل تكرار حالة المنتجات. الاستيراد **ديناميكي** عمداً — استيراد ساكن من `pos.js` إلى `products.js` سيضيف دورة استيراد جديدة.

**لا يوجد ازدواج في حالة المنتجات** — الإصلاح يستدعي الآلية القائمة.

---

### B5 — لوحة التحكم تبقى على يوم قديم

**السبب الجذري:** `let viewDate = new Date()` (نطاق الوحدة) كُان يُعاد ضبطه مرة واحدة عند تحميل الصفحة. التنقل بين الأيام داخل الشاشة يعمل بشكل صحيح، لكن مغادرة الشاشة والعودة لا تُعيد الضبط. النتيجة: بيعٌ جديد بعد التنقل إلى الأمس يُسجَّل تحت **التاريخ الخاطئ** في كل أرقام اللوحة.

**الإصلاح** — `js/screens/dashboard.js`، داخل `render()`:
```js
export function render() {
  // `render()` is the router's entry point — it runs only when the Dashboard is
  // newly navigated to, not on the in-screen repaints. `viewDate` lives at
  // module scope, so without this the day the owner walked to (setDay) survived
  // leaving the screen and a sale made afterwards landed under the wrong date.
  // In-screen day navigation goes through setDay() → boot(), which is untouched.
  viewDate = new Date();
```

**لماذا `render()` تحديداً — وهذه هي النقطة الحرجة:**
- `render()` = نقطة دخول الـ router ← **يُستدعى عند كل تنقّل جديد** فقط.
- `boot()` = مسار التحديث داخل الشاشة ← يستدعيه `setDay()` (تنقّل الأيام) ومعاملات `refresh` (تعديل فاتورة، استرداد، تغيير مخزون).

إعادة الضبط في `render()` تُبقي **تنقّل الأيام مقصوداً**، وتُبقي اليوم المختار أثناء التحديث بعد تحرير فاتورة أو رفع مخزون. الضبط في `boot()` كان سيدمّر تنقّل الأيام.

**مُتحقَّق:** التنقل يمرّ (اليوم ← أمس ← قبل أمس)، زر «العودة لليوم» يعمل، و`render()` جديد يُعيد الضبط لليوم ويُظهر فواتير اليوم.

---

### B6 — مبالغ مالية تظهر كـ HTML خام

**السبب الجذري:** `moneyHTML()` (في `utils.js:144`) يُرجع سلسلة تحتوي على ترميز:
```js
return `${num(n)}<span class="cur">${escapeHTML(currency)}</span>`;
```
عند تمريرها إلى `text:` في `el()`، يُعيَّن النصّ عبر `textContent`، فيرى المستخدم الحروف `<span class="cur">ILS</span>` مكتوبةً حرفياً.

**أصلحتُ أربعة مواقع** (الأصلية الثلاثة المطلوبة + رابع):

| # | الملف | السطر (قبل) | الشفرة |
|---|-------|--------------|--------|
| 1 | `js/invoice-sheet.js` | 120 | `el('span', { text: \`خصم ${... moneyHTML(...)}\` })` |
| 2 | `js/screens/dashboard.js` | 236 | `el('span', { text: \`إجمالي ${moneyHTML(revDay, cur)}\` })` |
| 3 | `js/screens/dashboard.js` | 517 | `el('div.lowstock-item__meta', { text: \`${product.category} · ${moneyHTML(product.price, cur)}\` })` |
| 4 | `js/screens/dashboard.js` | 295 | `el('span', { ..., text: c.extra })` حيث `c.extra` مبنيّ بـ `moneyHTML` في السطر 245 |

**الموقع الرابع — لماذا أُصلح رغم أنه خارج الثلاثة المذكورة:** هو **نفس العيب المؤكَّد**، على **نفس الشاشة**، ويظهر للمستخدم مباشرة. تركُه يعني شحن خطأ مرئي في بُنية Money Rendering. الأداة الأولى لم تلتقطه لأن `c.extra` يُبنى في سطر ويُستهلَك في سطر آخر.

#### معالجة إدخال المستخدم في الموقع الثالث
الموقع الثالث يُدرج `product.name` و`product.category` — **بيانات مستخدم**. التحقق من الأمان:
```js
// `html`, not `text`: moneyHTML returns a currency chip. The product
// name/category are user input, so they are escaped before embedding.
el('div.lowstock-item__meta', { html: `${escapeHTML(product.category)} · ${moneyHTML(product.price, cur)}` }),
```
`escapeHTML` مستوردة أصلاً في الملف. أما الموقع 295 (`c.extra`) فقيمه الأربع كلها مُولَّدة من التطبيق (أعداد ومبالغ) ولا تحوي إدخال مستخدم.

**لم أغيّر `moneyHTML()` نفسها** — كما هو مطلوب.

---

### B7 — شريط السلة يتعامل مع المسار خطأً

**السبب الجذري:** `router.onRoute` يمرّر كائن المسار `{ path, route, params, order }`. لكن `main.js` كان يمرّره مباشرةً إلى `cartBar.syncRoute(path)`، و`cart-bar.js:230` يقارن `currentPath !== 'pos'`. كائن ≠ سلسلة، فكانت المقارنة **دائماً** صحيحة، فكان الشريط **يُطوى دائماً** — حتى وأنت على شاشة البيع نفسها حيث يجب أن يبقى.

**الإصلاح** — `js/main.js:301`:
```js
onRoute((current) => {
  // `current` is the router's route object ({ path, route, params, order }),
  // not a path string — syncRoute compares against 'pos', so pass the path.
  const path = current?.path || '';
  // fold the cart bar away when leaving POS, and re-check its numbers
  cartBar.syncRoute(path);
```
لم أُعدّل `cart-bar.js` — المستدعي هو الذي كان مُخطئاً، و`?.` يقينا من قيمة `undefined` أيضاً. المُستمع الثاني في `main.js` (‏`trail` زر الرجوع) يستخدم `getPath()` ولم يُمَس.

**الدليل المُتحقَّق منه:** حاكيتُ السلوكين على كائن المسار الحقيقي — السلوك القديم يُطوي الشريط حتى على `pos`؛ السلوك الجديد يبقى مفتوحاً على `pos` ويطوى خارجه.

---

### B8 — `renderToken` كود ميت

**السبب الجذري:** `let renderToken = 0;` و`const token = ++renderToken;` داخل `render()`. المتغيّر **لا يُقرأ أبداً في أي مكان** — كان يبدو كحماية من التحديثات المتقاطعة لكن بلا تنفيذ. أُزيل لأنه في مسار العرض نفسه الذي عملتُ عليه (B1/B2 في نفس الملف).

```js
// before
async function render() {
  const token = ++renderToken;
  const path = getPath();
// after
async function render() {
  const path = getPath();
```
ومن نطاق الوحدة:
```js
let currentRoute = null;      // { path, route, params, order }
let lastOrder = 0;            // ← السطر r'enderToken' المحذوف
```
**لا تنظيف غير ذي صلة.** تحققتُ أن `renderToken` غير مذكور في `js/main.js` ولا `js/cart-bar.js`.

---

### B9 — لا يوجد سجل فواتير في التقارير

**السبب الجذري:** لا مكان في التطبيق يعرض كل الفواتير عبر نطاق زمني. لوحة التحكم تعرض يوماً واحداً فقط، ونطاق التقارير يعرض تجميعات بلا مستوى الفاتورة.

**الإصلاح** — `js/screens/reports.js`، بطاقة «سجل الفواتير» داخل جسم التقرير:
- تعيد استخدام `sales` **المُصفّاة أصلاً** بالنطاق المختار — لا استعلام جديد.
- تفتح **نفس** `openInvoiceSheet()` من `invoice-sheet.js` — تعديل/استرداد يمرّان عبر `db.updateSale` / `db.refundSale` كما كان تماماً.
- **لا شاشة فواتير منفصلة. لا نموذج قاعدة بيانات جديد. لا `DB_VERSION` جديد.**
- ترقيم صفحات بسيط (25 فاتورة لكل ضغطة) مع زر «عرض المزيد» يختفي عند الانتهاء.

```js
import { openInvoiceSheet } from '../invoice-sheet.js';
```
```js
function invoiceRow(sale, cur, refresh) {
  const items = sale.items || [];
  return el(
    'button.inv-row',
    { type: 'button', onClick: () => openInvoiceSheet(sale, { onChanged: refresh, onRefund: refresh }) },
    el('span.inv-row__no', { text: sale.receiptNo || '—' }),
    el('span.inv-row__meta', {},
      el('span', { text: `${items.length} صنف` }),
      el('span.tiny.muted', { text: `${fmtDate(new Date(sale.timestamp), true)} · ${fmtTime(new Date(sale.timestamp))}` })),
    el('span.inv-row__sum', { html: moneyHTML(sale.total, cur) })
  );
}
```
الصنف `inv-row` **موجود مسبقاً** في ورقة الأنماط (نفسه الذي تستخدمه اللوحة) — فلم أحتج CSS.

**لماذا آمنة للتعديل/الاسترداد:** `onChanged` و`onRefund` يستدعيان `repaint()` الذي يعيد استدعاء `paint()`، فتُعاد قراءة الأرقام المصحَّحة.

---

## 3. الملفات المُعدَّلة (Files Modified)

**سبعة ملفات. لا شيء آخر.**

| الملف | التغيير | الأخطاء |
|-------|---------|---------|
| `js/router.js` | إضافة مجموعة التقاط للمسار؛ `reports` في `BOTTOM_NAV`؛ حذف `renderToken` | B1, B2, B8 |
| `js/main.js` | تمرير `current.path` إلى `syncRoute` | B7 |
| `js/screens/dashboard.js` | تمرير `products`؛ ضبط `viewDate`؛ موقعا `html:` + موقع `c.extra` | B3a, B5, B6×3 |
| `js/screens/pos.js` | `products.invalidate()` بعد البيع | B4 |
| `js/screens/reports.js` | سجل الفواتير + `html:` في بطاقة KPI | B9, B6 |
| `js/invoice-sheet.js` | `text:` ← `html:` في سطر الخصم | B6 |
| `js/stock-sheet.js` | بناء الـ body وتمريره بدل قراءة `sheet.body` | B3b |
| `css/base.css` | قصّ تسمية الشريط السفلي عند 6 عناصر | B2 |

**لم يتغيّر:** `js/db.js` (`DB_VERSION` = `3`، `DB_NAME` = `saher_db`)، `sw.js` (`VERSION` = `v8`)، `index.html`، أي مخطط، أي تبعية. `PROJECT_SPEC.md` **غير موجود** في المشروع — الكود وتقرير المالك هما المصدران الوحيدان للحقيقة.

---

## 4. التحقق المُنفَّذ (Verification Performed)

بُنيت **11 أداة اختبار** تعمل على **وحدات المشروع الحقيقية** (مع IndexedDB في الذاكرة و DOM وهمي). لا يوجد أي نسخ مُعاد كتابتها من منطق التطبيق.

### فحص ثابت وشامل

| الأداة | النتيجة |
|--------|---------|
| `syntax-check` | **27/27** وحدة تُحلَّل بنجاح (بما فيها `sw.js`، `vendor/`) |
| `import-check` | **338** استيراد مُسمّى — لا وحدة مفقودة، لا اسم غير مُصدَّر |
| `cycle-check` | 95 حافة استيراد؛ **7 دورات** (انظر §5) |
| `b6-scan` | مسح المشروع بالكامل: **لا عيوب** — كل `moneyHTML()` يمرّ عبر `html:` |
| `icon-check` | **51** اسم أيقونة مستخدَم — جميعها موجودة في `icons.js` |
| `verify-fixes` | فحوص ثابتة لكل B1–B9 — **جميعها ناجحة** |

### تنفيذ فعلي للكود (الأقوى)

**`verify-b1-detail` — شغّلت `renderDetail()` الحقيقية لأول مرة**
استوردت `js/screens/suppliers.js` الحقيقي (بترتيب استيراد التطبيق: `router.js` أولاً)، بذرتُ مورداً بفاتورتين ودفعة، ثم نُفِّذ `render([id])`:
- ✅ يعمل دون Exceptions
- ✅ يعرض الاسم ورقم الهاتف
- ✅ **الرصيد 450 صحيح** (700 مفوتر − 250 مدفوع)
- ✅ بنود الفاتورتين ونص الدفعة
- ✅ 14 زراً معالجاً، وزر رجوع `.back-btn` موسوم
- ✅ **انحدار:** `render([])` ما زال يعرض القائمة، ولا يسرّب دفتر المورد

**`verify-b9-render` — نُفِّذ `invoiceRow` وكتلة السجل الحرفية من `reports.js`**
- ✅ 61 فاتورة: 25 ← 50 ← 61؛ الزر يحدّث العدّاد ثم يختفي
- ✅ 25 بالضبط (حدّ) بلا زر؛ 26 (بوابة) بزر؛ 3 بلا ترقيم
- ✅ المجموع يُعرض كـ HTML لا كنصّ مُهرَّب
- ✅ فاتورة بلا `receiptNo` وبلا `items[]` لا ترمي

**`verify-symptoms` — الأعراض المُبلَّغ عنها فعلياً**
- ✅ **B4:** منتج بمخزون 5، بيع 2 ← شاشة المخزن تعرض **3** (لا 5)
- ✅ **B4:** بيع ثانٍ ← **2**، وأثبتُّ أن الذاكرة المؤقتة عالقة فعلاً **قبل** `invalidate()` (لئلا يكون الاختبار صورياً)
- ✅ **B3:** ورقة «رفع المخزون» تُفتح، تُجمِّع حسب الفئة، **وليس** فرع «لا توجد منتجات»؛ توسيع الفئة يكشف صفوف المنتجات؛ `aria-expanded` يتقلّب
- ✅ **B3b:** بلا منتجات ← رسالة الفراغ تظهر سليمة
- ✅ **B6:** بطاقة KPI في التقارير تحوي `<span class="cur">` كترميز حقيقي، ولا ترميز مُهرَّب مرئي
- ✅ **B9:** صفّان مرتّبان الأحدث أولاً؛ النقر يفتح ورقة الفاتورة لذلك الإيصال بالضبط

**`verify-b5-b7`**
- ✅ **B5:** التنقل يعمل (اليوم ← أمس ← قبل أمس)؛ «العودة لليوم» يعمل؛ **`render()` جديد يعود لليوم** — هذا هو إثبات الإصلاح؛ فواتير اليوم تعود ولا تظهر فواتير اليوم القديم
- ✅ **B7:** أدلة الانحدار — الكود القديم يُطوي الشريط حتى على `pos`؛ الكود الجديد يبقيه مفتوحاً على `pos` ويطويه خارجه، ويتعامل مع `undefined`

**`sale-flow-test` — انحدار تدفق البيع الأصلي (بـ `db.js` و`analytics.js` الحقيقيين)**
- ✅ 8/8: يُحفظ البيع، `receiptNo` + `timestamp` + `total` + `items`، يظهر في `listSales()`، يشمله `salesBetween()` و`salesOn()`، مفتاح_bucket اليوم مطابق، **والمخزون ينقص 5 ← 3 داخل المعاملة نفسها**

**فحص سلامة إضافي**
- ✅ **58** مدخلاً في `PRECACHE`؛ كل ملف `js`/`css`/`html` موجود؛ لا مدخلات قديمة؛ `VERSION = 'v8'` لا يزال صحيحاً (لم يُضَف أي وحدة جديدة — B9 أعاد استخدام الوحدات القائمة)

### النتيجة النهائية
```
ok    syntax-check         27/27 modules parse cleanly
ok    b6-scan              no defects: every moneyHTML() is reached via html:
ok    import-check         338 named imports checked, 0 problem(s)
ok    cycle-check          STATIC IMPORT CYCLES (7)  [pre-existing]
ok    verify-fixes         RESULT: ALL CHECKS PASSED
ok    verify-b1-detail     RESULT: renderDetail() CONFIRMED WORKING
ok    verify-b9-render     RESULT: B9 RENDERING VERIFIED
ok    verify-symptoms      RESULT: ALL SYMPTOM CHECKS PASSED
ok    verify-b5-b7         RESULT: B5 + B7 VERIFIED
ok    verify-b6-extra      RESULT: OK
ok    sale-flow-test       RESULT: no data-layer break found

ALL 11 HARNESSES GREEN
```

---

## 5. المشكلات المعروفة المتبقية (Remaining Known Issues)

### 5.1 ⚠️ التحقق على جهاز حقيقي إلزامي قبل التسليم — B1

هذه **الأهم**. إصلاح B1 **يُفعِّل ~250 سطراً في `renderDetail()` لم تُنفَّذ قط**. أثبتُّ أنها تعمل (تعرض بيانات، تحسب الرصيد، لا ترمي) عبر DOM وهمي، **لكن ذلك لا يغطي**:
- أسوأ حالات `openModal` / `openSheet` / `confirmDialog` (إضافة فاتورة مورد، تسجيل دفعة، تعديل مورد، حذف)
- أي اعتماد على `matchMedia`، `element.animate`، أو تركيب `::backdrop`
- سلوك التركيز و`trapFocus`

**يجب** تجربة: فتح تفاصيل مورد ← إضافة فاتورة ← تسجيل دفعة ← تعديل ← العودة للقائمة. في تطبيق Electrum/Workbox تعطُّل واحد في هذا المسار يعني مورداً لا يستطيع تسجيل دينه.

### 5.2 ⚠️ سبع دورات استيراد ساكنة موجودة مسبقاً

```
js/router.js -> js/screens/dashboard.js -> js/router.js
js/router.js -> js/screens/pos.js       -> js/router.js
js/router.js -> js/screens/products.js  -> js/router.js
js/router.js -> js/screens/products.js  -> js/screens/product-form.js -> js/router.js
js/router.js -> js/screens/reports.js   -> js/router.js
js/router.js -> js/screens/settings.js  -> js/router.js
js/router.js -> js/screens/suppliers.js -> js/router.js
```
**سابقة لإصلاحي ولا علاقة بها.** `router.js` يستورد كل الشاشات، ومعظم الشاشات تستورد `navigate()` منه. وهي **حميدة** لأن `main.js` يستورد `router.js` أولاً، وحين يبدأ تقييمه تكتمل كل شاشة قبل أن تُبنى مصفوفة `ROUTES`. وأكّدتُ ذلك عملياً: **حاولتُ استيراد `suppliers.js` أولاً فسقط بخطأ TDZ** — وهو أثر ترتيب الاستيراد، لا خطأ في التطبيق.

**تغيير ترتيب أي استيراد في `main.js` كسر التطبيق.** وهذا سبب إضافي لعدم لمس ترتيب الاستيراد في B4 (استخدمتُ استيراداً ديناميكياً).

> ⚠️ **تصحيح سجل مُ auditorي:** أداة `import-check` الأولى أخرجت جملة «لا دورات استيراد ساكنة» وأنا استندتُ إليها. كانت خاطئة (خوارزمية DFS معطوبة). `cycle-check.mjs` هو التقرير الموثوق، والأرقام أعلاه صحيحة.

### 5.3 فجوة عقد `openSheet` / `openModal` (B3b) — الإصلاح المحلي لا جذر المشكلة

`openSheet` لا يُرجع `body` بينما `openModal` يُرجعه. أصلحتُ `stock-sheet.js` محلياً ليطابق الأنماط الأربعة القائمة. **أي ورقة-sheet جديدة ستصطدم بنفس الخطأ.** الإصلاح الجذري هو إضافة `body` إلى ما يُرجعه `openSheet` — تغيير أصغر في الواقع، لكنه يلمس عقداً مشتركاً، فتركتُه خارج النطاق. **أوصي به كأول بند في الدورة القادمة.**

### 5.4 شريط التنقل السفلي بستة عناصر

عند ‏360px يأخذ كل عنصر عادي ‏~58px. «الموردون» و«الإعدادات» أطول تسميات. يعمل مع القصّ، لكنه **أضيق من تصميمه الأصلي**. لم أختبر على جهاز فعلي. إن كان ضيّقاً: تصغير `font-size` أو تقليل `flex-basis` للزر الأساسي — تعديل CSS محلي.

### 5.5 H1 — `ILS` مكتوبة في `pos.js`

مفتاح الخصم الثابت يستخدم `ILS` مكتوبةً يدوياً بدل عملة الإعدادات. **مقصود تركُه خارج النطاق** ومُبلَّغ في التدقيق السابق. لم يُلمس.

### 5.6 APK المُسلَّم قديم

`ساهر-نسخة-التسليم.apk` (‏29,545,467 بايت) **سبَق** كل هذه الإصلاحات. **مطلوب بِناؤه من جديد** ليصلح بالشكل الصحيح.
- **موقّع بتصحيح (debug)** — لا يوجد مفتاح إصدار على هذا الجهاز. **يجب** توقيع إصدار قبل أي تسليم حقيقي، وإلا فلن يُقبل على متجر Play أو خارج التثبيت العرضي.
- بيانات IndexedDB المحلية على أي جهاز مُثبَّت لا تتأثر بالترقية.
- عند الحاجة للبناء: `JAVA_HOME=C:\Users\Lenovo\.jdks\jbr-21.0.11`، `ANDROID_HOME=C:\Users\Lenovo\AppData\Local\Android\Sdk`، واستخدام ثنائي Capacitor المحلي لا `npx` (يعلق على الشبكة).

**لم يُبنَ APK في هذه المرحلة، ولم يُمسّ `C:\Users\Lenovo\saher-apk`، حسب التعليمات.**

### 5.7 نقاط لم تُغطَّ

- **عرض التقارير على مقاس جوال حقيقي** — تحققتُ من وجود `reports` في `BOTTOM_NAV` ومن قواعد `flex`، **لا** من العرض البصري الفعلي.
- **مسارات تعديل/استرداد الفاتورة من التقارير** — تحققتُ من أن الصفّ يستدعي `openInvoiceSheet` بالبيع الصحيح؛ **لا** من تنفيذ مساري الحفظ والاسترداد فعلياً (يحتاجان محاكاة تفاعلية).
- **العمل دون اتصال عبر service worker** — تحققتُ من سلامة `PRECACHE`، لا من دورة تثبيت/تحديث كاملة.
- `saher-apk` غير متزامن مع مصدر الويب بحكم أن آخر تعديلاتنا بعد آخر مزامنة.

---

## 6. التوصيات

1. **اختبار جهاز حقيقي لـ B1 أولاً** (§5.1). أعلى مخاطرة في هذه الدفعة.
2. **أصلح عقد `openSheet`** ليُرجع `body` (§5.3) — يمنع تكرار B3b.
3. **أصلح ترتيب استيراد `main.js`** ليُدير دورات `router.js` بلا اعتماد على الترتيب (§5.2) — هشّ وغير بديهي.
4. **أنشئ مفتاح إصدار** ووقّع إصداراً جديداً؛ الـ APK الحالي موقّع تصحيح وقديم (§5.6).
5. **أبقِ أدوات الاختبار الـ11** في المشروع (أو في مجلد `tools/`) كـ `npm test`. تحققتُ من عشرة من هذه الأعطال لم تكن لتُكتشف بقراءة الكود — خاصة B1 وB3b وB6-4.

---

*انتهى. أخطاء وظيفية مُصلَحة ومُتحقَّق منها في مصدر الويب. لم يُبنَ APK، ولم يُمسّ `saher-apk`، ولم يبدأ عمل المصادقة/الوحة الإدارية.*
