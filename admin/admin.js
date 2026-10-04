/**
 * Admin Portal.
 *
 * A separate application from the Store Hub shop, in every way that matters:
 *
 * - it lives in its own directory and is served from its own origin;
 * - it imports nothing from the customer's `js/` modules;
 * - it never touches the customer's IndexedDB, so it has no access to products,
 *   sales, inventory, reports or backups — that data is not merely hidden from
 *   it, it is in a different database the backend will not query on its behalf.
 *
 * Its own security posture follows from the backend being the authority. This
 * module does not decide whether the operator may see a licence; it asks
 * (`GET /api/admin/me`) and obeys. On a 401 it shows a sign-in button, on a 403
 * it shows an access-denied notice, and in both cases it renders nothing that
 * came from an admin endpoint. A "hidden" page is not access control, so the
 * only thing this file is trusted with is presentation.
 *
 * Two habits worth naming, because both are load-bearing:
 *
 * - Server data reaches the DOM through `textContent`, never `innerHTML`. An
 *   operator is a privileged user, which makes a licence note an attacker-
 *   supplied string one stored-XSS away from an admin session.
 * - A code revealed at creation is shown once and then dropped from state. The
 *   server cannot produce it again, so the copy is the operator's problem to
 *   solve before they close the dialog, and the UI says so rather than letting
 *   them discover it later.
 */

import { API_BASE } from './config.js';

/* ==================================================================== *
 * Talking to the backend
 * ==================================================================== */

/**
 * A failed API call, carrying the server's machine-readable code.
 *
 * The code is what the UI branches on. The message is for the operator, and
 * `detail` is for a log line — never shown, because it describes server
 * internals.
 */
class ApiError extends Error {
  /**
   * @param {number} status
   * @param {{code?: string, message?: string, detail?: string}} body
   */
  constructor(status, body) {
    super(body?.message || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.code || 'UNKNOWN';
  }
}

/**
 * Calls the backend.
 *
 * `credentials: 'include'` because the session is an HttpOnly cookie: this is
 * the only way it reaches the request, and deliberately the only way the portal
 * can act as the operator.
 *
 * @param {string} path
 * @param {{method?: string, body?: object}} [options]
 * @returns {Promise<object>}
 * @throws {ApiError}
 */
async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    // `include` is required and unconditional: the session is an HttpOnly cookie
    // and this is the only way the portal can act as the operator.
    //
    // The cross-origin case works because of a deployment constraint rather than
    // a trick: the backend must be on the same registrable domain (portal on
    // `admin.…`, API on `api.…`), and the session cookie is `SameSite=Lax`, which
    // the browser withholds from a genuinely cross-site request. So a
    // misconfigured API_BASE fails closed instead of quietly sending a session
    // somewhere unintended.
    credentials: 'include',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    // A body-less 302 or a proxy's HTML error page lands here. The status code
    // is still meaningful, so the error is raised with an empty body rather
    // than swallowed.
  }

  if (!response.ok) throw new ApiError(response.status, payload);
  return payload;
}

/* ==================================================================== *
 * Tiny DOM helpers
 * ==================================================================== */

/**
 * Creates an element.
 *
 * Every child string becomes `textContent`. There is no path in this file that
 * turns server data into markup, which is the point.
 *
 * @param {string} tag
 * @param {object} [props] `class`, `text`, or any attribute/handler
 * @param {(Node|string|null|false|undefined)[]} [children]
 * @returns {HTMLElement}
 */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** @param {string} className @param {string} text @returns {HTMLElement} */
function div(className, text) {
  return el('div', { class: className, text });
}

/** @param {number|null|undefined} ms @returns {string} */
function formatDate(ms) {
  if (!ms) return '—';
  return new Intl.DateTimeFormat('ar', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(ms));
}

/** @param {string|null|undefined} status @returns {HTMLElement} */
function statusBadge(status) {
  const labels = {
    active: 'نشط',
    suspended: 'موقوف',
    revoked: 'ملغى',
    expired: 'منتهي',
  };
  return el('span', { class: `badge badge-${status}`, text: labels[status] ?? status });
}

/* ==================================================================== *
 * Toasts and the one modal this portal needs
 * ==================================================================== */

const toastContainer = document.getElementById('toastContainer');
const modalOverlay = document.getElementById('modalOverlay');
const modalTitle = document.getElementById('modalTitle');
const modalBody = document.getElementById('modalBody');

