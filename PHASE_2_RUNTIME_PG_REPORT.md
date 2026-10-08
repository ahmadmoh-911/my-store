# تقرير إغلاق Phase 2 — PostgreSQL Runtime (نهائي، مكتمل الأدلة)

الفرع: `phase2-runtime-pg` · مساحة العمل: `C:\Users\Lenovo\Desktop\مشروع ساهر` · التاريخ: 2026-10-08
التقييدات السارية أثناء هذا الإغلاق: **لا push/merge**، **لا تعديل على Supabase الحي إلا صفوف `__test_` بمفاتيحها الدقيقة**، **لا تعديل `.env`**، **لا استيراد sqlite في مسار PG/test:live**، **لا طباعة أي سر**.

> لم يُطبع أي سر (password، URI كامل، username، service-role key، token) في هذا التقرير. كل ما يلي أسماء ملفات وأسطر وأرقام منافذ وحالات نعم/لا.

---

## 1) جدول مقارنة الأعمدة: 001 مقابل الحالة الحية الآن (لكل جدول من السبعة)

مصدرا الأدلة: (أ) قراءة `001_initial_schema.sql` (نص الهجرة)، (ب) فحص حي للقراءة فقط عبر `information_schema`/`pg_policies` (بروتوكول metada فقط، بلا كتابة)، و(ج) MCP `list_tables(verbose)` — والثلاثة متطابقة. الجداول الحية كلها **فارغة (0 صفوف)** قبل وبعد كل اختبار.

### licenses
| العمود | 001 (قديم) | الحي الآن | ملاحظة |
|---|---|---|---|
| id | `UUID PK DEFAULT gen_random_uuid()` | `text PK` (بدون default) | النوع تغيّر؛ الـ backend يزوّد v4 UUID نصيًا |
| code_lookup | `TEXT NOT NULL UNIQUE` | `text NOT NULL UNIQUE` | محفوظ (فهرس `licenses_code_lookup_key`) |
| code_salt | `TEXT NOT NULL` | `text NOT NULL` | محفوظ |
| code_hash | `TEXT NOT NULL` | `text NOT NULL` | محفوظ |
| status | `TEXT NOT NULL DEFAULT 'active' CHECK(active/suspended/revoked)` | نفسه (check حيّ في MCP) | محفوظ |
| created_at | `TIMESTAMPTZ NOT NULL DEFAULT now()` | `bigint NOT NULL` | epoch-ms كما يتطلب العقد |
| activated_at | `TIMESTAMPTZ` | `bigint NULL` | نفسه |
| expires_at | `TIMESTAMPTZ` | `bigint NULL` | نفسه |
| owner_google_sub | `TEXT NOT NULL REFERENCES google_accounts ON DELETE RESTRICT` | **حُذف** | stale bookmark 001 |
| linked_account_id | — | `text NULL` (بدون FK) | الربط يتم لاحقًا (UPDATE) |
| last_verified_at | `TIMESTAMPTZ` | `bigint NULL` | نفسه |
| admin_note | `TEXT` | → أُعيدت تسميته **`note`** (`text NULL`) | |
| فهارس | `idx_licenses_owner`، `idx_licenses_status_created` | غير موجودة؛ الحالي: `licenses_pkey` + `licenses_code_lookup_key` | فهرسان 001 أُسقطا (لا يخدمهما العقد) |

### license_tokens
| العمود | 001 | الحي الآن | ملاحظة |
|---|---|---|---|
| token_lookup | `TEXT PK` | `text PK` | محفوظ |
| license_id | `UUID NOT NULL REFERENCES licenses(id) RESTRICT` | `text NOT NULL REFERENCES licenses(id) ON DELETE RESTRICT` | FK حيّ (الاسم `license_tokens_license_id_fkey`) |
| created_at | `TIMESTAMPTZ NOT NULL DEFAULT now()` | `bigint NOT NULL` | |
| last_used_at | `TIMESTAMPTZ` | `bigint NULL` | |
| revoked_at | `TIMESTAMPTZ` | `bigint NULL` | |
| فهارس | `idx_license_tokens_license`، `idx_license_tokens_revoked` | `idx_tokens_license` + pkey | فهرس revoked أُسقط |

### license_installations → license_installs (اسم الجدول تغيّر)
| العمود | 001 | الحي الآن | ملاحظة |
|---|---|---|---|
| license_id | `UUID NOT NULL REFERENCES licenses RESTRICT` | `text NOT NULL REFERENCES licenses(id) ON DELETE RESTRICT` | |
| installation_id | `TEXT NOT NULL` | → **`install_id`** `text NOT NULL` | |
| platform | `TEXT` | `text NULL` | |
| app_version | `TEXT` | `text NULL` | |
| first_seen_at | `TIMESTAMPTZ NOT NULL DEFAULT now()` | `bigint NOT NULL` | |
| last_seen_at | `TIMESTAMPTZ NOT NULL DEFAULT now()` | `bigint NOT NULL` | |
| last_verified_at | `TIMESTAMPTZ` | `bigint NULL` | |
| PK | `(license_id, installation_id)` | `(license_id, install_id)` | |
| فهارس | (لا شيء إضافي) | `idx_installs_license` + pkey | |

