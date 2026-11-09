# جدول متغيرات البيئة المطلوبة للخادم (بناءً على الكود الفعلي)

| المتغير | الغرض | مطلوب لأي وضع | سري؟ | من أين تُحصل عليه | الحالة |
|--------|------|---------------|-----|-------------------|--------|
| `SUPABASE_DB_URL` | اتصال PostgreSQL المباشر (Supabase pooler) — السيرفر يرفض التشغيل بدونه | full / production | نعم | لوحة Supabase → Settings → Database → Connection string | مفقود (مثال فقط في .env) |
| `SUPABASE_URL` | يُقرأ في الإعدادات ولكن لا يُستخدم لبناء الاتصال بقاعدة البيانات | اختياري | لا | لوحة Supabase → Settings → API | مفقود |
| `SUPABASE_SERVICE_ROLE_KEY` | يُقرأ في الإعدادات ولكن لا يُستخدم للاتصال بقاعدة البيانات | اختياري | نعم | لوحة Supabase → Settings → API | مفقود |
| `GOOGLE_CLIENT_ID` | معرف عميل OAuth لـ Google (ويب أو Android) | full مع تفعيل Google | لا (عام) | Google Cloud Console → Credentials → OAuth client | مفقود |
| `GOOGLE_CLIENT_SECRET` | سر عميل OAuth — côté السيرفر فقط | full مع تفعيل Google | نعم | Google Cloud Console → Credentials → OAuth client | مفقود |
| `GOOGLE_AUTH_REDIRECT_URI` | callback لتسجيل دخول العميل | الإنتاج | لا | يُحدّد من المشغّل ويُسجّل في Google Cloud | مفقود |
| `GOOGLE_ADMIN_REDIRECT_URI` | callback لتسجيل دخول الأدمن | الإنتاج | لا | يُحدّد من المشغّل ويُسجّل في Google Cloud | مفقود |
| `GOOGLE_DRIVE_REDIRECT_URI` | callback لربط Google Drive | الإنتاج | لا | يُحدّد من المشغّل ويُسجّل في Google Cloud | مفقود |
| `GOOGLE_REDIRECT_URI` | callback احتياطي مشترك للتطوير فقط | التطوير فقط | لا | يُحدّد من المشغّل | مفقود |
| `STOREHUB_PEPPER` | يُخلط مع توقيعات أكواد التراخيص (scrypt) | الإنتاج (16+ حرف) | نعم | يُولّد محلياً: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` | مفقود |
| `STOREHUB_ADMIN_SUB` | قائمة حسابات Google المخوّلة (sub values) لدخول الأدمن | الإنتاج | لا | يُستخرج من `sub` في رمز الهوية (ID token) بعد تسجيل دخول Google | مفقود |
| `STOREHUB_ADMIN_PORTAL_URL` | cara عودة الأدمن بعد تسجيل الدخول من Google | إذا استُخدمت الأدمن | لا | نطاق لوحة الأدمن الفعلي | مفقود |
| `STOREHUB_DRIVE_FOLDER` | اسم المجلد في Google Drive للنسخ الاحتياطي | اختياري (افتراضي: Store Hub Backups) | لا | يُحدّد من المشغّل | غير مضبوط (الافتراضي يُستخدم) |
| `STOREHUB_DRIVE_PEPPER` | **غير مستخدم في الكود الحالي** — Drive تُغلق بـ STOREHUB_PEPPER | غير مستخدم | لا | — | غير مطلوب (حذف من .env.example) |
| `PORT` | منفذ الاستماع للسيرفر | لا (افتراضي 8787) | لا | متغير بيئة الاستضافة | موجود (8787) |
| `HOST` | عنوان الاستماع | لا (افتراضي 127.0.0.1) | لا | متغير بيئة الاستضافة | موجود (127.0.0.1) |
| `STOREHUB_CORS_ORIGINS` | قائمة المصادر المسموحة بـ CORS مع اعتماد | إذا كان النطاق مختلفاً عن السيرفر | لا | نطاقات التطبيق والأدمن | غير مضبوط (فارغ = لا源 خارجي) |
| `STOREHUB_TRUST_PROXY` | ثقة في رأس X-Forwarded-For لتقسيم المعدلات خلف البروكسي | فقط خلف بروكسي موثوق | لا | إعداد الاستضافة | موجود (0 = موقف) |
| `STOREHUB_RATE_WINDOW_MS` | نافذة זמן لتقسيم المعدلات | لا | لا | إعداد المشغّل | موجود (900000 = 15 دقيقة) |
| `STOREHUB_RATE_MAX_ACTIVATE` | الحد الأقصى لطلبات التفعيل في النافذة | لا | لا | إعداد المشغّل | موجود (20) |
| `STOREHUB_RATE_MAX_VERIFY` | الحد الأقصى لطلبات التحقق في النافذة | لا | لا | إعداد المشغّل | موجود (120) |
| `STOREHUB_SESSION_TTL_MS` | مدة صلاحية جلسة المستخدم | لا | لا | إعداد المشغّل | موجود (30 يوماً) |
| `STOREHUB_SESSION_COOKIE` | اسم ملف تعريف الارتباط للجلسة | لا | لا | إعداد المشغّل | موجود (storehub_session) |

## أنواع عملاء OAuth المطلوبة (بناءً على التنفيذ الفعلي)

التطبيق يستخدم تدفق ويب مع المتصفح النظامي (system browser / Chrome Custom Tabs) وليس WebView مدمج. لذلك:

1. **OAuth Client type: Web application** — لتسجيل الدخول عبر المتصفح (الويب والأدمن).
   - Authorized redirect URIs:
     - `https://yourdomain.com/api/auth/google/callback`
     - `https://yourdomain.com/api/admin/auth/callback`
     - `https://yourdomain.com/api/drive/connect/callback`

2. **Android**: Capacitor يفتح المتصفح النظامي. في التطوير يمكن استخدام `http://localhost` مع porte محددة،但在 الإنتاج需要 등록 URI حقيقي بـ HTTPS وتسجيل Asset Links (`assetlinks.json`) لاعتراض التوجيه.

3. **JavaScript Secret**: clientSecret لا يوضع أبداً في تطبيق العميل أو APK أو service worker — 남은 على السيرفر فقط.

## مسارات callback الفعلية في الكود

| المسار | الغرض | उपयोग |
|--------|------|--------|
| `/api/auth/google/callback` | استكمال تسجيل دخول العميل | يُستدعى من المتصفح بعد موافقة Google |
| `/api/admin/auth/callback` | استكمال تسجيل دخول الأدمن | يُستدعى من المتصفح بعد موافقة Google |
| `/api/drive/connect/callback` | استكمال ربط Google Drive | يُستدعى من نافذة منبثقة (popup) |
| `/api/health` | فحص صحة السيرفر (لا أسرار) | مراقب الاستضافة |
| `/api/ready` | فحص جهوزية السيرفر (قاعدة البيانات) | مراقب الاستضافة |