/**
 * @param {string} message
 * @param {'success'|'error'|'info'} [kind]
 */
function toast(message, kind = 'info') {
  const node = div(`toast ${kind}`, message);
  toastContainer.append(node);
  setTimeout(() => node.remove(), 6000);
}

/**
 * Opens the modal.
 *
 * @param {string} title
 * @param {(Node|string)[]} content
 * @param {(Node|null)[]} [footer]
 */
function openModal(title, content, footer = []) {
  modalTitle.textContent = title;
  modalBody.replaceChildren(...content.flat());
  const actions = el('div', { class: 'btn-group' }, footer);
  modalBody.append(actions);
  modalOverlay.style.display = 'flex';
}

function closeModal() {
  modalOverlay.style.display = 'none';
  modalBody.replaceChildren();
}

document.getElementById('modalClose').addEventListener('click', closeModal);
modalOverlay.addEventListener('click', (event) => {
  // Clicking the backdrop closes; clicking the dialog does not.
  if (event.target === modalOverlay) closeModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && modalOverlay.style.display === 'flex') closeModal();
});

/* ==================================================================== *
 * State
 * ==================================================================== */

/**
 * Everything the views read.
 *
 * `licenses` and `current` are only ever written from a successful admin
 * response. There is no optimistic update anywhere, because an optimistic
 * update is a way of rendering something the backend refused.
 */
const state = {
  /** The authorised operator, or null before the probe succeeds. */
  admin: null,
  licenses: [],
  total: 0,
  limit: 25,
  offset: 0,
  status: '',
  loading: false,
  error: null,
};

const root = document.getElementById('root');
root.setAttribute('aria-busy', 'false');

/* ==================================================================== *
 * Entry: ask the backend who we are
 * ==================================================================== */

/**
 * Boots the portal.
 *
 * One probe decides which of three screens is correct, and the probe is the
 * backend's answer rather than anything cached in this browser. Refreshing after
 * an admin grant is revoked therefore shows the refusal immediately.
 */
async function boot() {
  let me;
  try {
    me = await api('/api/admin/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return renderSignedOut();
    if (err instanceof ApiError && err.status === 403) return renderDenied();
    // Anything else — a 503 while the backend is unconfigured, a network
    // failure, a reverse proxy answering with HTML — is "ask again", never
    // "you are allowed in".
    return renderUnavailable(err);
  }

  state.admin = me.admin;
  window.addEventListener('hashchange', route);
  route();
}

/* ==================================================================== *
 * Screen: not signed in
 * ==================================================================== */

function renderSignedOut() {
  state.admin = null;
  root.replaceChildren(
    el('div', { class: 'centered-state' }, [
      el('h1', { text: 'لوحة إدارة Store Hub' }),
      div('callout info', 'سجّل الدخول بحساب Google المصرّح لك بإدارة التراخيص.'),
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: 'تسجيل الدخول عبر Google',
        onclick: startSignIn,
      }),
      // Say why the button may not work. The backend refuses to name any
      // administrator while none is configured, and that is a deployment
      // problem rather than something a retry will fix.
      div('field-hint', 'إن لم تستطع تسجيل الدخول، فراجع STOREHUB_ADMIN_SUB في إعدادات الخادم.'),
    ]),
  );
}

/**
 * Sends the browser to Google.
 *
 * The admin entry point is used rather than the customer one, so the two sign-in
 * flows stay separately auditable on the server and a failed admin attempt
 * leaves no session behind.
 */
async function startSignIn() {
  try {
    const { authUrl } = await api('/api/admin/auth/start');
    window.location.assign(authUrl);
  } catch (err) {
    toast(describe(err, 'تعذّر بدء تسجيل الدخول'), 'error');
  }
}

/* ==================================================================== *
 * Screen: authenticated, but not an administrator
 * ==================================================================== */

