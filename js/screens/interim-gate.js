/**
 * The interim gate screen — the date code, and the door that is never locked.
 *
 * Two jobs, in this order:
 *
 *   1. Ask for the code and let the owner in.
 *   2. Offer the backup buttons — ALWAYS, even when the code is wrong, expired,
 *      or the clock is suspect.
 *
 * The second job is the important one. Whatever the state of this gate, the
 * data on the phone belongs to the shop owner and they must be able to get it
 * out. There is deliberately no code path on this screen that hides, disables
 * or gates the export button behind a correct code.
 *
 * The layout uses the app's existing classes (`.form-section`, `.field`,
 * `.btn`) so this screen looks like the app rather than like a bolted-on page.
 */

import { el, fromHTML } from '../utils.js';
import { icon } from '../icons.js';
import { toast } from '../components.js';
import { navigate } from '../router.js';
import { activateWithCode, activationStatus, ACTIVATION_TTL_DAYS } from '../interim-activation.js';
import { runFileExport, runFileImport, backupReminderText, BACKUP_REMINDER_DAYS } from '../data-transfer-ui.js';

function screenStatusText() {
  const st = activationStatus();
  switch (st.reason) {
    case 'expired':
      return 'انتهت صلاحية التفعيل. أدخل كوداً جديداً للمتابعة — بياناتك كلها سليمة ومحفوظة.';
    case 'clock':
      return 'يبدو أن تاريخ الجهاز غير صحيح أو تم إرجاعه. اضبط التاريخ والوقت تلقائياً ثم أدخل كوداً جديداً.';
    default:
      return `أدخل كود التفعيل. الكود يتجدد كل ${ACTIVATION_TTL_DAYS} يوماً.`;
  }
}

export function render() {
  const input = el('input.input.ltr', {
    id: 'gate-code',
    type: 'text',
    inputmode: 'numeric',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    maxlength: '8',
    placeholder: '00000000',
    'aria-label': 'كود التفعيل',
  });

  // Digits only, as typed. The keyboard may still offer letters on some
  // devices, and a stray space should never be the reason a code "fails".
  input.addEventListener('input', () => {
    const clean = input.value.replace(/[^0-9]/g, '').slice(0, 8);
    if (clean !== input.value) input.value = clean;
  });

  const errorLine = el('p.field__hint', { style: 'color:var(--danger);min-height:18px', text: '' });

  const activateButton = el(
    'button.btn.btn--primary.btn--block',
    { type: 'button' },
    fromHTML(icon('checkCircle')),
    el('span', { text: 'تفعيل' }),
  );

  function doActivate() {
    const result = activateWithCode(input.value.trim());
    if (!result.ok) {
      errorLine.textContent = result.message;
      input.select?.();
      return;
    }
    errorLine.textContent = '';
    toast(`تم التفعيل — ${result.daysRemaining} يوماً`, 'ok');
    navigate('dashboard');
  }

  activateButton.addEventListener('click', doActivate);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doActivate();
    }
  });

  const stepCode = el(
    'div.form-section',
    {},
    el('div.form-section__head', {}, el('span.form-section__num', { text: '1' }), el('h3', { text: 'كود التفعيل' })),
    el(
      'div.field',
      {},
      el('label.field__label', { for: 'gate-code' }, el('span', { text: 'الكود (8 أرقام)' })),
      input,
      errorLine,
    ),
    activateButton,
  );

  /* ------------------------------------------------------------------ *
   * Backup — never gated
   * ------------------------------------------------------------------ */

  const reminder = backupReminderText();
  const exportButton = el(
    'button.btn.btn--soft.btn--block',
    { type: 'button', onClick: (e) => runFileExport({ button: e.currentTarget }) },
    fromHTML(icon('download')),
    el('span', { text: 'تصدير نسخة احتياطية (ملف)' }),
  );
  const importButton = el(
    'button.btn.btn--ghost.btn--block',
    { type: 'button', style: 'margin-top:8px', onClick: (e) => runFileImport({ button: e.currentTarget }) },
    fromHTML(icon('upload')),
    el('span', { text: 'استيراد نسخة احتياطية' }),
  );

  const backupStep = el(
    'div.form-section',
    {},
    el('div.form-section__head', {}, el('span.form-section__num', { text: '2' }), el('h3', { text: 'نسخة احتياطية من بياناتك' })),
    el('p.muted', {
      text: 'زر النسخ الاحتياطي يعمل دائماً، حتى لو لم يُفعَّل الكود أو انتهى. بيانات متجرك تبقى على جهازك، والملف هو وسيلتك لنقلها إلى أي جهاز آخر.',
    }),
    reminder ? el('p.field__hint', { style: 'color:var(--brass-deep)', text: reminder }) : null,
    el('div', { style: 'height:10px' }),
    exportButton,
    importButton,
    el('p.tiny.muted', {
      style: 'margin-top:10px',
      text: `خُذ نسخة احتياطية كل ${BACKUP_REMINDER_DAYS} أيام على الأقل. الملف يشمل المنتجات والمخزون وفواتير البيع والمشتريات والموردين والإعدادات والصور.`,
    }),
  );

  const root = el(
    'div.screen',
    { id: 'interim-gate-screen' },
    el('h2', { text: 'تفعيل النسخة المؤقتة' }),
    el('p', { id: 'gate-status', text: screenStatusText() }),
    stepCode,
    el('hr', { style: 'opacity:.35;margin:18px 0' }),
    backupStep,
    el('p.tiny.muted', {
      style: 'margin-top:16px',
      text: 'ملاحظة: هذه حماية مؤقتة للنسخة التجريبية وليست تشفيراً. النسخة الكاملة القادمة ستتضمن الترخيص وتسجيل الدخول بحساب Google.',
    }),
  );

  return root;
}

export default { render };
