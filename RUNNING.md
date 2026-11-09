# Store Hub — تشغيل ونشر الخادم

هذا الملف يشرح كيفية تشغيل خادم Store Hub محلياً وفي بيئة staging، وكيفية نشره في الإنتاج.

## المتطلبات المطلوبة قبل التشغيل

| المتغير | الغرض | مطلوب؟ | كيف تُحصل عليه |
|--------|------|--------|----------------|
| `SUPABASE_DB_URL` | اتصال PostgreSQL المباشر | نعم (full/production) | لوحة Supabase → Settings → Database → Connection string |
| `STOREHUB_PEPPER` | توقيع أكواد التراخيص (scrypt) | نعم (full/production) | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `GOOGLE_CLIENT_ID` | معرف عميل OAuth | نعم (إذا استُخدم Google) | Google Cloud Console → Credentials |
| `GOOGLE_CLIENT_SECRET` | سر عميل OAuth (السيرفر فقط) | نعم (إذا استُخدم Google) | Google Cloud Console → Credentials |
| `GOOGLE_AUTH_REDIRECT_URI` | callback تسجيل دخول العميل | نعم (الإنتاج) | تُحدّد وتُسجّل في Google Cloud |
| `GOOGLE_ADMIN_REDIRECT_URI` | callback تسجيل دخول الأدمن | نعم (الإنتاج) | تُحدّد وتُسجّل في Google Cloud |
| `GOOGLE_DRIVE_REDIRECT_URI` | callback ربط Google Drive | نعم (الإنتاج) | تُحدّد وتُسجّل في Google Cloud |
| `STOREHUB_ADMIN_SUB` | حسابات Google المخوّلة للأدمن | نعم (للوصول للأدمن) | `sub` من Google ID token بعد تسجيل دخول |
| `STOREHUB_ADMIN_PORTAL_URL` |cara عودة الأدمن بعد تسجيل الدخول | إذا استُخدمت الأدمن | نطاق لوحة الأدمن الفعلي |

راجع ملف `ENV_VARIABLES.md` للجدول الكامل.

---

## 1. التشغيل المحلي (وضع التطوير)

```bash
# نسخ ملف المتغيرات وتعديله
cp .env.example .env
# حرّر .env وأضف القيم الفعلية (لا تُرتكب الأسرار إلى Git)

# تشغيل الخادم
cd server
npm start

# الخادم يستمع على http://127.0.0.1:8787
# اختبار الصحة:
curl http://127.0.0.1:8787/api/health
```

في وضع التطوير (`NODE_ENV=development`):
- الخادم يبدأ حتى لو كانت إعدادات Google ناقصة (تُعيد أخطاء إعداد فقط عند استدعاء نقاط OAuth).
- `STOREHUB_PEPPER` يستخدم قيمة افتراضية للتطوير.
- لا يُطلَب `STOREHUB_ADMIN_SUB` (ي 거부 جميع طلبات الأدمن).

---

## 2. التشغيل عبر Docker (Staging / محلي)

```bash
# من جذر المشروع
cp .env.example .env
# حرّر .env وأضف القيم الفعلية

docker compose up -d

# الخادم يستمع على http://localhost:8787
docker compose logs -f storehub-backend
```

ملف `docker-compose.yml` يقرأ متغيرات `.env` ويمررها للحاوية.

---

## 3. النشر في الإنتاج