function renderDenied() {
  state.admin = null;
  // Note what is *not* here: no licence list, no counts, no account details. The
  // backend already said no, so the page has nothing protected to show.
  root.replaceChildren(
    el('div', { class: 'centered-state' }, [
      el('svg', {
        class: 'state-icon danger',
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '2',
        'aria-hidden': 'true',
      }, [
        el('path', { d: 'M12 9v4M12 17h.01' }),
        el('path', { d: 'M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z' }),
      ]),
      el('h1', { text: 'لا تملك صلاحية الوصول' }),
      div(
        'callout danger',
        'حسابك مسجّل الدخول، لكنه ليس ضمن الحسابات المصرّح لها بإدارة التراخيص. ' +
          'هذا الخادم رفض الطلب، ولا يوجد في هذه الصفحة ما يمكن عرضه.',
      ),
      el('button', {
        class: 'btn btn-secondary',
        type: 'button',
        text: 'محاولة أخرى',
        onclick: () => boot(),
      }),
    ]),
  );
}

/* ==================================================================== *
 * Screen: the backend is not reachable
 * ==================================================================== */

function renderUnavailable(err) {
  state.admin = null;
  root.replaceChildren(
    el('div', { class: 'centered-state' }, [
      el('h1', { text: 'تعذّر الاتصال بالخادم' }),
      div('callout warning', describe(err, 'الخادم غير متاح حالياً.')),
      div('field-hint', `رمز الخطأ: ${err instanceof ApiError ? err.code : 'NETWORK_ERROR'}`),
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: 'إعادة المحاولة',
        onclick: () => boot(),
      }),
    ]),
  );
}

/**
 * Turns an error into something an operator can act on.
 *
 * @param {unknown} err
 * @param {string} fallback
 * @returns {string}
 */
function describe(err, fallback) {
  if (!(err instanceof ApiError)) return fallback;
  if (err.status === 401) return 'انتهت الجلسة. سجّل الدخول من جديد.';
  if (err.status === 403) return 'هذا الحساب غير مصرّح له بهذا الإجراء.';
  if (err.status === 404) return 'العنصر غير موجود.';
  if (err.status === 503) return 'الخادم غير مُهيّأ بعد (بيانات Google أو صلاحية الإدارة ناقصة).';
  return err.message || fallback;
}

/* ==================================================================== *
 * The shell
 * ==================================================================== */

const nav = el('nav', { class: 'nav' });
const contentHost = el('div', { id: 'pageContent' });
const pageTitle = el('h1', { class: 'page-title', text: '' });
const pageSubtitle = el('p', { class: 'page-subtitle', text: '' });
const headerActions = el('div', { class: 'btn-group' });

/**
 * Builds the shell once. Route changes swap `contentHost` only, so a re-render
 * never has to rebuild the navigation — and cannot lose the operator's place by
 * re-deriving it.
 */
function buildShell() {
  const sidebar = el('aside', { class: 'sidebar', id: 'sidebar' }, [
    el('div', { class: 'sidebar-header' }, [
      el('div', { class: 'sidebar-title' }, [el('span', { text: 'Store Hub' }), el('span', { text: 'الإدارة' })]),
    ]),
    nav,
    el('div', { class: 'sidebar-footer' }, [
      el('div', { text: 'مسجّل الدخول' }),
      el('div', { class: 'mono', text: state.admin?.email || state.admin?.googleSub || '—' }),
      el('button', {
        class: 'btn btn-secondary',
        type: 'button',
        text: 'تسجيل الخروج',
        style: 'margin-top:12px',
        onclick: signOut,
      }),
    ]),
  ]);

  root.replaceChildren(
    el('div', { class: 'app' }, [
      sidebar,
      el('main', { class: 'main' }, [
        el('header', { class: 'page-header' }, [
          el('div', {}, [pageTitle, pageSubtitle]),
          headerActions,
        ]),
        contentHost,
      ]),
    ]),
  );

  for (const [route, label] of [
    ['#/licenses', 'التراخيص'],
    ['#/create', 'إنشاء ترخيص'],
  ]) {
    nav.append(
      el('button', {
        class: 'nav-item',
        type: 'button',
        text: label,
        dataset: { route },
        onclick: () => {
          window.location.hash = route;
        },
      }),
    );
  }
  markActiveNav();
}