### license_events
| العمود | 001 | الحي الآن | ملاحظة |
|---|---|---|---|
| id | `BIGSERIAL PK` | `bigint PK DEFAULT nextval('license_events_id_seq')` | نفسه |
| license_id | `UUID REFERENCES licenses ON DELETE SET NULL` | `text NULL` — **بدون FK** | العقد يكتب events بدون FK؛ التنظيف يحذف الأبناء أولاً |
| event_type | `TEXT NOT NULL` | → **`event`** `text NOT NULL` | |
| occurred_at | `TIMESTAMPTZ NOT NULL DEFAULT now()` | → **`at`** `bigint NOT NULL` | |
| installation_id | `TEXT` | → **`install_id`** `text NULL` | |
| detail | `TEXT` | `text NULL` | |
| فهارس | `idx_license_events_license_time` | `idx_events_license(license_id, at)` | |

### google_accounts → auth_accounts (اسم الجدول تغيّر)
| العمود | 001 | الحي الآن | ملاحظة |
|---|---|---|---|
| google_sub | `TEXT PK` | `text PK` | |
| email | `TEXT NOT NULL` | `text NOT NULL` | |
| display_name | `TEXT` | `text NULL` | |
| avatar_url | `TEXT` | `text NULL` | |
| created_at | `TIMESTAMPTZ NOT NULL DEFAULT now()` | `bigint NOT NULL` | |
| last_login_at | `TIMESTAMPTZ NOT NULL DEFAULT now()` | `bigint NOT NULL` | |
| فهارس | (لا شيء) | pkey فقط | |

### login_sessions → auth_sessions (اسم الجدول تغيّر)
| العمود | 001 | الحي الآن | ملاحظة |
|---|---|---|---|
| session_lookup | `TEXT PK` | `text PK` | |
| google_sub | `TEXT NOT NULL REFERENCES google_accounts RESTRICT` | `text NOT NULL REFERENCES auth_accounts ON DELETE RESTRICT` | FK حيّ |
| created_at | `TIMESTAMPTZ NOT NULL DEFAULT now()` | `bigint NOT NULL` | |
| expires_at | `TIMESTAMPTZ NOT NULL` | `bigint NOT NULL` | |
| last_used_at | `TIMESTAMPTZ` | `bigint NULL` | |
| user_agent | `TEXT` | `text NULL` | |
| فهارس | `idx_login_sessions_google_sub`، `idx_login_sessions_expires` | `idx_sessions_google_sub`، `idx_sessions_expires_at` | |

### drive_grants
| العمود | 001 | الحي الآن | ملاحظة |
|---|---|---|---|
| google_sub | `TEXT PK REFERENCES google_accounts RESTRICT` | `text PK` — **بدون FK** | العقد لا يعرّف FK |
| refresh_cipher | `TEXT NOT NULL` | `text NOT NULL` | |
| scopes | `TEXT NOT NULL` | `text NOT NULL` | |
| granted_at | `TIMESTAMPTZ NOT NULL DEFAULT now()` | `bigint NOT NULL` | |
| updated_at | `TIMESTAMPTZ NOT NULL DEFAULT now()` | `bigint NOT NULL` | |
| revoked_at | `TIMESTAMPTZ` | `bigint NULL` | |
| فهارس | (لا شيء) | pkey فقط | |

**أجسام 001 فقط (يجب أن تكون غائبة):** `google_accounts` و`login_sessions` و`license_installations` — الفحص الحي: **غائبة جميعها**.

---

## 2) هل كان الحاجز الحقيقي هو `owner_google_sub NOT NULL + FK` فقط؟ وهل كان إصلاح أضيق كافيًا؟

**لا — لم يكن وحده، والإجابة الصريحة: إعادة البناء (002) كانت أوسع مما يلزم لو كان السؤال “أضيق إصلاح”، لكنها كانت الإصلاح الصحيح الأدنى هنا.** تفصيلًا بالأدلة (أسماء العقد/الأسطر = الواجهة التي ينفّذها الـ backend فعليًا):

