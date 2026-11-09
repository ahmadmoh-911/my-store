/**
 * The dialogs, buttons and summaries around js/data-transfer.js.
 *
 * Kept apart from the data-transfer module on purpose: that one is pure logic
 * (build a file, check a file, restore a file) and is what the automated tests
 * drive; this one is allowed to know about the DOM, toasts and modals. Splitting
 * them means the logic can be tested with no browser at all, which is the only
 * way its "all or nothing" promise is worth anything.
 *
 * Nothing here mentions the build mode. A restore works in the interim build,
 * in the full build, and on a device that has never seen either.
 */

import { el, fromHTML, isoDate, numInt } from './utils.js';
import { toast, openModal, confirmDialog, celebrate } from './components.js';
import { icon } from './icons.js';
import {
  buildBackupFile, validateBackupFile, verifyFingerprint,
  readAllStores, computeTotals, importBackupFile,
  markExportedAt, isBackupDue, BACKUP_REMINDER_DAYS, FORMAT_VERSION,
} from './data-transfer.js';

/* ------------------------------------------------------------------ *
 * Arabic labels for whatever the schema happens to contain
 *
 * Unknown store names fall back to the raw name rather than being hidden: a
 * table this file does not know about is exactly the thing a summary must not
 * silently omit.
 * ------------------------------------------------------------------ */

const STORE_LABELS = {
  products: 'منتجات',
  sales: 'فواتير بيع',
  purchases: 'تجديد كمية',
  stockBatches: 'دفعات المخزون',
  suppliers: 'موردون',
  supplierInvoices: 'فواتير شراء',
  supplierPayments: 'دفعات موردين',
  settings: 'إعدادات',
};

export const storeLabel = (name) => STORE_LABELS[name] || name;

const money = (n) => `${numInt(Math.round((Number(n) || 0) * 100) / 100)} ₪`;
const count = (n) => numInt(Number(n) || 0);

/** "منتجات 120 · فواتير بيع 3400 · …" over whatever the file/store set has. */
export function describeCounts(counts) {
  const parts = Object.keys(counts)
    .sort()
    .map((name) => `${storeLabel(name)} ${count(counts[name])}`);
  return parts.join(' · ') || 'لا توجد بيانات';
}

/** The money figures a shop owner recognises. */
export function describeTotals(t) {
  if (!t) return 'لا توجد مجاميع';
  return [
    `المبيعات ${money(t.totalSales)} (${count(t.salesCount)} فاتورة)`,
    `المشتريات ${money(t.totalPurchases)}`,
    `قيمة المخزون ${money(t.inventoryValue)} (${count(t.unitsInStock)} قطعة)`,
    `ديون الموردين ${money(t.supplierDebt)}`,
  ].join(' · ');
}

/* ------------------------------------------------------------------ *
 * Busy state on a button
 * ------------------------------------------------------------------ */