function markActiveNav() {
  const current = window.location.hash || '#/licenses';
  for (const item of nav.querySelectorAll('.nav-item')) {
    if (item.dataset.route === current) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
}

/**
 * Signs out.
 *
 * Uses the customer logout endpoint on purpose: the admin portal has no session
 * store of its own to clear, and the cookie is the session.
 */
async function signOut() {
  try {
    await api('/api/auth/logout', { method: 'POST', body: {} });
  } catch {
    // A failed logout is not worth a modal: the local state is cleared either
    // way, and the server will refuse the old session on its own terms.
  }
  state.admin = null;
  renderSignedOut();
}

/* ==================================================================== *
 * Routing
 * ==================================================================== */

function route() {
  if (!state.admin) return;
  if (!root.querySelector('.app')) buildShell();
  markActiveNav();

  const hash = window.location.hash || '#/licenses';
  const detail = hash.match(/^#\/licenses\/([^/]+)$/);

  if (detail) return renderLicenseDetail(decodeURIComponent(detail[1]));
  if (hash === '#/create') return renderCreate();
  return renderLicenseList();
}

function setPage(title, subtitle, actions = []) {
  pageTitle.textContent = title;
  pageSubtitle.textContent = subtitle;
  headerActions.replaceChildren(...actions.flat().filter(Boolean));
}

function showLoading() {
  contentHost.replaceChildren(
    el('div', { class: 'centered-state' }, [
      el('div', { class: 'spinner', role: 'status', 'aria-label': 'جارٍ التحميل' }),
    ]),
  );
}

/* ==================================================================== *
 * View: licence list
 * ==================================================================== */

async function renderLicenseList() {
  setPage('التراخيص', 'إدارة تراخيص المتاجر');
  showLoading();

  try {
    const query = new URLSearchParams({ limit: String(state.limit), offset: String(state.offset) });
    if (state.status) query.set('status', state.status);
    const result = await api(`/api/admin/licenses?${query}`);
    state.licenses = result.licenses;
    state.total = result.total;
  } catch (err) {
    // A 403 here would mean the grant was revoked mid-session. Hand it to the
    // same screen that handles a refused probe rather than rendering a table
    // with no rows, which would read as "there are no licences".
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return boot();
    contentHost.replaceChildren(
      el('div', { class: 'card' }, [
        div('callout danger', describe(err, 'تعذّر تحميل قائمة التراخيص.')),
        el('button', { class: 'btn btn-secondary', type: 'button', text: 'إعادة المحاولة', onclick: renderLicenseList }),
      ]),
    );
    return;
  }

  const filter = el(
    'select',
    { 'aria-label': 'تصفية حسب الحالة' },
    [
      ['', 'كل الحالات'],
      ['active', 'نشط'],
      ['suspended', 'موقوف'],
      ['revoked', 'ملغى'],
      ['expired', 'منتهي'],
    ].map(([value, label]) =>
      el('option', { value, text: label, ...(state.status === value ? { selected: '' } : {}) }),
    ),
  );
  filter.addEventListener('change', () => {
    state.status = filter.value;
    state.offset = 0;
    renderLicenseList();
  });

  const rows = state.licenses.map((license) =>
    el('tr', {}, [
      el('td', {}, [
        el('button', {
          class: 'link-button mono',
          type: 'button',
          text: license.id.slice(0, 8),
          onclick: () => {
            window.location.hash = `#/licenses/${encodeURIComponent(license.id)}`;
          },
        }),
      ]),
      el('td', {}, [statusBadge(license.status)]),
      el('td', { text: formatDate(license.createdAt) }),
      el('td', { text: formatDate(license.expiresAt) }),
      el('td', { text: license.linkedAccountId ? license.linkedAccountId.slice(0, 12) : '—' }),
    ]),
  );

  const page = Math.floor(state.offset / state.limit) + 1;
  const pages = Math.max(Math.ceil(state.total / state.limit), 1);

  contentHost.replaceChildren(
    el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('h2', { class: 'card-title', text: `التراخيص (${state.total})` }),
        filter,
      ]),
      state.licenses.length === 0
        ? el('div', { class: 'empty' }, [
            el('p', { text: 'لا توجد تراخيص بعد.' }),
            el('button', {
              class: 'btn btn-primary',
              type: 'button',
              text: 'إنشاء أول ترخيص',
              onclick: () => {
                window.location.hash = '#/create';
              },
            }),
          ])
        : el('div', { class: 'table-container' }, [
            el('table', {}, [
              el('thead', {}, [
                el('tr', {}, [
                  el('th', { text: 'المعرّف' }),
                  el('th', { text: 'الحالة' }),
                  el('th', { text: 'تاريخ الإنشاء' }),
                  el('th', { text: 'تاريخ الانتهاء' }),
                  el('th', { text: 'الحساب المرتبط' }),
                ]),
              ]),
              el('tbody', {}, rows),
            ]),
          ]),
      el('div', { class: 'btn-group', style: 'margin-top:16px' }, [
        el('button', {
          class: 'btn btn-secondary',
          type: 'button',
          text: 'السابق',
          disabled: state.offset === 0 ? '' : null,
          onclick: () => {
            state.offset = Math.max(state.offset - state.limit, 0);
            renderLicenseList();
          },
        }),
        el('span', { class: 'field-hint', text: `صفحة ${page} من ${pages}` }),
        el('button', {
          class: 'btn btn-secondary',
          type: 'button',
          text: 'التالي',
          disabled: state.offset + state.limit >= state.total ? '' : null,
          onclick: () => {
            state.offset += state.limit;
            renderLicenseList();
          },
        }),
      ]),
    ]),
  );
}