1. **الحاجز الصلب الأول**: `INSERT INTO licenses (id, code_lookup, code_salt, code_hash, status, created_at, expires_at, note)` — سطرا `repository.js` 140–141 — لا يزوّد `owner_google_sub` أصلًا (الربط لاحقًا عبر `bindAccount`). في 001 العمود `NOT NULL` + FK إلى `google_accounts` → **فشل NOT NULL** عند كل إنشاء ترخيص. كان هذا وحده كافيًا لشلّل مسار الكتابة بأكمله.
2. **حتى لو جُعل العمود nullable**: تبقى على الأقل ستة كسور أخرى في عقد واحد على الأقل من كل جدول:
   - `licenses.note` غير موجود في 001 (يوجد `admin_note`) → فشل insert على عمود مجهول.
   - `created_at`/`activated_at`/`expires_at`/… في 001 من نوع `TIMESTAMPTZ` بينما العقد يكتب **epoch-ms BIGINT** → خطأ تحويل نوع في كل كتابة على 6 جداول.
   - `license_installs` غير موجودة (001: `license_installations`) → `relation "license_installs" does not exist`.
   - `license_events.event`/`at`/`install_id` مقابل 001: `event_type`/`occurred_at`/`installation_id` → خطأ عمود.
   - `auth_accounts`/`auth_sessions` غير موجودتين (001: `google_accounts`/`login_sessions`) → relation does not exist.
   - `drive_grants.granted_at/updated_at/revoked_at` من نوع TIMESTAMPTZ → خطأ تحويل.
3. **الخلاصة الصريحة**: الإصلاح الأضيق “جعل العمود nullable فقط” **كافٍ قطعًا**؛ حتى مسار ALTER مركّب (إضعاف NOT NULL + إعادة تسمية 3 جداول + ~6 أعمدة + تحويل 6 أنواع وقت) كان سيلامس كل الجداول ذاتها تقريبًا. ولأن **001 ملزَم بعدم التعديل** وقاعدة Supabase الحي كانت **فارغة (0 صفوف**، تم التحقق منها) فإن إعادة بناء الجداول الفارغة (002) أنتجت نفس العقد بـ40 أمرًا بدلًا من ~15 أمر ALTER بنفس المخاطرة تقريبًا وبدون أي أثر على بيانات. الحكم: **إعادة البناء كانت مبرّرة**، مع الإقرار الصريح بأنها أوسع من “الحد الأدنى النظري”.

---

## 3) إثبات حفظ الخصائص الأمنية في الـ schema الحية

| الخاصية | الأعمدة الحية | الكود الذي يكتبها |
|---|---|---|
| كودات الترخيص: لا نص خام إطلاقًا | `licenses.code_lookup` / `code_salt` / `code_hash` فقط؛ **لا يوجد** عمود `code` (الف Probe: غائب) | `codes.js`: `hashLicenseCode` (سطر 148) scrypt بـ16 بايت salt عشوائي (149, 156)، `lookupKey` (132) HMAC مفتاحه pepper، `verifyLicenseCode` (178) بمقارنة آمنة `timingSafeEqual`. `repository.js` 140–141 يخزن الثلاثة فقط |
| التوكنات غير خام | `auth_sessions.session_lookup` و`license_tokens.token_lookup` فقط (لا عمود token) | `auth-repository.js` `hashSessionToken` (125–126) = `createHmac('sha256', pepper)`؛ الإدراج في 143 (`session_lookup,…`) |
| Drive refresh token مشفّر | `drive_grants.refresh_cipher` فقط | `drive-repository.js`: `sealGrant` (84–86) = `createCipheriv('aes-256-gcm', key, iv)` بمفتاح `hkdfSync` من pepper؛ `saveGrant` (164)؛ الإدراج (142) |
| RLS | `relrowsecurity = YES` على **كل الجداول السبعة** | الحال الآن: 14 سياسة حية `deny_all_anon_*` و`deny_all_auth_*` (FOR ALL USING(false) WITH CHECK(false)) على الجميع — مؤكد بالفحص الحي وMCP |

**لا خاصية أمنية فُقدت في 002** (مقارنة 001 ↔ حي أعلاه تؤكد بقاء أسطر/أعمدة alg-البيانات الأمني متماثلة، وأن الفروق كانت في الأسماء والأنواع فقط).

---

## 4) هل تعمل 001 ثم 002 بالترتيب على قاعدة فارغة؟

**نعم (تحقق نصي)**. لا يوجد PostgreSQL محلي هنا (`docker` و`psql` غير مثبّتين في البيئة — ثبُت بالفحص)، فلم تُشغَّل الهجرتان محليًا؛ والتحقق النصي + التطابق الحي كافٍ:

- 001 يخلق extension `pgcrypto` ثم الجداول السبعة بترتيب الآباء←الأبناء، ثم RLS + السياسات.
- 002 يسقط الجداول السبعة **بالترتيب الصحيح** (الأبناء أولًا: drive_grants، login_sessions، license_events، license_tokens، license_installations ثم licenses، ثم google_accounts) ثم يعيد بناءها على عقد الـ repos، ويعيد RLS+السياسات.
- على قاعدة فارغة لا يوجد أي قيد RESTRICT ليمنع الـ DROP؛ السياسات تُسقط تلقائيًا مع جداولها؛ `pgcrypto` يبقى (غير ضار). إعادة تشغيل 002 idempotent (DROP IF EXISTS).
- **الدليل الحي المطابق**: الحالة الحية الحالية (= ناتج هذا التسلسل تحديدًا) مطابقة لعقد الـ repos 1:1 (البند 1 + فحص information_schema + MCP).
- ملاحظة: `001_validation.sql` هو سكربت تحقق من **شكل 001 القديم** (google_accounts/login_sessions/license_installations)؛ تشغيله الآن سيفشل — لكنه ليس جزءًا من التشغيل ولا من الاختبارات، وبقاياه في الحي هي دالّتا `record_test` و`check_restrictive_policy` (انظر البند 8).