### متطلبات النشر
- نطاق DNS يشير إلى الخادم
- شهادة SSL/TLS (Let's Encrypt أو ما يعادلها)
- PostgreSQL جاهز (Supabase أو منشأ ذاتياً)
- قيم فعلية لكل المتغيرات في `.env` (لا تُرتكب إلى Git)

### خطوات النشر
1.رفع كود الخادم إلى الخادم (git pull أو Docker build)
2.إنشاء `.env` من `.env.example` وتعبئة القيم الفعلية
3.تطبيق migrations على قاعدة بيانات PostgreSQL:
   ```bash
   psql "$SUPABASE_DB_URL" -f server/supabase/migrations/001_initial_schema.sql
   psql "$SUPABASE_DB_URL" -f server/supabase/migrations/001_validation.sql
   psql "$SUPABASE_DB_URL" -f server/supabase/migrations/002_align_live_schema.sql
   psql "$SUPABASE_DB_URL" -f server/supabase/migrations/003_activation_requests.sql
   ```
4.تشغيل الخادم: `cd server && NODE_ENV=production npm start`
5.ضبط خادم وكيل عكسي (nginx/Caddy) لتحويل المنفذ 443 إلى 8787 مع إنهاء SSL

### health / readiness endpoints
- `GET /api/health` — إرجاع `{"ok": true}` (لا أسرار، للمراقبة)
- `GET /api/ready` — يتحقق من اتصال قاعدة البيانات (لـ Kubernetes/Docker healthchecks)

---

## 4. تشغيل لوحة الأدمن

لوحة الأدمن تُخدم من نفس الخادم على المسار `/admin`:
- افتح `http://yourdomain.com/admin` في المتصفح
- سجّل الدخول عبر Google (يجب أن يكون `googleSub` الخاص بك في `STOREHUB_ADMIN_SUB`)
- بعد تسجيل الدخول، يظهر قسم "الطلبات" في الشريط الجانبي

---

## 5. طلبات التفعيل من التطبيق

### داخل التطبيق
- الشاشة متاحة من شاشة الإعدادات: "إرسال طلب تفعيل أو دعم للإدارة"
- يمكن الوصول إليها قبل امتلاك ترخيص (لا تتطلب جلسة)
- لا تُرسل فواتير أو مخزون أو نسخ احتياطية تلقائياً

### في الخادم
- `POST /api/activation-requests` — عام (لا تتطلب جلسة)، مع rate limiting
- `GET /api/activation-requests` — للأدمن فقط، مع تصفح وتصفية
- `GET /api/activation-requests/:id` — للأدمن فقط
- `POST /api/activation-requests/:id/status` — للأدمن فقط، يسجل هوية الأدمن والوقت

### في لوحة الأدمن
- قسم "الطلبات" في الشريط الجانبي
- الحالات: جديد / قيد المعالجة / مكتمل / مرفوض
- ملاحظات داخلية لا تظهر للعميل
- ربط الطلب بترخيص عند توافر هوية موثقة

**مهم:** قبول الطلب يغيّر حالة الطلب فقط، ولا ينشئ ترخيصاً تلقائياً. يجب على الأدمن إصدار الترخيص منفصلاً عبر `POST /api/admin/licenses`.

---

## 6. النسخ الاحتياطي (Google Drive)

- النسخ الاحتياطي يُرفع مباشرة من المتصفح إلى Google Drive (لا يمر عبر الخادم)
- الخادم يؤمّن فقط refresh token بشكل مشفر في PostgreSQL
- أقل النطاقات المطلوبة: `drive.file` فقط

---

## 7. SQL migrations

الملفات في `server/supabase/migrations/`، تُطبق حسب الترتيب:

1. `001_initial_schema.sql` — الجداول الأساسية (التراخيص، الجلسات، الحسابات)
2. `001_validation.sql` — التحقق من صحة البيانات
3. `002_align_live_schema.sql` — محاذاة الجداول للعقد الفعلي للمستودع
4. `003_activation_requests.sql` — جدول طلبات التفعيل (جديد، تراكمي لا يعدّل جداول موجودة)

---

## 8. خطة الرجوع (Rollback)

### قبل تطبيق migrations على قاعدة إنتاج
1. خذ نسخة احتياطية كاملة من قاعدة بيانات PostgreSQL.
2. طبّق migration في بيئة staging أولاً.
3. إذا حدث خطأ، استعد من النسخة الاحتياطية.

### بعد النشر
- لا تحذف جدول `activation_requests` إذا وصل طلبات حقيقية — الحفاظ على البيانات أولوية.
- يمكن تعطيل ميزة الطلبات بإزالة المسارات من الكود وإعادة النشر، دون حذف البيانات.
- لا تضف رجوعاً تلقائياً من full إلى interim عند تعطل الخادم — استخدم سياسة السماح المعتمدة.

### APK
- الاحتفاظ بـ APK قديم لا يضمن توافقه مع إصدار أحدث من IndexedDB.
- لا تزيل التطبيق من الأجهزة (هذا يمحو البيانات المحلية).
- بناء APK جديد يجب أن يحتفظ بنفس package ID (`com.saher.store`) ومفتاح التوقيع.

---

## 9. أوامر مفيدة

```bash
# تشغيل الاختبارات
cd server && npm test          # اختبارات الخادم
cd .. && node tests/run-all.mjs # جميع الاختبارات (الخادم + العميل)

# إنشاء قيمة سرية للـ pepper
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# فحص متغيرات البيئة المطلوبة
cat .env.example
```

---

## تحذير أمني

لا تضع أياً من هذه القيم في JavaScript العميل، APK، service worker، أو Git:
- `STOREHUB_PEPPER`
- `GOOGLE_CLIENT_SECRET`
- `SUPABASE_DB_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

هذه القيم تبقى على السيرفر فقط.
