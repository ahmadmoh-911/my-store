/**
 * Activate screen
 * Handles Google sign-in and license activation flow for web UI.
 *
 * Three ordered steps, top to bottom (RTL): sign in with Google, enter the
 * licence code, then bind the licence to the signed-in account. The code field
 * is a real input — the previous version called `prompt()`, so no field existed
 * on the screen at all. Buttons use the shared `.btn` classes and the sections
 * use the existing `.form-section` step pattern, so the layout matches the rest
 * of the app without new libraries.
 */
import { el } from '../utils.js';
import { startGoogleAuth, getCurrentAccount } from '../auth-client.js';
import { activateLicense, bindLicense } from '../license-client.js';
import { getEntitlement, getEntitlementMessage } from '../entitlement.js';
import { navigate } from '../router.js';
import { toast } from '../components.js';

/**
 * The accepted shape, taken from the real validator:
 * `server/src/codes.js` normalises to `SH-XXXX-XXXX-XXXX`
 * (pattern `^SH(-[A-Z0-9]{4}){3}$`) over the alphabet
 * `ABCDEFGHJKMNPQRSTVWXYZ23456789` — which is why O, I, L, U, 0 and 1 are
 * rejected. Whitespace and underscores are accepted in place of the dashes.
 */
export const CODE_HINT =
  'الشكل المطلوب: SH-XXXX-XXXX-XXXX — ويُقبل الإدخال بحروف صغيرة أو بمسافات بدل الشرطات. الأحرف O وI وL وU والأرقام 0 و1 غير مستخدمة في الرمز.';

/** Shown when the field is submitted empty; no request is sent. */
export const EMPTY_CODE_MESSAGE = 'الرجاء إدخال رمز الترخيص';

/**
 * Arabic text for a licence error. The server's error `code` stays the contract
 * (it is never rewritten here); only the human-facing text is translated.
 *
 * @param {{code?: string, message?: string}} [error]
 * @returns {string}
 */
export function licenceErrorMessage(error) {
  const byCode = {
    INVALID_LICENSE: 'رمز الترخيص غير مكتوب بالشكل الصحيح. الشكل المطلوب: SH-XXXX-XXXX-XXXX.',
    LICENSE_NOT_FOUND: 'لا يوجد ترخيص مطابق لهذا الرمز.',
    LICENSE_ALREADY_BOUND: 'هذا الترخيص مرتبط بحساب آخر.',
    LICENSE_SUSPENDED: 'هذا الترخيص موقوف.',
    LICENSE_EXPIRED: 'انتهت صلاحية هذا الترخيص.',
    LICENSE_REVOKED: 'تم إلغاء هذا الترخيص.',
    ACCOUNT_MISMATCH: 'هذا الترخيص يخص حسابًا مختلفًا.',
    INVALID_SESSION: 'انتهت الجلسة. سجّل الدخول من جديد.',
    INVALID_REQUEST: 'الطلب غير مكتمل. تحقق من البيانات.',
    ADMIN_REQUIRED: 'هذه العملية تتطلب صلاحية إدارية.',
    DRIVE_NOT_CONNECTED: 'لم يتم ربط Google Drive بهذا الحساب.',
    INTERNAL_ERROR: 'تعذّر على الخادم إكمال الطلب.',
  };
  return byCode[error?.code] || error?.message || 'فشل تفعيل الترخيص';
}

function parseParams() {
  const hash = window.location.hash || '';
  const qIndex = hash.indexOf('?');
  const params = new URLSearchParams(qIndex >= 0 ? hash.slice(qIndex + 1) : '');
  return params;
}

async function refreshEntitlement() {
  try {
    const ent = await getEntitlement();
    const msg = await getEntitlementMessage(ent);
    const status = document.getElementById('act-status');
    if (status) status.textContent = msg;
    const sell = document.getElementById('act-sell');
    if (sell) sell.textContent = ent.canSell ? 'يمكن البيع' : 'ممنوع البيع';
    if (ent.canSell) {
      setTimeout(() => navigate('dashboard'), 1000);
    }
    return ent;
  } catch (e) {
    console.error(e);
  }
  return null;
}

/** Reveals step 3 (bind) once a code has been activated in this session. */
function showBindStep() {
  const step = document.getElementById('act-step-bind');
  if (step) step.hidden = false;
}

/**
 * Fills step 1: when a Google account is already signed in, replaces the button
 * with the account line instead of leaving a dead control on screen.
 *
 * @param {object} accountLine
 * @param {object} signInBox
 */
async function syncAccount(accountLine, signInBox) {
  try {
    const account = await getCurrentAccount();
    if (account?.googleSub) {
      signInBox.hidden = true;
      accountLine.hidden = false;
      accountLine.textContent = `مسجّل الدخول: ${account.email || account.displayName || account.googleSub}`;
    }
  } catch {
    // Not signed in (or offline): leave the sign-in button in place.
  }
}

async function signIn() {
  try {
    const { authUrl } = await startGoogleAuth();
    window.location.href = authUrl;
  } catch (e) {
    toast(e.message || 'فشل تسجيل الدخول', 'warn');
  }
}