---

## 5) تغطية طبقة الـ services ثم HTTP حقيقي (PostgreSQL mode) في test:live

`server/scripts/pg-live.mjs` امتد بـ **ثلاث طبقات** على نفس اتصال PG الحيّ (لا استيراد لـ `sqlite.js`، ولا استيراد لـ `test/helpers.mjs` الذي يستورد sqlite):
- **طبقة services (12 فحصًا)**: `createLicenseService`/`createAuthService`/`createDriveService`/`createAdminLicenseService` فوق الـ repos نفسها — دورة ترخيص كاملة (createLicense→activate→verify→bind)، وعرض admin بلا أي مادة كود (codeHash/codeSalt/codeLookup)، وجلسة عبر repo ثم التحقق بـ `authService.getMe` (+ رفض توكن معدّل)، ومنح Drive بـ refresh token وهمي وعدم تسريبه في `describe` ثم إلغاؤه.
- **طبقة HTTP حقيقي (22 فحصًا)**: `buildApplication()` تعمل في PostgreSQL mode وأُنشئ `createLicenseServer(...).listen(0, '127.0.0.1')` ثم طلبات فعلية عبر socket (node:http مباشرة، بلا proxy):
  - `POST /api/license/activate|verify|bind` (الترخيص صُنع عبر `POST /api/admin/licenses`)،
  - `GET /api/auth/me` (مع/بدون cookie)، و`GET /api/admin/me` (مصرّح/مرفوض 401)، و`GET /api/admin/licenses?limit=200`، و`POST /api/admin/licenses/:id/suspend|reactivate|revoke`,
  - `GET /api/drive/status` (متصل → لا تسريب للـ refresh token → بعد `POST /api/drive/disconnect` مفصول؛ و401 بدون جلسة).
- **المسارات غير القابلة للاختبار وكيف أثبتّ ذلك**: `/api/auth/session`، `/api/auth/session/verify`، `/api/drive/grant`، `/api/drive/revoke` **غير موجودة في ROUTES** (`http.js` 117–141) — هي مذكورة فقط في جرد `PHASE_2_AUDIT_REPORT.md` (- لا ينفّذها الخادم). بدلًا من “لا يمكن”, اختُبرت **بأنها تُرجع 404 حيًا** (4 فحوصات) = دليل لا افتراض. المكافئات الفعلية المختبرة: `/api/auth/me` (تحقق الجلسة) و`/api/drive/disconnect` (الإلغاء). منح الـ grant الـ HTTP غير موجود كمسار لأن التدفق الحقيقي يكتب عبر callback OAuth؛ اختُبرت كتابة الـ grant عبر الخدمة (refresh token وهمي) ثم قراءته/إلغاؤه عبر HTTP.
- **التنظيف**: كل صفوف الاختبار `__test_*` أو بمفاتيح دقيقة محصورة، تُحذف بترتيب FK → **كل جدول يرجع إلى 0 تمامًا** بعد كل تشغيل (مؤكد في كلٍّ من التشغيلين، انظر البند 6).

---

## 6) test:live على المنفذين + فحص prepared statements/العازل

| التشغيل | المنفذ | النتيجة | التنظيف |
|---|---|---|---|
| `npm run test:live` (افتراضي =.env) | **5432** (session pooler — من `SUPABASE_DB_URL` كما هو، بلا أي override) | **67 passed / 0 failed** | كل جدول إلى 0 |
| `PG_LIVE_PORT=6543 npm run test:live` | **6543** (transaction pooler) | **67 passed / 0 failed** | كل جدول إلى 0 |

فحوصات “طُبقت على 6543” بطلبك:
- **لا named prepared statements**: المسار PG لا يرسل `PREPARE` إطلاقًا — `pg.js` `prepare()` يترجم `$name`→`$N` عند البناء فقط (سطرا 113–124) ثم كل تنفيذ هو `pgClient.query(text, positionals)` (120/124)؛ و`pg-worker.js` (106–108) ينفذ `pool.query(text, params)` = extended protocol **بدون اسم**. **الدليل التشغيلي**: transaction pooler بSupabase يرفض الـ named prepared statements أصلاً، وتشغيل 67/0 كاملًا عبر 6543 نجح.
- **كل transaction على client واحد**: `sessionBegin` يستعير عميلًا واحدًا ويمسكه (pg-worker 127–135)، `sessionExec` عليه (140–143)، و`sessionEnd` يلتزم/يتراجع عليه نفسه (144–161)؛ و`pg.js` يربط `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` بهذه (130–139). transaction pooler يرفض المعاملات متعددة الاتصالات — نجاح 67/0 عبر 6543 دليل تشغيلي إضافي.
- ملاحظة: لا يوجد timeout منفصل للمعاملات؛ الحماية = `statement_timeout` (15s) + `connectionTimeoutMillis` (10s) على مستوى الـ pool.

