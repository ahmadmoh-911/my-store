/**
 * Settings — store identity, preferences, data backup & restore, and about.
 *
 * Store data is deliberately three fields: name, owner, contact number. The
 * owner name is what the dashboard greets by, the number is what the receipt
 * hands back, and the shop name is on every printed page.
 *
 * Backup is the only "sync" mechanism for a single-device app: export a JSON
 * file, copy it anywhere, import it back to restore.
 */
import { icon } from '../icons.js';
import {
  el, fromHTML, clear, processImage, downloadBlob,
  pickFile, readFileAsText, debounce, isoDate,
} from '../utils.js';
import {
  getSettings, saveSettings, exportAll, importAll,
  listProducts, listSales, listSuppliers, listSupplierInvoices, listSupplierPayments, listPurchases,
  DB_NAME, DB_VERSION,
} from '../db.js';
import { getAppVersion } from '../version.js';
import { pageHead, celebrate, toast, confirmDialog } from '../components.js';
import { navigate } from '../router.js';
import { getBackupRecord, clearBackupRecord } from '../identity-store.js';
import { prepareRestore, applyRestore, describeBackup, BACKUP_FOLDER_NAME } from '../backup.js';
import {
  BACKUP_INTERVAL_DAYS,
  BACKUP_STATUS,
  daysUntilDue,
  performBackup,
  fetchPreparedBackup,
} from '../backup-scheduler.js';
import { getDriveStatus, getDriveAccessToken, disconnectDrive, connectDriveInPopup } from '../drive-auth-client.js';
import { getEntitlement, getEntitlementMessage, verifyAndUpdate, ENTITLEMENT_STATE } from '../entitlement.js';
import { activateLicense, bindLicense } from '../license-client.js';
import { getCurrentAccount } from '../auth-client.js';
import { isInterim } from '../build-config.js';
import { activationStatus, ACTIVATION_TTL_DAYS } from '../interim-activation.js';
import { runFileExport, runFileImport, backupReminderText } from '../data-transfer-ui.js';

export function render() {
  const root = el('div.screen', { id: 'screen-settings' });

  root.appendChild(
    pageHead({
      title: 'الإعدادات',
      sub: 'بيانات المتجر والتفضيلات والنسخ الاحتياطي',
    })
  );

  const host = el('div', { id: 'settings-host' });
  root.appendChild(host);
  host.appendChild(el('div.loading-row', {}, el('i.spinner.spinner--ink'), el('span', { text: 'جارٍ فتح الإعدادات…' })));

  boot(host);
  return root;
}

