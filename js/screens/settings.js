/**
 * Settings — store identity, currency/threshold, data backup & restore,
 * PWA install and the destructive "clear everything" action.
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
  getSettings, saveSettings, exportAll, importAll, clearAll,
  listProducts, listSales, listSuppliers, listSupplierInvoices, listSupplierPayments,
  DB_NAME, DB_VERSION,
} from '../db.js';
import { pageHead, confirmDialog, celebrate, toast } from '../components.js';
import { navigate } from '../router.js';

export function render() {
  const root = el('div.screen', { id: 'screen-settings' });

  root.appendChild(
    pageHead({
      title: 'الإعدادات',
      sub: 'هوية المتجر، العملة والنسخ الاحتياطي',
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

  /* --- 1 · store identity -------------------------------------------- */
  const nameInput = textInput(s.storeName, (v) => (s.storeName = v), 'اسم المتجر (يظهر في الفواتير)');
  const ownerInput = textInput(s.ownerName, (v) => (s.ownerName = v), 'اسم صاحب المتجر (تظهر به في الرئيسية)');
  const taglineInput = textInput(s.storeTagline, (v) => (s.storeTagline = v), 'وصف قصير');
  const phoneInput = textInput(s.phone, (v) => (s.phone = v), 'رقم التواصل', 'ltr');
  const addressInput = textInput(s.address, (v) => (s.address = v), 'العنوان');

  const logoPreview = el('img.logo-preview', { src: s.logo || '', alt: '' });
  if (!s.logo) {
    logoPreview.replaceWith(
      el('div.logo-preview.logo-preview-ph', { html: icon('hanger') })
    );
  }

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
    group('store', 'بيانات المتجر', 'store', [
      el('div.settings-body', {},
        logoBox,
        el('div', { style: 'height:14px' }),
        el('div.grid-2', {}, nameInput, ownerInput),
        el('div.grid-2', {}, taglineInput, phoneInput),
        el('div.grid-2', {}, addressInput)
      )
    ])
  );

  /* --- 2 · preferences ------------------------------------------------ */
  const currencyInput = textInput(s.currency, (v) => (s.currency = v), 'رمز العملة', 'ltr');
  currencyInput.style.maxWidth = '140px';
  currencyInput.style.textAlign = 'center';

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

  host.appendChild(
    group('settings', 'التفضيلات', 'sliders', [
      row('العملة', 'تظهر بجانب كل الأسعار', currencyInput),
      row('حد التنبيه للنقص', 'يُعلَّم المنتج عند وصوله لهذا الرقم', thresholdInput),
      row('شعار في الفاتورة', 'إظهار الشعار أعلى نسخة الطباعة', logoSwitch),
      el('div.settings-body', {}, footerInput)
    ])
  );

  /* --- 3 · data & backup ---------------------------------------------- */
  const stats = await Promise.all([
    listProducts(), listSales(), listSuppliers(), listSupplierInvoices(), listSupplierPayments(),
  ]);
  const [products, sales, suppliers, supInvoices, supPayments] = stats;
  const sizeEst = JSON.stringify({ products, sales, suppliers, supInvoices, supPayments }).length;
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
          { style: 'display:grid;grid-template-columns:repeat(2,1fr);gap:9px;margin-bottom:15px;text-align:center' },
          statBox(String(supInvoices.length), 'فاتورة شراء'),
          statBox(String(supPayments.length), 'دفعة')
        ),
        el('p.tiny.muted', { style: 'margin-bottom:13px', text: `حجم البيانات الحالي تقريباً: ${sizeLabel}. كل شيء محفوظ محلياً في هذا الجهاز فقط.` }),
        el(
          'div.export-row',
          {},
          el('button.btn.btn--primary', { type: 'button', onClick: doExport }, fromHTML(icon('download')), el('span', { text: 'تصدير نسخة احتياطية' })),
          el('button.btn.btn--soft', { type: 'button', onClick: doImport }, fromHTML(icon('upload')), el('span', { text: 'استعادة من ملف' }))
        )
      )
    ])
  );

  /* --- 4 · about ------------------------------------------------------- */
  host.appendChild(
    group('about', 'حول التطبيق', 'info', [
      el(
        'div.about',
        {},
        el('b', { text: 'متجري' }),
        el('div', { text: 'نظام إدارة متجر الملابس — مخزون، بيع، عملاء وتقارير.' }),
        el('div', { style: 'margin-top:6px', html: `البيانات محفوظة محلياً (IndexedDB · إصدار ${DB_VERSION}) ولا تغادر جهازك.` }),
        el('div', { style: 'margin-top:6px', text: `التخزين: ${DB_NAME}` })
      )
    ])
  );

  /* --- 5 · danger zone -------------------------------------------------- */
  host.appendChild(
    el(
      'section.settings-group.danger-zone',
      {},
      el('div.settings-group__head', {}, fromHTML(icon('alert')), el('h3', { text: 'منطقة الخطر' })),
      el(
        'div.settings-body',
        {},
        el('button.btn.btn--danger.btn--block', { type: 'button', onClick: doClear }, fromHTML(icon('trash')), el('span', { text: 'مسح كل البيانات' }))
      )
    )
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
    storeTagline: s.storeTagline.trim(),
      phone: s.phone.trim(),
      address: s.address.trim(),
      currency: s.currency.trim() || 'ILS',
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

  async function doExport() {
    try {
      const data = await exportAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const ok = await downloadBlob(blob, `saher-backup_${isoDate(new Date())}.json`);
      toast(ok ? 'تم تصدير النسخة الاحتياطية' : 'تعذّر تصدير النسخة الاحتياطية', ok ? 'ok' : 'err');
    } catch (e) {
      console.error(e);
      toast('تعذّر التصدير', 'err');
    }
  }

  async function doImport() {
    const file = await pickFile('application/json,.json');
    if (!file) return;

    let data;
    try {
      data = JSON.parse(await readFileAsText(file));
    } catch {
      return toast('الملف ليس JSON صالحاً', 'err');
    }
    if (!data || data.app !== 'saher') {
      return toast('ملف النسخة الاحتياطية غير صالح', 'err');
    }

    const nP = (data.products || []).length;
    const nS = (data.sales || []).length;
    const nU = (data.suppliers || []).length;
    const nI = (data.supplierInvoices || []).length;

    const yes = await confirmDialog({
      title: 'استعادة النسخة؟',
      message: `سيُستبدل المحتوى الحالي (${nP} منتج · ${nS} فاتورة بيع · ${nU} مورد · ${nI} فاتورة شراء). لا يمكن التراجع.`,
      confirmLabel: 'استعادة',
    });
    if (!yes) return;

    try {
      await importAll(data);
      await celebrate({ title: 'تمت الاستعادة', sub: `${nP} منتج · ${nS} فاتورة`, ms: 1300 });
      navigate('dashboard');
      setTimeout(() => location.reload(), 400);
    } catch (e) {
      console.error(e);
      toast('تعذّرت الاستعادة', 'err');
    }
  }

  async function doClear() {
    const yes1 = await confirmDialog({
      title: 'مسح كل البيانات؟',
      message: 'سيُحذف كل المنتجات والفواتير والعملاء نهائياً من هذا الجهاز. صدّر نسخة احتياطية أولاً إن أردت.',
      confirmLabel: 'متابعة',
      danger: true,
    });
    if (!yes1) return;

    const yes2 = await confirmDialog({
      title: 'تأكيد نهائي',
      message: 'هل أنت متأكد تماماً؟ لا يمكن استرجاع البيانات بعد الحذف.',
      confirmLabel: 'نعم، احذف كل شيء',
      danger: true,
    });
    if (!yes2) return;

    await clearAll();
    await saveSettings({ seeded: true });
    toast('تم مسح البيانات', 'ok');
    navigate('dashboard');
    setTimeout(() => location.reload(), 500);
  }
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