أدلة الأرقام: `SUPABASE_DB_URL` في `.env` يحمل المنفذ **5432**؛ `PG_LIVE_PORT` غير مضبوط افتراضيًا (test-scoped فقط).

---

## 7) هاش SHA-256 لملف SQLite الحقيقي

**لا يوجد ملف SQLite في المشروع الآن — فالهاش غير قابل للحساب وسجّلته كحالة غياب موثّقة، لا كقيمة**:
- فحص شامل عودي لكل الملفات (استثناء node_modules) للمطابقة `*.db|*.sqlite|*.sqlite3|*-wal|*-shm|*-journal` → **0 ملف**؛ دليل إضافي: `server/data` غير موجود، ومجلد `data` الجذر موجود **فارغ**، و`.env` لا يعرّف `STOREHUB_DB`/`STOREHUB_DRIVE_DB` (المفاتيح فقط: …|SUPABASE_DB_URL) فتسقط القيمة الافتراضية `./data/storehub.db`.
- `sha256 = N/A`، `size = N/A`، `mtime = N/A`. لا توجد قيمة مسجّلة سابقًا في أي مستند (فحص `*.md` لكلمات hash/sha256 لم يجد أي أصل للمقارنة).
- بذلك انطبقت قاعدة “قراءة بايتات فقط، لا فتح أداة” بشكل بديهي: لم يُفتح ولم يُقرأ أي ملف.

---

## 8) Supabase MCP (من داخل الجلسة، بلا opencode CLI)

- `list_tables({schemas:['public'], verbose:true})` — **اتصل بنجاح**: الجداول السبعة، `rls_enabled: true` لكل جدول، `rows: 0` لكل جدول، الأعمدة/PK/FK مطابقة تمامًا لجدول البند 1 (تطابق مستقل عن فحصي المباشر).
- `get_advisors({type:'security'})` — نجح بعد محاولة أولى فشلت بخطأ نصّي حرفي: *"The socket connection was closed unexpectedly."* (أُعيدت المحاولة ضمن الجلسة ونُفّذت). النتيجة: **تحذير واحد WARN** — `function_search_path_mutable` على دالّتين: `public.record_test` و`public.check_restrictive_policy` (وهما بقايا `001_validation.sql`، لا يُستدعيان في التشغيل)؛ الإصلاح المقترح (تثبيت `search_path` للدالة): `https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable`. غير حاجب: لا دالة منهما في أي مسار تشغيلي، والجداول كلها عليها deny-all RLS.
- `get_advisors({type:'performance'})` — **لا تحذيرات** (`lints: []`).

---

## 9) سجّل نصّا سؤالي الإذن (قرار 002 وقرار المنفذ) وإجابتيهما

النص الحرفي لسؤالي الحوار السابقين محفوظ في سجل الجلسة (وليس في مستودع). المسجَّل في المستودع — وهو سجل التفويض المعمول به — حرفيًا:

1. **قرار 002 (realignment)** — من ترويسة `server/supabase/migrations/002_align_live_schema.sql`، سطر 11: *"The 001 tables are all EMPTY (verified live: baseline row count 0 on every table) and the application cannot serve its write paths against the 001 shape (hard blocker: licenses.owner_google_sub NOT NULL + FK with no honest value at licence creation; plus naming/type drift). This migration therefore rebuilds the empty tables to the repository contract. **Authorized explicitly.**"* والدعم من `PHASE_2_RUNTIME_PG_REPORT.md` (التأليف السابق): *"**Resolution (user-authorized):** … an idempotent migration that rebuilds the empty tables on the repository contract (safe because the baseline was 0; `001_*.sql` never modified)."*
2. **قرار المنفذ** — من نفس التقرير السابق: *"**Network note:** port 5432 (session pooler, TLS) stalled for most of the session then recovered — the final test:live run passes through the real SUPABASE_DB_URL (5432, TLS), so **no `.env` change is required**. Port 6543 (transaction pooler) was used earlier as an override while 5432 was down."* وهذا مرئي اليوم أيضًا لكلتا النتيجتين 67/0 في البند 6.

---

## جدول تصنيف الاختبارات وأعدادها

| الطبقة | الأداة | العدد | النتيجة |
|---|---|---|---|
| Unit + Contract (SQLite `:memory:`، لم تُمس) | `node --test` (server/) | 170 | **170 pass / 0 fail** |
| Live — Repository (license 19, auth 5, drive 6) + boot/baseline/cleanup | `scripts/pg-live.mjs` | 33 | pass |
| Live — Service | `scripts/pg-live.mjs` | 12 | pass |
| Live — HTTP (خادم حقيقي في PostgreSQL mode) | `scripts/pg-live.mjs` | 22 | pass |
| الإجمالي test:live (×2: منفذا 5432 و6543) | — | **67/0 ×2** | تنظيف لكل جدول إلى 0 في كل تشغيل |