async function boot(host) {
  const s = await getSettings();
  if (!host.isConnected) return;
  clear(host);

  /* --- install banner ------------------------------------------------ */
  const deferred = window.__saherInstallPrompt;
  if (deferred && !s.installHintDismissed) {
    host.appendChild(
      el(
        'div.install-banner',
        {},
        fromHTML(icon('install')),
        el(
          'div.install-banner__txt',
          {},
          el('b', { text: 'ثبّت التطبيق على الشاشة الرئيسية' }),
          el('span', { text: 'يعمل بدون إنترنت وبواجهة ملء الشاشة' })
        ),
        el('button.btn.btn--brass', {
          type: 'button',
          text: 'تثبيت',
          onClick: async () => {
            deferred.prompt();
            await deferred.userChoice;
            window.__saherInstallPrompt = null;
            rebuild();
          },
        }),
        el('button.icon-btn', {
          type: 'button',
          'aria-label': 'إخفاء',
          style: 'color:#e7f4f0',
          onClick: async () => {
            await saveSettings({ installHintDismissed: true });
            rebuild();
          },
          html: icon('x'),
        })
      )
    );
  }

  /* --- 1 · store identity -------------------------------------------- *
   * Only three things belong to the shop's identity: what it is called, who
   * runs it, and how you reach them. The owner name is what the dashboard
   * greets them by; the number is what a receipt hands back. The logo and the
   * receipt footer moved down into Preferences rather than disappearing — both
   * were working features, only the grouping was wrong.
   * ------------------------------------------------------------------ */
  const nameInput = textInput(s.storeName, (v) => (s.storeName = v), 'مثال: محل النور');
  const ownerInput = textInput(s.ownerName, (v) => (s.ownerName = v), 'مثال: أحمد المصري');
  const phoneInput = textInput(s.phone, (v) => (s.phone = v), '05xxxxxxxx', 'ltr');

  // Three labelled rows, not three bare placeholders: with only these three
  // fields left in the group, an unlabelled box would leave the owner guessing
  // which one is which after the value clears.
  host.appendChild(
    group('store', 'بيانات المتجر', 'store', [
      row('اسم المتجر', 'يظهر أعلى كل فاتورة مطبوعة', nameInput),
      row('اسم صاحب المتجر', 'تظهر به في ترحيب الشاشة الرئيسية', ownerInput),
      row('رقم التواصل', 'يظهر أسفل كل فاتورة', phoneInput)
    ])
  );

  /* --- 2 · preferences ------------------------------------------------ */
  const openingInput = el('input.input.input--money', {
    type: 'number',
    min: '0',
    step: '1',
    placeholder: '0',
    value: String(s.openingBalance ?? 0),
    oninput: debounce((e) => {
      s.openingBalance = Math.max(0, Number(e.target.value) || 0);
    }, 260),
  });

  const pinInput = el('input.input', {
    type: 'text',
    inputmode: 'numeric',
    maxlength: '8',
    placeholder: '0000',
    value: s.editPin || '0000',
    style: 'max-width:120px;text-align:center;direction:ltr',
    oninput: debounce((e) => {
      s.editPin = e.target.value.replace(/\D/g, '') || '0000';
    }, 260),
  });

  const thresholdInput = el('input.input', {
    type: 'number',
    min: '0',
    value: String(s.lowStockThreshold),
    oninput: debounce((e) => {
      const v = Math.max(0, parseInt(e.target.value || '0', 10) || 0);
      s.lowStockThreshold = v;
    }, 260),
  });

  const footerInput = textInput(s.receiptFooter, (v) => (s.receiptFooter = v), 'عبارة أسفل الفاتورة');

  const logoSwitch = toggle(s.receiptShowLogo !== false, (on) => (s.receiptShowLogo = on));

  const logoBox = el('div.logo-row');
  function paintLogo() {
    clear(logoBox);
    if (s.logo) logoBox.appendChild(el('img.logo-preview', { src: s.logo, alt: '' }));
    else logoBox.appendChild(el('div.logo-preview.logo-preview-ph', { html: icon('hanger') }));

    logoBox.appendChild(
      el(
        'div',
        { style: 'display:grid;gap:8px;justify-items:start' },
        el(
          'div',
          {},
          el('button.btn.btn--sm.btn--soft', {
            type: 'button',
            onClick: async () => {
              const f = await pickFile('image/*');
              if (!f) return;
              s.logo = await processImage(f, 320, 0.85);
              paintLogo();
              toast('تم تحديث الشعار', 'ok');
            },
          }, fromHTML(icon('upload')), el('span', { text: s.logo ? 'تغيير الشعار' : 'رفع الشعار' })),
          s.logo
            ? el('button.btn.btn--sm.btn--ghost', { type: 'button', text: 'إزالة', onClick: () => { s.logo = ''; paintLogo(); } })
            : null
        ),
        el('span.tiny.muted', { text: 'PNG أو JPG · يظهر أعلى الفاتورة وأيقونة التطبيق' })
      )
    );
  }
  paintLogo();

  host.appendChild(
    group('settings', 'التفضيلات', 'sliders', [
      row('الرصيد الافتتاحي للمتجر', 'المال الموجود في المتجر قبل أول استخدام للتطبيق', openingInput),
      el('p.tiny.muted', {
        style: 'padding:0 15px 12px;margin:-6px 0 0',
        text: 'الرصيد العام للمتجر = الرصيد الافتتاحي + كل المبيعات − مشتريات تجديد الكمية. عدّله هنا فيظهر في التقارير فوراً.',
      }),
      row('حد التنبيه للنقص', 'يُعلَّم المنتج عند وصوله لهذا الرقم', thresholdInput),
      row('رمز تعديل الكميات', 'مطلوب لتغيير مقاسات وألوان وكميات منتج قائم', pinInput),
      row('شعار في الفاتورة', 'إظهار الشعار أعلى نسخة الطباعة', logoSwitch),
      el('div.settings-body', {}, logoBox, el('div', { style: 'height:14px' }), footerInput)
    ])
  );

  /* --- 3 · data & backup ---------------------------------------------- *
   * The backup is a plain JSON file of every store this app keeps, so a second
   * device that imports it is byte-for-byte the same shop. `purchases` is in
   * the list because restock records are what the store balance is derived
   * from — a restore without them would show the right stock and the wrong cash.
   * ------------------------------------------------------------------ */
  const stats = await Promise.all([
    listProducts(), listSales(), listSuppliers(), listSupplierInvoices(), listSupplierPayments(), listPurchases(),
  ]);
  const [products, sales, suppliers, supInvoices, supPayments, purchases] = stats;
  const sizeEst = JSON.stringify({ products, sales, suppliers, supInvoices, supPayments, purchases }).length;
  const sizeLabel = sizeEst > 1024 * 1024 ? `${(sizeEst / 1048576).toFixed(1)} م.ب` : `${Math.max(1, Math.round(sizeEst / 1024))} ك.ب`;

  host.appendChild(
    group('database', 'البيانات والنسخ الاحتياطي', 'database', [
      el(
        'div.settings-body',
        {},
        el(
          'div',
          { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-bottom:9px;text-align:center' },
          statBox(String(products.length), 'منتج'),
          statBox(String(sales.length), 'فاتورة بيع'),
          statBox(String(suppliers.length), 'مورد')
        ),
        el(
          'div',
          { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-bottom:15px;text-align:center' },
          statBox(String(supInvoices.length), 'فاتورة شراء'),
          statBox(String(supPayments.length), 'دفعة'),
          statBox(String(purchases.length), 'تجديد كمية')
        ),
        el('p.tiny.muted', { style: 'margin-bottom:13px', text: `حجم البيانات الحالي تقريباً: ${sizeLabel}. كل شيء محفوظ محلياً في هذا الجهاز فقط.` }),
        backupReminderText() ? el('p.field__hint', { style: 'color:var(--brass-deep);margin-bottom:10px', text: backupReminderText() }) : null,
        el(
          'div.export-row',
          {},
          el('button.btn.btn--primary', { type: 'button', onClick: (e) => doExport(e.currentTarget) }, fromHTML(icon('download')), el('span', { text: 'تصدير نسخة احتياطية (ملف)' })),
          el('button.btn.btn--soft', { type: 'button', onClick: (e) => doImport(e.currentTarget) }, fromHTML(icon('upload')), el('span', { text: 'استيراد نسخة احتياطية' }))
        ),
        el('p.tiny.muted', {
          style: 'margin-top:11px',
          text: 'الملف يشمل كل جداول التطبيق تلقائياً: المنتجات والمقاسات والألوان والكميات ودفعات المخزون وفواتير البيع والمرتجعات والموردين وفواتير الشراء والدفعات وعمليات تجديد الكمية والإعدادات والصور، مع أعداد كل جدول والمجاميع المالية وبصمة تحقق (SHA-256).',
        })
      )
    ])
  );

  /* --- 3b · Google Drive backup ----------------------------------------
   *
   * A new group beside the file-based one rather than a new screen, because
   * this is the same job with a different destination. Everything the shop owner
   * needs to answer — is it connected, when did it last work, is anything wrong,
   * how do I get my data back — lives in the same list as the export button they
   * already know.
   *
   * Note the language throughout: "backup", never "sync". Nothing here merges or
   * pushes, and the copy says so, because a shop owner who thinks their data is
   * synchronised will make decisions that an offline-first app cannot honour.
   */

  // Declared before the group is built: these two nodes are handed to `el()` as
  // children, and a `const` read before its declaration is a ReferenceError, not
  // an undefined value. They are stable nodes whose children get replaced, so a
  // repaint never yanks a button out from under a click.
  const driveStatusLine = el('div.drive-status');
  const driveActions = el('div.export-row');

  /** The data-layer shape `backup.js` and the scheduler expect. */
  const dbApi = { exportAll, importAll };

  /** Last known state; `null` until the first read completes. */
  let drive = null;
  let driveRecord = null;

  // Interim build: there is no server, so the Drive group would only ever show
  // a connection error. It is not rendered at all rather than rendered broken —
  // and no network call is made for it.
  if (!isInterim()) host.appendChild(
    group('drive', `النسخ الاحتياطي في Google Drive`, 'database', [
      el(
        'div.settings-body',
        {},
        driveStatusLine,
        el('p.tiny.muted', {
          style: 'margin-bottom:12px',
          text:
            `تُحفظ نسخة كاملة واحدة في مجلد "${BACKUP_FOLDER_NAME}" داخل حسابك في Google Drive، ` +
            `ويتم استبدالها مرة كل ${BACKUP_INTERVAL_DAYS} أيام بعد نجاح النسخ السابق فقط. ` +
            'هذا نسخ احتياطي وليس مزامنة: البيانات تبقى على هذا الجهاز، ولا يغادره شيء سوى ملف النسخة.',
        }),
        driveActions,
        el('p.tiny.muted', {
          style: 'margin-top:11px',
          text: 'صور المنتجات وشعار المتجر لا تُضمَّن في النسخة الاحتياطية عن قصد، ولا يمكن استعادتها منها.',
        }),
      ),
    ]),
  );

  /* --- 3c · licence ----------------------------------------------------
   *
   * The same job this screen already does for Google Drive, for the other
   * question the owner has: "is this device allowed to sell?" It shows the
   * decision the checkout path will make, in words, and offers the one action
   * that can change it — entering a licence code. It never computes
   * entitlement itself; `getEntitlement` is the single source of truth and this
   * group only renders its answer.
   * ------------------------------------------------------------------ */
  const licenceStatusLine = el('div.licence-status');
  const licenceActions = el('div.export-row');
  let entitlement = null;

  // Interim build: replace the licence group with the local date-code status.
  // No network, no Google, no licence server — just "how many days are left"
  // and where to get a new code.
  if (isInterim()) {
    const st = activationStatus();
    const daysText = st.active
      ? `متبقٍ ${st.daysRemaining} يوماً من أصل ${ACTIVATION_TTL_DAYS}.`
      : st.reason === 'expired'
        ? 'انتهت صلاحية التفعيل.'
        : st.reason === 'clock'
          ? 'تاريخ الجهاز غير صحيح أو تم إرجاعه إلى الوراء.'
          : 'لم يُفعَّل بعد.';
    host.appendChild(
      group('interim-activation', 'التفعيل (نسخة مؤقتة)', 'checkCircle', [
        el('div.settings-body', {},
          el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px' },
            el('b', { text: st.active ? `مفعّلة — ${st.daysRemaining} يوم` : 'غير مفعّلة' }),
            el('span.tiny.muted', { text: daysText })),
          el('button.btn.btn--soft', { type: 'button', onClick: () => navigate('interim') },
            fromHTML(icon('checkCircle')), el('span', { text: 'إدخال كود التفعيل' })),
        ),
      ]),
    );
  }

  if (!isInterim()) host.appendChild(
    group('licence', 'الترخيص والتسجيل', 'checkCircle', [
      el('div.settings-body', {}, licenceStatusLine, licenceActions),
    ]),
  );

  /** Arabic label for an entitlement state, for the bold status word. */
  function licenceStateLabel(state) {
    switch (state) {
      case ENTITLEMENT_STATE.ACTIVE: return 'الترخيص نشط';
      case ENTITLEMENT_STATE.ACTIVE_NEEDS_VERIFICATION: return 'نشط — يحتاج تحقق';
      case ENTITLEMENT_STATE.OFFLINE_GRACE: return 'نشط (بدون اتصال)';
      case ENTITLEMENT_STATE.OFFLINE_GRACE_EXPIRED: return 'انتهت فترة السماح';
      case ENTITLEMENT_STATE.UNACTIVATED: return 'غير مفعّل';
      case ENTITLEMENT_STATE.UNAUTHENTICATED: return 'غير مسجَّل';
      case ENTITLEMENT_STATE.ACCOUNT_MISMATCH: return 'حساب مختلف';
      case ENTITLEMENT_STATE.SUSPENDED: return 'معلّق';
      case ENTITLEMENT_STATE.EXPIRED: return 'منتهي';
      case ENTITLEMENT_STATE.REVOKED: return 'ملغى';
      case ENTITLEMENT_STATE.CLOCK_SUSPECT: return 'ساعة غير موثوقة';
      default: return 'حالة الترخيص';
    }
  }

  async function refreshLicence() {
    try {
      entitlement = await getEntitlement();
    } catch (err) {
      console.error('[settings] entitlement read failed', err);
      entitlement = null;
    }
    try {
      await paintLicence();
    } catch (err) {
      console.error('[settings] licence paint failed', err);
    }
  }

  async function paintLicence() {
    clear(licenceStatusLine);
    clear(licenceActions);

    if (!entitlement) {
      licenceStatusLine.appendChild(el('p.tiny.muted', { text: 'تعذّر قراءة حالة الترخيص.' }));
      return;
    }

    licenceStatusLine.appendChild(
      el(
        'div',
        { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px' },
        el('b', { text: licenceStateLabel(entitlement.state) }),
        el('span.tiny.muted', { text: await getEntitlementMessage() }),
      ),
    );

    const lic = entitlement.license;
    if (lic?.licenseId) {
      const expiry = lic.expiresAt
        ? new Date(lic.expiresAt).toLocaleDateString('ar', { dateStyle: 'medium' })
        : 'بلا انتهاء';
      licenceStatusLine.appendChild(
        el('p.tiny.muted', { style: 'margin:0 0 4px', text: `معرّف الترخيص: ${lic.licenseId}` }),
      );
      licenceStatusLine.appendChild(
        el('p.tiny.muted', { style: 'margin:0 0 4px', text: `تاريخ الانتهاء: ${expiry}` }),
      );
    }

    if (entitlement.canSell) {
      licenceActions.appendChild(
        el('button.btn.btn--soft', { type: 'button', onClick: (e) => doVerifyLicence(e.currentTarget) },
          el('span', { text: 'تحقق الآن' })),
      );
    } else {
      licenceActions.appendChild(
        el('button.btn.btn--primary', { type: 'button', onClick: (e) => doActivateLicence(e.currentTarget) },
          fromHTML(icon('checkCircle')), el('span', { text: 'تفعيل الترخيص' })),
      );
    }
  }

  /** Runs a licence action behind a spinner, then repaints the group. */
  async function withLicenceBusy(btn, label, fn) {
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `${fromHTML(icon('spinner'))}<span>${label}</span>`;
    }
    try {
      await fn();
    } catch (err) {
      console.error(err);
      toast(err?.message || 'تعذّر إتمام العملية', 'err');
    } finally {
      await refreshLicence();
    }
  }

  async function doActivateLicence(btn) {
    const entered = prompt('أدخل كود الترخيص');
    if (!entered) return;
    await withLicenceBusy(btn, 'جارٍ التفعيل…', async () => {
      const res = await activateLicense(entered.trim());
      if (!res.ok) {
        toast(res.error?.message || 'تعذّر تفعيل الترخيص', 'err');
        return;
      }

      // A licence only turns the badge green once it is tied to a signed-in
      // Google account: `getEntitlement` reports UNAUTHENTICATED with
      // `canSell: false` while there is no account, no matter how valid the
      // code is. So activation is not "done" until the code is bound to the
      // account. The screen used to toast "تم تفعيل الترخيص" here and stop,
      // which is how a store could see a success message next to a badge that
      // still read "غير مسجَّل" and a checkout that still refused to sell.
      let account = null;
      try {
        account = await getCurrentAccount();
      } catch { /* treat a failed lookup as "not signed in" */ }

      if (!account?.googleSub) {
        // Activation itself succeeded; the licence is cached. Send the owner to
        // the screen that owns Google sign-in so the badge can actually flip.
        toast('تم تفعيل الكود — سجّل الدخول بـ Google لإتمام التفعيل', 'warn');
        navigate('activate');
        return;
      }

      // Binding ties the licence to the account so the entitlement engine will
      // report ACTIVE / canSell. It is still best-effort: activation already
      // succeeded, and a later launch retries.
      let bound = false;
      try {
        const bind = await bindLicense(account.googleSub);
        bound = Boolean(bind?.ok);
      } catch { /* keep the successful activation */ }

      if (bound) toast('تم تفعيل الترخيص', 'ok');
      else toast('تم تفعيل الكود، لكن تعذّر ربطه بالحساب — أعد المحاولة', 'err');
    });
  }

  async function doVerifyLicence(btn) {
    await withLicenceBusy(btn, 'جارٍ التحقق…', async () => {
      const { verificationResult } = await verifyAndUpdate();
      if (verificationResult?.ok) toast('الترخيص سليم', 'ok');
      else toast(verificationResult?.error?.message || 'تعذّر التحقق من الترخيص', 'err');
    });
  }

  /* --- 4 · about ------------------------------------------------------- */
  const wa = (number, label) =>
    el(
      'a.about-wa',
      { href: `https://wa.me/${number}`, target: '_blank', rel: 'noopener' },
      fromHTML(icon('phone')),
      el('span.about-wa__num', { text: `+${number}` }),
      el('span.tiny.muted', { text: label })
    );

  host.appendChild(
    group('about', 'حول التطبيق', 'info', [
      el(
        'div.about',
        {},
        el('b', { text: 'Store Hub' }),
        el('div', { text: 'نظام إدارة متجر الملابس — مخزون، بيع، عملاء وتقارير.' }),
        el('div', { style: 'margin-top:6px', html: `البيانات محفوظة محلياً (IndexedDB · إصدار ${DB_VERSION}) ولا تغادر جهازك.` }),
        el('div', { style: 'margin-top:6px', text: `التخزين: ${DB_NAME}` }),
        el('div', { style: 'margin-top:6px', text: `إصدار التطبيق: ${getAppVersion()}` })
      ),
      el(
        'div.about-credits',
        {},
        el('div.about-credits__row', {},
          fromHTML(icon('pencil')),
          el('b', { text: 'برمجة وتطوير: أحمد المصري & إبراهيم خلف' })
        ),
        el('div.about-credits__label.tiny.muted', { text: 'للتواصل والدعم:' }),
        el('div.about-credits__row.about-credits__row--wa', {}, wa('972598191325', 'أحمد المصري'), wa('972568802803', 'إبراهيم خلف')),
        el('button.btn.btn--soft', {
          type: 'button',
          text: 'إرسال طلب تفعيل أو دعم للإدارة',
          onClick: () => navigate('activation-request'),
        }),
        el('div.about-credits__brand', { text: 'managed by :  Ahmad & Ibrheam' })
      )
    ])
  );

  host.appendChild(el('div', { style: 'height:8px' }));

  /* --- actions ---------------------------------------------------------- */

  function rebuild() {
    clear(host);
    boot(host);
  }

  async function persist() {
    if (!s.storeName.trim()) {
      toast('اسم المتجر مطلوب', 'err');
      return;
    }
    await saveSettings({
      storeName: s.storeName.trim(),
      ownerName: s.ownerName.trim(),
      phone: s.phone.trim(),
      openingBalance: Math.max(0, Number(s.openingBalance) || 0),
      editPin: String(s.editPin || '0000').replace(/\D/g, '') || '0000',
      lowStockThreshold: Number(s.lowStockThreshold) || 0,
      receiptFooter: s.receiptFooter.trim(),
      receiptShowLogo: s.receiptShowLogo,
      logo: s.logo,
    });
    await celebrate({ title: 'تم حفظ الإعدادات', sub: s.storeName, confetti: false, ms: 1050 });
    document.querySelectorAll('.store-pill__name').forEach((n) => (n.textContent = s.storeName));
  }

  const saveBtn = el(
    'button.btn.btn--primary.btn--lg',
    { type: 'button', onClick: persist },
    fromHTML(icon('check')),
    el('span', { text: 'حفظ الإعدادات' })
  );
  host.appendChild(el('div.form-actions', {}, saveBtn));

  /**
   * File export/import now go through js/data-transfer.js — the versioned,
   * fingerprinted, all-or-nothing format. The old `exportAll()`/`prepareRestore`
   * path is kept only for the Google Drive group above (which uploads the same
   * logical snapshot `backup.js` has always produced).
   *
   * Both delegate their own busy state, verification and summary dialogs, so a
   * failure can never be reported as a success here.
   */
  async function doExport(btn) {
    await runFileExport({ button: btn });
  }

  async function doImport(btn) {
    await runFileImport({ button: btn });
  }

  /* ------------------------------------------------------------------ *
   * Google Drive backup
   * ------------------------------------------------------------------ */

  /**
   * Reads the two facts the screen shows and repaints.
   *
   * Both reads are local-or-trivial and neither is allowed to throw into the
   * page: a Settings screen that fails to paint because a backup service is
   * unreachable would be a worse bug than the one it reports.
   */
  async function refreshDrive() {
    try {
      driveRecord = await getBackupRecord();
    } catch {
      driveRecord = null;
    }
    try {
      drive = await getDriveStatus();
    } catch {
      // Treated as "cannot tell" rather than "not connected": an unreachable
      // backend must not offer a button that will only fail.
      drive = { connected: false, configured: false, scope: null, folderName: BACKUP_FOLDER_NAME, enabled: true, unknown: true };
    }
    paintDrive();
  }

  /** A human date, or a plain dash when there is nothing to show. */
  function whenText(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('ar', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function paintDrive() {
    clear(driveStatusLine);
    clear(driveActions);

    if (drive?.unknown) {
      driveStatusLine.appendChild(
        el('p.tiny.muted', { text: 'تعذّر قراءة حالة Google Drive — سيُعاد المحاولة عند فتح الإعدادات.' }),
      );
      return;
    }

    if (!drive?.enabled) {
      driveStatusLine.appendChild(el('p.tiny.muted', { text: 'النسخ الاحتياطي عبر Google Drive معطّل على هذا الخادم.' }));
      return;
    }

    const lastSuccess = driveRecord?.lastSuccessAt || null;
    const due = daysUntilDue(driveRecord, Date.now());
    const failed = driveRecord?.status === BACKUP_STATUS.ERROR;

    // Connection state first: everything else is conditional on it.
    driveStatusLine.appendChild(
      el(
        'div',
        { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px' },
        el('b', { text: drive?.connected ? 'Google Drive متصل' : 'Google Drive غير متصل' }),
        el('span.tiny.muted', { text: drive?.connected ? `المجلد: ${drive.folderName}` : 'اربط حسابك لتبدأ النسخ الاحتياطي التلقائي.' }),
      ),
    );

    if (drive?.connected) {
      const nextLine =
        lastSuccess === null
          ? 'لم تُنجَز نسخة احتياطية بعد — ستُجرى عند أول تشغيل بعد الربط.'
          : due === 0
            ? 'نسخة احتياطية مستحقة الآن.'
            : `النسخة الاحتياطية التالية بعد ${due} يوم.`;
      driveStatusLine.appendChild(
        el('p.tiny.muted', { style: 'margin:0 0 4px', text: `آخر نسخة ناجحة: ${whenText(lastSuccess)}` }),
      );
      driveStatusLine.appendChild(el('p.tiny.muted', { style: 'margin:0 0 4px', text: nextLine }));
    }

    // A failure is the one thing worth making loud. A quiet launch in a shop
    // with no signal is normal; a backup that has been failing for three weeks
    // is not, and silence here would hide it indefinitely.
    if (failed && driveRecord?.lastError) {
      driveStatusLine.appendChild(
        el(
          'div.drive-status__error',
          {},
          el('b', { text: 'فشلت آخر محاولة نسخ احتياطي' }),
          el('p.tiny', { style: 'margin:4px 0 0', text: String(driveRecord.lastError).slice(0, 200) }),
          el('p.tiny.muted', { style: 'margin:4px 0 0', text: 'بياناتك المحلية لم تتأثر، والنسخة السابقة في Drive لم تُحذف. ستُعاد المحاولة تلقائياً.' }),
        ),
      );
    }

    if (drive?.connected) {
      driveActions.appendChild(
        el('button.btn.btn--primary', { type: 'button', onClick: (e) => doDriveBackup(e.currentTarget) },
          fromHTML(icon('upload')), el('span', { text: 'نسخ احتياطي الآن' })),
      );
      driveActions.appendChild(
        el('button.btn.btn--soft', { type: 'button', onClick: (e) => doDriveRestore(e.currentTarget) },
          fromHTML(icon('download')), el('span', { text: 'استعادة من Google Drive' })),
      );
      driveActions.appendChild(
        el('button.btn.btn--ghost', { type: 'button', onClick: (e) => doDriveDisconnect(e.currentTarget) },
          el('span', { text: 'فصل Google Drive' })),
      );
    } else {
      driveActions.appendChild(
        el('button.btn.btn--primary', { type: 'button', onClick: (e) => doDriveConnect(e.currentTarget) },
          fromHTML(icon('save')), el('span', { text: 'ربط Google Drive' })),
      );
    }
  }

  /** Wraps a button click so it shows a spinner and cannot be double-fired. */
  async function busy(btn, label, fn) {
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `${fromHTML(icon('spinner'))}<span>${label}</span>`;
    }
    try {
      await fn();
    } catch (err) {
      console.error(err);
      toast(err?.message || 'تعذّر إتمام العملية', 'err');
    } finally {
      await refreshDrive();
      if (btn) btn.disabled = false;
    }
  }

  async function doDriveConnect(btn) {
    await busy(btn, 'جارٍ الربط…', async () => {
      let connected = false;
      try {
        connected = await connectDriveInPopup();
      } catch (err) {
        toast(err?.message || 'تعذّر ربط Google Drive', 'err');
      }
      // Re-read the real state rather than trusting the popup's message: the
      // backend is the only thing that knows whether a grant exists.
      const status = await getDriveStatus().catch(() => null);
      if (status?.connected) {
        toast('تم ربط Google Drive', 'ok');
      } else if (connected) {
        toast('تم الربط', 'ok');
      }
    });
  }

  async function doDriveDisconnect(btn) {
    const yes = await confirmDialog({
      title: 'فصل Google Drive؟',
      message: 'سيتوقف Store Hub عن إنشاء النسخ الاحتياطية. النسخة الموجودة في مجلدك لن تُحذف.',
      confirmLabel: 'فصل',
    });
    if (!yes) return;
    await busy(btn, 'جارٍ الفصل…', async () => {
      const { wasConnected } = await disconnectDrive();
      // Only the local bookkeeping is cleared. The customer's file in Drive is
      // untouched — forgetting when we last backed up must never look like
      // permission to remove their backup.
      await clearBackupRecord();
      toast(wasConnected ? 'تم فصل Google Drive' : 'لم يكن Google Drive متصلاً', 'ok');
    });
  }

  async function doDriveBackup(btn) {
    await busy(btn, 'جارٍ النسخ…', async () => {
      const { accessToken } = await getDriveAccessToken();
      const result = await performBackup({ db: dbApi, accessToken });
      await (await import('../identity-store.js')).saveBackupRecord({
        status: BACKUP_STATUS.OK,
        lastSuccessAt: result.createdAt,
        lastAttemptAt: new Date().toISOString(),
        lastError: null,
        folderId: result.folderId,
        fileId: result.fileId,
        bytes: result.bytes,
        counts: result.counts,
      });
      toast('تم إنشاء النسخة الاحتياطية', 'ok');
    });
  }

  async function doDriveRestore(btn) {
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `${fromHTML(icon('spinner'))}<span>جارٍ التحقق…</span>`;
    }
    try {
      const { accessToken } = await getDriveAccessToken();
      const fetched = await fetchPreparedBackup({ accessToken });
      if (!fetched.ok) {
        toast(fetched.message || 'لا توجد نسخة احتياطية صالحة', 'err');
        return;
      }

      const summary = describeBackup(fetched.prepared);
      const created = whenText(fetched.prepared.createdAt);

      // Explicit confirmation, and it names what is about to be destroyed.
      // Restore is never automatic — §9, and the only real defence against a
      // restore nobody asked for.
      const yes = await confirmDialog({
        title: 'استعادة من Google Drive؟',
        message:
          `النسخة المؤرخة ${created} تحتوي على ${summary.products} منتج · ${summary.sales} فاتورة بيع · ` +
          `${summary.suppliers} مورد · ${summary.supplierInvoices} فاتورة شراء. ` +
          'سيُستبدل المحتوى الحالي بالكامل ولا يمكن التراجع.',
        confirmLabel: 'استعادة',
      });
      if (!yes) return;

      await applyRestore(dbApi, fetched.prepared);
      await celebrate({ title: 'تمت الاستعادة', sub: `${summary.products} منتج · ${summary.sales} فاتورة`, ms: 1300 });
      navigate('dashboard');
      setTimeout(() => location.reload(), 400);
    } catch (err) {
      console.error(err);
      toast(err?.message || 'تعذّرت الاستعادة', 'err');
    } finally {
      await refreshDrive();
      if (btn) btn.disabled = false;
    }
  }

  async function doImport(btn) {
    await runFileImport({ button: btn });
  }

  /* The whole "danger zone" group is gone — the spec asks for it to be
     deleted outright, with nothing in its place. Wiping a shop is no longer
     one careless tap away from the settings screen; the backup file is the
     only thing that moves data, and it only ever moves it somewhere safe. */

  // Drive state is read last and deliberately not awaited: the screen is
  // already usable, and the two facts it adds — connected, last backup — should
  // appear when they arrive rather than hold the whole page for a network call
  // that may be to an unreachable server.
  //
  // In the interim build there is no server at all: the group is not drawn and
  // this is not called, so the screen makes NO network request.
  if (!isInterim()) refreshDrive();

  // Licence state is a local computation (no network), but it is still painted
  // after the screen rather than awaited, so a slow IndexedDB read can never
  // hold Settings hostage. The interim build uses the gate group instead.
  if (!isInterim()) refreshLicence();
}

/* ------------------------------------------------------------------ *
 * Small builders
 * ------------------------------------------------------------------ */

function group(id, title, iconName, children) {
  return el(
    'section.settings-group',
    { id: `settings-${id}` },
    el('div.settings-group__head', {}, fromHTML(icon(iconName)), el('h3', { text: title })),
    ...children
  );
}

function row(label, hint, control) {
  return el(
    'div.setting-row',
    {},
    el('div.setting-row__main', {}, el('div.setting-row__label', { text: label }), hint ? el('div.setting-row__hint', { text: hint }) : null),
    el('div.setting-row__ctrl', {}, control)
  );
}

function statBox(value, label) {
  return el(
    'div',
    { style: 'padding:11px 6px;border-radius:12px;background:var(--surface-dim)' },
    el('div', { style: 'font-size:19px;font-weight:700;font-family:var(--font-display)', text: value }),
    el('div', { style: 'font-size:11px;color:var(--ink-3);margin-top:2px', text: label })
  );
}

function textInput(value, onChange, placeholder, cls = '') {
  return el('input.input', {
    type: 'text',
    value: value ?? '',
    placeholder: placeholder || '',
    class: cls,
    oninput: debounce((e) => onChange(e.target.value), 200),
  });
}

function toggle(on, onChange) {
  const node = el(`button.switch${on ? '.is-on' : ''}`, {
    type: 'button',
    role: 'switch',
    'aria-checked': String(on),
    onClick: () => {
      const next = !node.classList.contains('is-on');
      node.classList.toggle('is-on', next);
      node.setAttribute('aria-checked', String(next));
      onChange(next);
    },
  });
  return node;
}

export default { render };