async function doActivate() {
  const input = document.getElementById('act-code');
  const code = (input?.value || '').trim();
  if (!code) {
    toast(EMPTY_CODE_MESSAGE, 'warn');
    if (input?.focus) input.focus();
    return;
  }
  try {
    // A licence only becomes sellable once it is bound to a signed-in Google
    // account (`getEntitlement` reports UNAUTHENTICATED otherwise), so there is
    // no point taking a code before the owner has signed in.
    const account = await getCurrentAccount();
    if (!account?.googleSub) {
      toast('سجّل الدخول بـ Google أولًا', 'warn');
      return;
    }
    const res = await activateLicense(code);
    if (!res.ok) {
      toast(licenceErrorMessage(res.error), 'warn');
      return;
    }
    toast('تم تفعيل الرمز. أكمل الخطوة 3 لربطه بحسابك.', 'ok');
    showBindStep();
    await refreshEntitlement();
  } catch (e) {
    toast(e.message || 'فشل تفعيل الترخيص', 'warn');
  }
}

async function doBind() {
  try {
    const account = await getCurrentAccount();
    if (!account?.googleSub) {
      toast('سجّل الدخول بـ Google أولًا', 'warn');
      return;
    }
    const res = await bindLicense(account.googleSub);
    if (!res?.ok) {
      toast(licenceErrorMessage(res?.error), 'warn');
      return;
    }
    toast('تم ربط الترخيص', 'ok');
    await refreshEntitlement();
  } catch (e) {
    toast(e.message || 'فشل ربط الترخيص', 'warn');
  }
}

export default {
  render() {
    const params = parseParams();
    const auth = params.get('auth');

    // --- Step 1: Google sign-in ------------------------------------------
    const signInButton = el('button.btn.btn--primary.btn--block', {
      id: 'act-signin',
      type: 'button',
      text: 'تسجيل الدخول بـ Google',
      onClick: signIn,
    });
    const accountLine = el('p', { id: 'act-account', text: '', hidden: true });
    const signInBox = el('div', { id: 'act-signin-box' }, signInButton);

    const stepSignIn = el('div.form-section', { id: 'act-step-signin' },
      el('div.form-section__head', {},
        el('span.form-section__num', { text: '1' }),
        el('h3', { text: 'تسجيل الدخول بحساب Google' })
      ),
      signInBox,
      accountLine
    );

    // --- Step 2: licence code --------------------------------------------
    const codeInput = el('input.input.ltr', {
      id: 'act-code',
      type: 'text',
      autocomplete: 'off',
      autocapitalize: 'characters',
      spellcheck: 'false',
      placeholder: 'SH-XXXX-XXXX-XXXX',
      'aria-label': 'رمز الترخيص',
    });
    const codeField = el('div.field', {},
      el('label.field__label', { for: 'act-code' }, el('span', { text: 'رمز الترخيص' })),
      codeInput,
      el('p.field__hint', { text: CODE_HINT })
    );
    const activateButton = el('button.btn.btn--primary.btn--block', {
      id: 'act-activate',
      type: 'button',
      text: 'تفعيل الترخيص',
      onClick: doActivate,
    });

    const stepCode = el('div.form-section', { id: 'act-step-code' },
      el('div.form-section__head', {},
        el('span.form-section__num', { text: '2' }),
        el('h3', { text: 'رمز الترخيص' })
      ),
      codeField,
      activateButton
    );

    // --- Step 3: bind to the account (revealed after activation) ---------
    const bindButton = el('button.btn.btn--soft.btn--block', {
      id: 'act-bind',
      type: 'button',
      text: 'ربط الترخيص بالحساب',
      onClick: doBind,
    });
    const bindStep = el('div.form-section', { id: 'act-step-bind' },
      el('div.form-section__head', {},
        el('span.form-section__num', { text: '3' }),
        el('h3', { text: 'ربط الترخيص بالحساب' })
      ),
      el('p.muted', { text: 'بعد تفعيل الرمز، اربطه بحساب Google حتى يصبح البيع مسموحًا.' }),
      bindButton
    );
    bindStep.hidden = true;

    const root = el('div.screen', { id: 'activate-screen' },
      el('h2', { text: 'تفعيل التطبيق' }),
      el('p', { id: 'act-status', text: 'جاري التحقق من حالة الترخيص...' }),
      el('p', { id: 'act-sell', text: '' }),
      stepSignIn,
      stepCode,
      bindStep,
      el('div.form-section', { id: 'act-step-support' },
        el('div.form-section__head', {},
          el('h3', { text: 'لا تزال بحاجة مساعدة؟' })
        ),
        el('p.muted', { text: 'إذا لم يصل إليك رمز الترخيص أو واجهت مشكلة في التفعيل، أرسل طلباً إلى لوحة الإدارة.' }),
        el('button.btn.btn--soft.btn--block', {
          type: 'button',
          text: 'إرسال طلب تفعيل أو دعم للإدارة',
          onClick: () => navigate('activation-request'),
        })
      )
    );

    syncAccount(accountLine, signInBox);
    if (auth === 'ok') {
      getCurrentAccount().then(() => refreshEntitlement());
    } else {
      refreshEntitlement();
    }

    // The router mounts this return value directly and its very next line is
    // `node.classList.add('screen')`. Returning a wrapper object here — as this
    // screen used to — made that line throw "Cannot read properties of undefined
    // (reading 'add')" and took the whole boot down. Return the element itself.
    return root;
  },
};