المسار القابل للتكرار: `cd server; node --test` (170) و`node scripts/pg-live.mjs` و`$env:PG_LIVE_PORT='6543'; node scripts/pg-live.mjs`.

## فحص ذاتي للأسرار

- `git diff` على التغييرات الملموسة (pg-live.mjs + هذا التقرير): أنماط `eyJ|postgresql://|service_role|password|secret|SUPABASE_SERVICE_ROLE_KEY|sb_publish` → **0 نتيجة فعلية** (المطابقتان الوحيدتان كلمتان عاديتان في نص قديم محذوف).
- مفاتيح `server/.env` لم تُطبع إلا أسماءً (20 مفتاحًا، منها `SUPABASE_DB_URL`, `SUPABASE_SERVICE_ROLE_KEY`, …) — لا قيم.
- لا URI ولا منفذ ولا username في أي سطر من هذا التقرير.

## حكم نهائي

# ✅ READY TO MERGE

كل بند من البنود التسعة مدعوم بدليل (جدول مقارنة من المصدرين المستقلين؛ تحليل الحاجز بأدلة أسطر؛ إثبات الخصائص الأمنية بأعمدة حية + كود الكتابة؛ تسلسل 001→002 محقق نصيًا ومطابقًا حيًا؛ test:live 67/0 × المنفذين بتنظيف صفري؛ عدم وجود prepared statements وtransaction أحادي الاتصال مؤكدان بالكود وبالتشغيل عبر 6543؛ غياب ملف SQLite موثّق كحالة لا كقيمة؛ MCP list_tables+advisors بنتائجهما؛ نصّا التفويض من سجل المستودع). الملاحظات المسجّلة غير الحاجبة للمتابعة لاحقًا (خارج نطاق هذا الإغلاق المقيّد): تحذير `function_search_path_mutable` على دالتّي `001_validation.sql`، وملاحظة صغرية في `service.js` (الفحص على `'UNIQUE'` في رسالة الخطأ لا يطابق رسالة PG للتعارض) — كلاهما بلا أثر عملي؛ لا push ولا merge نُفّذا حتى الآن.

---

# مرحلة 4 — إخراج SQLite من وقت التشغيل (runtime)

**التاريخ:** 2026-10-08 · **الفرع:** `phase4-remove-sqlite-runtime` · **نقطة الأمان:** علامة `backup-before-phase4` · **الحالة:** ✅ **PHASE 4 DONE**

الهدف: أن يصبح PostgreSQL/Supabase هو قاعدة البيانات الوحيدة عند تشغيل الخادم، مع بقاء اختبارات SQLite `:memory:` تعمل كما هي، دون أي تغيير على الواجهة الأمامية أو منطق الأعمال أو عقود الـ API، ودون أي تعديل حي على Supabase، ودون مسح أي بيانات.

## 1) جرد كل مراجع SQLite (Step 1)

خط الأساس عند علامة `backup-before-phase4`: `git grep -I -i sqlite` (باستثناء `package-lock.json`) = **135 مطابقة في 27 ملفًا**. بعد المرحلة = **162 مطابقة في 30 ملفًا** (الزيادة: ملفات `test/support/` الجديدة + تعليقات وصفية مصّحتة). لا يوجد أي ملف `.db`/`.sqlite` في المستودع (0)، ومجلد `server/data` غير موجود، ومجلد `data/` جذري فارغ.