/* ==================================================================== *
 * View: create a licence
 * ==================================================================== */

function renderCreate() {
  setPage('إنشاء ترخيص', 'يُظهر كود التفعيل مرة واحدة فقط');

  const expiry = el('input', {
    type: 'number',
    min: '1',
    max: '36500',
    value: '365',
    id: 'expiresInDays',
    required: '',
  });
  const note = el('textarea', { rows: '3', id: 'note', placeholder: 'اختياري: طريقة الدفع، رقم الإيصال، اسم العميل' });

  const submit = el('button', { class: 'btn btn-primary', type: 'submit', text: 'إنشاء الترخيص' });

  const form = el('form', { class: 'card' }, [
    el('div', { class: 'form-row' }, [
      el('div', { class: 'form-group' }, [
        el('label', { for: 'expiresInDays', text: 'مدة الصلاحية بالأيام' }),
        expiry,
        el('div', { class: 'field-hint', text: 'اترك الحقل فارغاً لترخيص دائم.' }),
      ]),
      el('div', { class: 'form-group' }, [
        el('label', { for: 'note', text: 'ملاحظة داخلية' }),
        note,
        el('div', { class: 'field-hint', text: 'لا تظهر هذه الملاحظة للعميل.' }),
      ]),
    ]),
    el('div', { class: 'btn-group' }, [submit]),
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      const result = await api('/api/admin/licenses', {
        method: 'POST',
        body: {
          expiresInDays: expiry.value === '' ? null : Number(expiry.value),
          note: note.value.trim() === '' ? null : note.value,
        },
      });
      revealCode(result);
    } catch (err) {
      toast(describe(err, 'تعذّر إنشاء الترخيص'), 'error');
    } finally {
      submit.disabled = false;
    }
  });

  contentHost.replaceChildren(form);
}

/**
 * Shows the plaintext activation code, exactly once.
 *
 * The code is passed straight into the dialog and never stored in `state`, so
 * navigating away cannot leave it sitting in memory for the next render to
 * accidentally display. There is nothing to be careful about later because
 * there is no later: the server keeps only a hash.
 */
function revealCode({ license, code }) {
  const confirmed = el('button', { class: 'btn btn-primary', type: 'button', text: 'حفظت الكود' });
  confirmed.addEventListener('click', () => {
    closeModal();
    window.location.hash = '#/licenses';
  });

  const copy = el('button', { class: 'btn btn-secondary', type: 'button', text: 'نسخ الكود' });
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code);
      toast('تم نسخ الكود', 'success');
    } catch {
      toast('تعذّر النسخ تلقائياً، انسخ الكود يدوياً', 'error');
    }
  });

  openModal(
    'تم إنشاء الترخيص',
    [
      div(
        'callout warning',
        'هذا الكود يظهر الآن فقط ولا يمكن استرجاعه لاحقاً، لأن الخادم لا يخزّنه ' +
          'إلا مشفّراً. أرسله للعميل قبل إغلاق هذه النافذة.',
      ),
      el('div', { class: 'code-reveal' }, [el('code', { text: code })]),
      el('dl', { class: 'detail-list' }, [
        el('div', { class: 'detail-item' }, [el('dt', { text: 'المعرّف' }), el('dd', { class: 'mono', text: license.id })]),
        el('div', { class: 'detail-item' }, [el('dt', { text: 'ينتهي في' }), el('dd', { text: formatDate(license.expiresAt) })]),
      ]),
    ],
    [copy, confirmed],
  );
  copy.focus();
}