function setBusy(btn, busy, label) {
  if (!btn) return;
  if (busy) {
    btn.dataset._label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `${fromHTML(icon('spinner'))}<span>${label || 'جارٍ العمل…'}</span>`;
  } else {
    btn.disabled = false;
    if (btn.dataset._label) btn.innerHTML = btn.dataset._label;
  }
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

/**
 * Builds the file, PROVES it is intact by reading it back, then saves it.
 *
 * The read-back is the whole reason this is not a one-liner: the shop owner is
 * shown "تم التصدير بنجاح" only after the exact bytes that are being handed to
 * the phone have been re-parsed and re-fingerprinted. A file that fails that
 * check is never announced as a success.
 *
 * @param {{button?:HTMLElement, appVersion?:string, silent?:boolean}} [opts]
 * @returns {Promise<boolean>}
 */
export async function runFileExport(opts = {}) {
  const { button, appVersion, silent = false } = opts;
  setBusy(button, true, 'جاري التصدير…');
  try {
    const file = await buildBackupFile({ appVersion });
    const text = JSON.stringify(file, null, 2);
    const blob = new Blob([text], { type: 'application/json' });

    // Re-read exactly what will be saved, and verify it.
    const readBack = await blob.text();
    const verdict = await validateBackupFile(readBack);
    if (!verdict.ok) {
      toast(`فشل التحقق من الملف قبل حفظه: ${verdict.error}`, 'err');
      return false;
    }
    const fp = await verifyFingerprint(JSON.parse(readBack));
    if (!fp.ok) {
      toast('فشل التحقق من بصمة الملف — لم يُحفظ', 'err');
      return false;
    }

    const filename = `saher-backup_${isoDate(new Date())}.json`;
    const saved = await downloadBlobSafe(blob, filename);
    if (!saved) {
      toast('تعذّر حفظ الملف على الجهاز', 'err');
      return false;
    }

    markExportedAt();
    if (!silent) {
      // The file's fate on Android is the share sheet: it is how the owner
      // actually gets it off the phone, so the success dialog says so — a
      // dismissed sheet must never read as "the export went nowhere".
      const { isNative } = await import('./native.js');
      showSummaryModal({
        title: 'تم التصدير بنجاح',
        file,
        extra:
          `اسم الملف: ${filename}` +
          (isNative()
            ? ' — على الجهاز تُفتح ورقة المشاركة: اختر «ملفات» أو أي تطبيق (Drive، واتساب…) لإرسال النسخة. إن ألغيت الورقة يبقى الملف محفوظاً داخل مساحة التطبيق.'
            : ''),
      });
    }
    return true;
  } catch (e) {
    console.error('[backup] export failed', e);
    toast('تعذّر التصدير', 'err');
    return false;
  } finally {
    setBusy(button, false);
  }
}

/** `downloadBlob` throws on an unexpected native failure; a false return is a failure too. */
async function downloadBlobSafe(blob, filename) {
  const { downloadBlob } = await import('./utils.js');
  try {
    return (await downloadBlob(blob, filename)) !== false;
  } catch (e) {
    console.error('[backup] save failed', e);
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Summary modal
 * ------------------------------------------------------------------ */

function summaryBody(file, extra) {
  const counts = file.counts
    || Object.fromEntries(Object.entries(file.stores || {}).map(([k, v]) => [k, (v || []).length]));
  return el(
    'div',
    { style: 'text-align:right' },
    el('p.tiny.muted', { text: `الملف: ${file.exportedAt ? new Date(file.exportedAt).toLocaleString('ar') : '—'} · إصدار الصيغة ${file.formatVersion || FORMAT_VERSION}` }),
    el('div', { style: 'font-size:13.5px;line-height:1.9;color:var(--ink-2)' },
      ...Object.keys(counts).sort().map((name) =>
        el('div', {}, el('b', { text: `${storeLabel(name)}: ` }), el('span', { text: count(counts[name]) }))),
      el('div', { style: 'height:6px' }),
      el('div', {}, el('b', { text: 'المجاميع: ' }), el('span', { text: describeTotals(file.totals) })),
      el('div', {}, el('b', { text: 'بصمة التحقق: ' }), el('span.ltr', { style: 'font-size:11px', text: (file.fingerprint?.value || '').slice(0, 16) + '…' })),
    ),
    extra ? el('p.tiny.muted', { style: 'margin-top:10px', text: extra }) : null,
  );
}

function showSummaryModal({ title, file, extra }) {
  const m = openModal({
    title,
    body: summaryBody(file, extra),
    foot: [el('button.btn.btn--primary', { type: 'button', text: 'تم', onClick: () => m.close(true) })],
  });
  return m;
}

/* ------------------------------------------------------------------ *
 * Import
 * ------------------------------------------------------------------ */

/** A compact one-line state of the device right now, for the confirm dialog. */
async function currentLine() {
  const stores = await readAllStores();
  const counts = Object.fromEntries(Object.keys(stores).map((n) => [n, stores[n].length]));
  return { counts, totals: computeTotals(stores) };
}

function fileCounts(file) {
  if (file.stores) return Object.fromEntries(Object.entries(file.stores).map(([k, v]) => [k, (v || []).length]));
  const picks = ['products', 'sales', 'purchases', 'suppliers', 'supplierInvoices', 'supplierPayments', 'stockBatches'];
  const out = {};
  for (const k of picks) if (Array.isArray(file[k])) out[k] = file[k].length;
  if (file.settings) out.settings = 1;
  return out;
}

/**
 * Picks a file, checks it, shows BOTH sides, asks once, then restores.
 *
 * Every refusal — bad JSON, unknown version, a fingerprint that does not match,
 * a truncated file — happens BEFORE the live database is touched, so a rejected
 * file leaves the shop exactly as it found it.
 *
 * @param {{button?:HTMLElement}} [opts]
 * @returns {Promise<boolean>}
 */
export async function runFileImport(opts = {}) {
  const { button } = opts;
  let picked;
  try {
    picked = await pickFileSafe();
  } catch (e) {
    console.error(e);
    toast('تعذّر اختيار الملف', 'err');
    return false;
  }
  if (!picked) return false;

  setBusy(button, true, 'جاري الفحص…');
  try {
    const text = await readTextSafe(picked);
    const verdict = await validateBackupFile(text);
    if (!verdict.ok) {
      toast(verdict.error || 'ملف النسخة الاحتياطية غير صالح', 'err');
      return false;
    }

    const file = verdict.file;
    const before = await currentLine();

    const yes = await confirmDialog({
      title: 'استيراد النسخة الاحتياطية؟',
      danger: true,
      confirmLabel: 'استيراد واستبدال',
      message:
        `الملف: ${describeCounts(fileCounts(file))}.\n` +
        `الجهاز الآن: ${describeCounts(before.counts)}.\n\n` +
        'سيُستبدل كل المحتوى الحالي بمحتوى الملف. تُحفظ نسخة تلقائية من بياناتك الحالية قبل الاستبدال، وإن فشل التحقق يُعاد كل شيء كما كان.',
    });
    if (!yes) return false;

    setBusy(button, true, 'جاري الاستيراد…');
    const result = await importBackupFile(file, verdict.formatVersion);

    await celebrate({
      title: 'تمت الاستعادة',
      sub: `${count(result.summary.counts.sales)} فاتورة · ${count(result.summary.counts.products)} منتج`,
      ms: 1300,
    });
    showSummaryModal({
      title: 'تم الاستيراد بنجاح',
      file: {
        exportedAt: result.summary.exportedAt,
        formatVersion: result.summary.formatVersion,
        counts: result.summary.counts,
        totals: result.summary.totals,
        fingerprint: { value: '' },
      },
      extra: 'تم التحقق من الأعداد والمجاميع بعد الاستيراد. أعِد تشغيل التطبيق إن لاحظت أي شاشة قديمة.',
    });
    return true;
  } catch (e) {
    console.error('[backup] import failed', e);
    toast(e?.message || 'تعذّرت الاستعادة', 'err');
    return false;
  } finally {
    setBusy(button, false);
  }
}

async function pickFileSafe() {
  const { pickFile } = await import('./utils.js');
  return pickFile('application/json,.json');
}

async function readTextSafe(file) {
  const { readFileAsText } = await import('./utils.js');
  return readFileAsText(file);
}

/* ------------------------------------------------------------------ *
 * Reminder
 * ------------------------------------------------------------------ */

/**
 * The gentle nudge: true when the owner has not exported for a few days.
 * The text is deliberately an invitation, not an error — nothing is wrong.
 */
export function backupReminderText() {
  if (!isBackupDue()) return '';
  return `لم تأخذ نسخة احتياطية منذ ${BACKUP_REMINDER_DAYS} أيام أو أكثر. خُذ نسخة الآن لتحفظ بيانات متجرك.`;
}

export { isBackupDue, BACKUP_REMINDER_DAYS };