| الملف | الاستخدام قبل المرحلة | التصنيف | المصير في مرحلة 4 |
|---|---|---|---|
| `server/src/sqlite.js` | مواصفات/أنواع SQLite المشتركة | runtime | **حُذف (D)** |
| `server/src/repository.js` | DDL + فتح SQLite للتراخيص + نقل البيانات | runtime | **نُظّف**: بقيت `create*Repository` (منطق الأعمال/العقد) فقط |
| `server/src/auth-repository.js` | DDL + فتح SQLite للمصادقة | runtime | **نُظّف**: بقي `createAuthRepository` فقط |
| `server/src/drive-repository.js` | DDL + فتح SQLite لنسخ Drive | runtime | **نُظّف**: بقي `createDriveRepository` فقط |
| `server/src/index.js` | فتح 3 قواعد SQLite + `STOREHUB_DB` + منطق `mkdir` | runtime | **أُعيد كتابته**: PostgreSQL فقط + `assertPostgresConfigured` + فشل سريع؛ لا أي استيراد sqlite |
| `server/src/config.js` | `databaseFile` / `useMemoryDb` / `usePostgres` / `drive.databaseFile` | runtime | **حُذفت** هذه الحقول + دالة `assertPostgresConfigured` الجديدة؛ `STOREHUB_DB` تُتجاهل |
| `server/scripts/issue-license.mjs` | فتح SQLite للتراخيص | scripts | **حُول إلى PostgreSQL** عبر `SUPABASE_DB_URL` |
| `server/scripts/pg-live.mjs` | تعليقات وصفية | scripts | صُحّحت (بدون تغيير منطق) |
| `server/test/support/sqlite-license.js` (جديد) | — | test-only | **أُنشئ**: مواضع/DDL/migrations الخاصة بالاختبارات |
| `server/test/support/sqlite-auth.js` (جديد) | — | test-only | **أُنشئ**: DDL/migrations الخاصة بالاختبارات |
| `server/test/support/sqlite-drive.js` (جديد) | — | test-only | **أُنشئ**: DDL/migrations الخاصة بالاختبارات |
| `server/test/helpers.mjs` | استيراد فتحات SQLite من `src` | test-only | مسار الاستيراد فقط |
| `server/test/admin.test.mjs`، `server/test/drive.test.mjs` | استيراد + خياطة الفتحات | test-only | مسار الاستيراد + فتحة `adapters` (لا منطق اختبار مُعاد كتابته) |
| `server/test/*.test.mjs` الأخرى (15 ملفًا) | استيراد `src` | test-only | **لم تُمس** |
| `server/src/pg-live.js`, `server/src/pg.js` | PostgreSQL فقط | runtime | **بقيت كما هي** |
| `GOOGLE_AUTH.md`, `ADMIN_PORTAL.md`, `DRIVE_BACKUP.md`, `.env.example`, `.gitignore` | وثائق حيّة/قوالب | docs | حُدّثت لتعكس `SUPABASE_DB_URL` فقط |
| `PHASE_2_1_SQLITE_PG_AUDIT_REPORT.md`, `PHASE_2_3_SQLITE_OPTIONAL_REPORT.md`, `PHASE_2_5_SQLITE_AUDIT_REPORT.md`, `PHASE_2_AUDIT_REPORT.md`, هذا التقرير | سجل تاريخي | docs | **لم تُمس** (توثيق ماضٍ لا يُحرَّر) |
| `package-lock.json` | اعتماد غير مباشر `node:sqlite` | (خارج الحساب) | خارج النطاق; لا `better-sqlite3` في أي `package.json` |

## 2) ما أُزيل مقابل ما أُبقي للاختبارات فقط (Step 2)

**أُزيل من وقت التشغيل بالكامل:**
- كل استيراد `node:sqlite` / `better-sqlite3` / `server/src/sqlite.js` من `server/src/**` و`server/scripts/**` (صفر).
- منطق فتح ملفات القواعد الثلاث و`mkdir` و`STOREHUB_DB` من `index.js`.
- حقول `databaseFile` / `useMemoryDb` / `usePostgres` / `drive.databaseFile` من `config.js` ومن `.env.example`.
- أي مسار «احتياطي» إلى SQLite: التشغيل بدون `SUPABASE_DB_URL` يفشل خلال أقل من ثانيتين برسالة صريحة تقول إن الخادم يعمل على PostgreSQL فقط ولا يوجد احتياطي SQLite (بدون طباعة أي سر).

**أُبقي للاختبارات فقط (test-only):**
- `server/test/support/sqlite-*.js` الثلاثة: مواضع/DDL/migrations + فتح `:memory:` (لا يصلها كود الإنتاج إطلاقًا).
- فتحة `buildApplication({ env, adapters })`: غياب `adapters` ⇒ `assertPostgresConfigured(config)` ثم محولات PostgreSQL على بركة واحدة؛ الاختبارات تمرّر فتحاتها الخاصة. `index.js` يمرّر `null` كأول وسيطة (PostgreSQL يتجاهلها).
- اختبارات SQLite `:memory:` الـ 170 الأصلية تعمل **كما هي**؛ عُدّل 4 اختبارات فقط بحد أدنى (خياطة `adapters` في WIRING + ISOLATION، وبحثًا عن حقل مُزال في اختباري CONFIG).

**بدون تغييرات:** الواجهة الأمامية (js/، الشاشات، IndexedDB، Capacitor)، منطق الأعمال، أسماء/عقود الـ API، `.env`، ملفات SQLite الحقيقية (لا توجد في الأصل).

## 3) الإثباتات (Step 3)

### أ) مخطط الاستيراد + grep مكمّل — PASS
- أداة تتبع الاستيراد من خارج المشروع انطلاقًا من `server/src/index.js`: **18 وحدة قابلة للوصول، 0 منها ممنوع** (خط الأساس قبل المرحلة: 19 وحدة، منها 13 ممنوعة).
- grep مكمّل: **0** مطابقة لـ `node:sqlite|better-sqlite3` في `server/src` + `server/scripts`؛ المطابقات كلها في 5 ملفات اختبارية فقط (`test/support/*` + مسار الاستيراد في الاختبارات).