/* ==================================================================== *
 * View: one licence
 * ==================================================================== */

async function renderLicenseDetail(id) {
  setPage('تفاصيل الترخيص', '');
  showLoading();

  let detail;
  try {
    detail = await api(`/api/admin/licenses/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return boot();
    contentHost.replaceChildren(
      el('div', { class: 'card' }, [
        div('callout danger', describe(err, 'تعذّر تحميل تفاصيل الترخيص.')),
        el('button', {
          class: 'btn btn-secondary',
          type: 'button',
          text: 'رجوع للقائمة',
          onclick: () => {
            window.location.hash = '#/licenses';
          },
        }),
      ]),
    );
    return;
  }

  const { license, installs } = detail;

  const fields = [
    ['الحالة', statusBadge(license.status)],
    ['الحالة المخزّنة', el('span', { class: 'badge badge-' + license.storedStatus, text: license.storedStatus })],
    ['تاريخ الإنشاء', el('span', { text: formatDate(license.createdAt) })],
    ['تاريخ التفعيل', el('span', { text: formatDate(license.activatedAt) })],
    ['تاريخ الانتهاء', el('span', { text: formatDate(license.expiresAt) })],
    ['آخر تحقق', el('span', { text: formatDate(license.lastVerifiedAt) })],
    ['الحساب المرتبط', el('span', { class: 'mono', text: license.linkedAccountId || '—' })],
    ['المعرّف', el('span', { class: 'mono', text: license.id })],
  ];

  const actions = [];
  if (license.status !== 'revoked' && license.storedStatus !== 'revoked') {
    if (license.storedStatus === 'suspended') {
      actions.push(actionButton('إعادة التفعيل', 'btn-primary', () => confirmStatusAction(license, 'reactivate')));
    } else {
      actions.push(actionButton('إيقاف', 'btn-secondary', () => confirmStatusAction(license, 'suspend')));
    }
    actions.push(actionButton('إلغاء نهائي', 'btn-danger', () => confirmStatusAction(license, 'revoke')));
  }

  const noteInput = el('textarea', { rows: '3', text: license.note || '' });
  const saveNote = el('button', {
    class: 'btn btn-secondary',
    type: 'button',
    text: 'حفظ الملاحظة',
    onclick: async () => {
      saveNote.disabled = true;
      try {
        await api(`/api/admin/licenses/${encodeURIComponent(license.id)}/note`, {
          method: 'POST',
          body: { note: noteInput.value.trim() === '' ? null : noteInput.value },
        });
        toast('حُفظت الملاحظة', 'success');
        renderLicenseDetail(license.id);
      } catch (err) {
        toast(describe(err, 'تعذّر حفظ الملاحظة'), 'error');
        saveNote.disabled = false;
      }
    },
  });

  const eventsCard = el('div', { class: 'card' }, [el('h2', { class: 'card-title', text: 'سجل الأحداث' })]);

  contentHost.replaceChildren(
    el('div', { class: 'card' }, [
      el('h2', { class: 'card-title', text: 'بيانات الترخيص' }),
      el('dl', { class: 'detail-list' }, fields.map(([label, value]) =>
        el('div', { class: 'detail-item' }, [el('dt', { text: label }), el('dd', {}, [value])]),
      )),
      el('div', { class: 'btn-group', style: 'margin-top:20px' }, actions),
    ]),
    el('div', { class: 'card' }, [
      el('h2', { class: 'card-title', text: 'الملاحظة الداخلية' }),
      noteInput,
      el('div', { style: 'margin-top:12px' }, [saveNote]),
    ]),
    el('div', { class: 'card' }, [
      el('h2', { class: 'card-title', text: `الأجهزة (${installs.length})` }),
      installs.length === 0
        ? el('p', { class: 'field-hint', text: 'لم يسجّل أي جهاز بعد.' })
        : el('div', { class: 'table-container' }, [
            el('table', {}, [
              el('thead', {}, [
                el('tr', {}, [
                  el('th', { text: 'معرّف التثبيت' }),
                  el('th', { text: 'المنصة' }),
                  el('th', { text: 'إصدار التطبيق' }),
                  el('th', { text: 'أول ظهور' }),
                  el('th', { text: 'آخر ظهور' }),
                ]),
              ]),
              el('tbody', {}, installs.map((install) =>
                el('tr', {}, [
                  el('td', { class: 'mono', text: install.installId }),
                  el('td', { text: install.platform || '—' }),
                  el('td', { text: install.appVersion || '—' }),
                  el('td', { text: formatDate(install.firstSeenAt) }),
                  el('td', { text: formatDate(install.lastSeenAt) }),
                ]),
              )),
            ]),
          ]),
    ]),
    eventsCard,
  );

  loadEvents(license.id, eventsCard);
}

/**
 * Fills in the event trail after the details are already on screen.
 *
 * Loaded separately from the detail call because it is the one thing on this page
 * that can fail on its own, and a licence an operator can see should stay
 * readable when the audit trail does not load.
 *
 * @param {string} licenseId
 * @param {HTMLElement} host
 */
async function loadEvents(licenseId, host) {
  try {
    const { events } = await api(
      `/api/admin/licenses/${encodeURIComponent(licenseId)}/events?limit=50`,
    );
    if (events.length === 0) {
      host.append(div('field-hint', 'لا توجد أحداث مسجّلة.'));
      return;
    }
    host.append(
      el('div', { class: 'table-container' }, [
        el('table', {}, [
          el('thead', {}, [
            el('tr', {}, [el('th', { text: 'الحدث' }), el('th', { text: 'الوقت' }), el('th', { text: 'السبب' })]),
          ]),
          el('tbody', {}, events.map((entry) =>
            el('tr', {}, [
              el('td', { text: entry.event }),
              el('td', { text: formatDate(entry.at) }),
              el('td', { text: entry.detail || '—' }),
            ]),
          )),
        ]),
      ]),
    );
  } catch (err) {
    // Shown as unavailable rather than as "no events" — an empty trail and an
    // unreadable trail are very different facts.
    host.append(div('field-hint', `تعذّر تحميل سجل الأحداث: ${describe(err, 'خطأ غير معروف')}`));
  }
}

/** @param {string} label @param {string} className @param {Function} onClick @returns {HTMLElement} */
function actionButton(label, className, onClick) {
  return el('button', { class: `btn ${className}`, type: 'button', text: label, onclick: onClick });
}

/**
 * Asks for a reason, then performs the status change.
 *
 * The confirmation dialog is a courtesy to the operator. It is not the control
 * that makes the change safe: `POST /api/admin/licenses/:id/revoke` is refused
 * for anyone the backend does not recognise as an administrator, whether or not
 * this dialog was ever shown.
 *
 * @param {object} license
 * @param {'suspend'|'reactivate'|'revoke'} action
 */
function confirmStatusAction(license, action) {
  const titles = {
    suspend: 'إيقاف الترخيص',
    reactivate: 'إعادة تفعيل الترخيص',
    revoke: 'إلغاء الترخيص نهائياً',
  };
  const warnings = {
    suspend: 'سيتوقف العميل عن البيع حتى إعادة التفعيل.',
    reactivate: 'سيعود العميل إلى العمل فوراً.',
    revoke: 'لا يمكن التراجع عن الإلغاء. ستبقى كل جلسات العميل غير صالحة.',
  };

  const reason = el('textarea', { rows: '2', placeholder: 'سبب الإجراء (اختياري)' });
  const confirm = actionButton('تأكيد', action === 'revoke' ? 'btn-danger' : 'btn-primary', async () => {
    confirm.disabled = true;
    try {
      await api(`/api/admin/licenses/${encodeURIComponent(license.id)}/${action}`, {
        method: 'POST',
        body: { reason: reason.value.trim() === '' ? null : reason.value },
      });
      closeModal();
      toast(titles[action], 'success');
      renderLicenseDetail(license.id);
    } catch (err) {
      toast(describe(err, 'تعذّر تنفيذ الإجراء'), 'error');
      confirm.disabled = false;
    }
  });

  openModal(
    titles[action],
    [
      el('div', { class: `callout ${action === 'revoke' ? 'danger' : 'warning'}`, text: warnings[action] }),
      el('div', { class: 'form-group' }, [el('label', { text: 'السبب' }), reason]),
    ],
    [actionButton('إلغاء', 'btn-secondary', closeModal), confirm],
  );
}

/* ==================================================================== *
 * go
 * ==================================================================== */

boot();