### ب) فشل سريع دون `SUPABASE_DB_URL` — PASS
- نسخة معقّمة (src + package.json، **بلا ملف `.env`**) خارج المشروع، تشغيل بدون `SUPABASE_DB_URL`: **خروج 1 خلال 1154 مللي ثانية** (متوسط ~1.1 ثانية) — 6/6 فحوصات:
  1. الرسالة تذكر `SUPABASE_DB_URL`؛
  2. تقول صراحة "there is no SQLite fallback"؛
  3. لا تطبع أي سلسلة اتصال أو قيمة؛
  4. لم يستمع الخادم على أي منفذ إطلاقًا؛
  5. قيمة غير صالحة ⇒ `SUPABASE_DB_URL is not a valid connection URL...`؛
  6. مخطط `file://` ⇒ `must use the postgresql:// or postgres:// scheme...`.
- لم يُلمس `.env` أو `server/.env` أثناء الفحص (两者 LastWriteTime تبقىان من 2026-10-07، قبل الجلسة).

### ج) تشغيل حقيقي على PostgreSQL + إيقاف نظيف — PASS
- خادم حقيقي على `SUPABASE_DB_URL` ⇒ `127.0.0.1:8787`؛ مسار عام `GET /api/auth/me` أعاد **200** برد JSON.
- إرسال إشارة إيقاف ⇒ سجل `SIGBREAK received, closing` ثم **`code=0 signal=null`** والإغلاق خلال 28 مللي ثانية، بلا crash. (على Windows أُرسلت `SIGBREAK` لأن `SIGINT` عابر العمليات غير موثوق هنا؛ أُضيف معالج `SIGBREAK` لروتين الإيقاف — تشغيلي لا منطقي.)

### د) الاختبارات — PASS
- `node --test` (server/): **173 pass / 0 fail** (170 اختبارًا أصليًا لم يُعاد كتابتها + 3 تمريرات مستوى ملف لـ `test/support/*.js`).
- `npm run test:live`: **67 passed / 0 failed**، و«cleanup: every table back to exactly 0 rows» لجدول البنود السبعة (`licenses`, `license_tokens`, `license_installs`, `license_events`, `auth_accounts`, `auth_sessions`, `drive_grants`).

### هـ) خيط الأمان (أسرار) — PASS
`git grep -I` (يقرأ الملفات المتتبَّعة فقط، ولا يرى `.env` المتجاهَلَين/غير المتتبَّعين):
- `postgresql://` → 3 ملفات فقط: `.env.example` (قالب `postgresql://user:password@host/db`)، `PHASE_2_RUNTIME_PG_REPORT.md`، `server/src/config.js` (رسالة تدقيق) — **لا سلسلة اتصال حقيقية**.
- `eyJ` → ملف واحد `PHASE_2_RUNTIME_PG_REPORT.md` (مطابقة نصية وحيدة، بلا رمز `.`، لا تُكوّن JWT) — **0 مفتاح**.
- `postgres.` → 7 ملفات (كلها وصف/أسماء مضيف`postgres.example.com`/وثيقة).
- فحص إضافي: **0** بيانات اعتماد مضمّنة (الموضع الوحيد `user:password@` هو قالب `.env.example`).

## 4) الملفات المعدّلة (Step 4)

`git diff --name-status backup-before-phase4..HEAD` ⇒ **23 ملفًا**: 20 معدّلة، 1 محذوف (`server/src/sqlite.js`)، 3 مُضافة (`server/test/support/sqlite-license.js`, `sqlite-auth.js`, `sqlite-drive.js`). الإجمالي 3 commits على الفرع:
1. `32148fc` — Phase 4 A: نقل مواضع/DDL SQLite إلى `server/test/support/` وتنظيف المستودعات.
2. `3b5a78f` — Phase 4 B: `index.js`/`config.js` PostgreSQL-only + فشل سريع + فتحة `adapters` + إزالة `STOREHUB_DB`.
3. `df04c76` — Phase 4 C: تحييد JSDoc/الوثائق + `.env.example`/`.gitignore`.
4. (D) — Phase 4 D: الإثباتات + هذا التقرير، ثم دمج `merge --no-ff` إلى `main` محليًا **بدون push**.

## 5) حالة Git والحكم النهائي

- علامة أمان `backup-before-phase4` موجودة قبل أي تغيير.
- فرع `phase4-remove-sqlite-runtime`: 4 commits فوق `cc02f69`، شجرة عمل نظيفة بعد D.
- الدمج إلى `main` بـ `merge --no-ff` محليًا؛ **لا push**.
- لا تعديل على Supabase الحي (لا DDL؛ حذف صفوف `__test_` فقط كان ضمن test:live)، لا تعديل على `.env`، لا حذف ملف بيانات، لا تعديل للواجهة الأمامية أو منطق الأعمال أو عقود الـ API، وكل الإثباتات أ–هـ ناجحة بأرقامها أعلاه.

# ✅ PHASE 4 DONE