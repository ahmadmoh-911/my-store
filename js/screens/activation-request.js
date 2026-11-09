/**
 * Activation & support request screen.
 *
 * Lets a shop owner send a request to the admin panel:
 *
 *   - تفعيل جديد (activation) — "I have a licence code, help me activate it"
 *   - نقل جهاز (device_transfer) — "I moved to a new phone"
 *   - مشكلة ترخيص (license_issue) — "My licence stopped working"
 *   - دعم فني (support) — general technical support
 *
 * The request goes to `POST /api/activation-requests` on the backend. No
 * session is required — anyone can submit. The admin reviews it in the
 * portal at /admin/#/requests.
 *
 * No sales, inventory or backup data is ever sent with the request.
 */
import { el, fromHTML, clear } from '../utils.js';
import { pageHead, toast } from '../components.js';
import { navigate } from '../router.js';
import { buildApiUrl } from '../api-config.js';
import { getLocalAuthSession } from '../auth-client.js';
import { getAppVersion } from '../version.js';
import { isInterim } from '../build-config.js';

const REQUEST_TYPES = [
  { value: 'activation', label: 'تفعيل جديد', hint: 'لديّ رمز ترخيص وأريد تفعيله' },
  { value: 'device_transfer', label: 'نقل جهاز', hint: 'انتقلت إلى هاتف جديد وأريد نقل الترخيص' },
  { value: 'license_issue', label: 'مشكلة ترخيص', hint: 'الترخيص متوقف أو منتهي أو تم إلغاؤه' },
  { value: 'support', label: 'دعم فني', hint: 'استفسار تقني أو مشكلة في التطبيق' },
];

export function render() {
  const root = el('div.screen', { id: 'screen-activation-request' });

  root.appendChild(
    pageHead({
      title: 'طلب تفعيل أو دعم',
      sub: 'يُsend الطلب إلى لوحة الإدارة للمراجعة',
    }),
  );

  const host = el('div', { id: 'activation-request-host' });
  root.appendChild(host);

  boot(host);
  return root;
}

async function boot(host) {
  const s = await getLocalAuthSession();
  const appVersion = getAppVersion();

  clear(host);

  // In interim build there is no backend: activation requests cannot be sent.
  // Show an informational card instead of a form that would fail. This does
  // not block local selling — the interim gate and POS keep working offline.
  if (isInterim()) {
    host.appendChild(
      el('div.card', {}, [
        el('h2', { class: 'card-title', text: 'إرسال طلب إلى الإدارة' }),
        el('p', { class: 'field-hint', text: 'هذه النسخة مؤقتة ولا تحتوي على خادم تفعيل. لا يمكن إرسال طلبات التفعيل أو الدعم في هذا الوضع.' }),
        el('p', { class: 'field-hint', text: 'البيع المحلي يستمر العمل كالمعتاد دون تأثير.' }),
        el('button.btn.btn--secondary', {
          type: 'button',
          text: 'العودة للرئيسية',
          onclick: () => navigate('dashboard'),
        }),
      ]),
    );
    return;
  }

  // Header card explaining what happens
  host.appendChild(
    el('div.card', {}, [
      el('h2', { class: 'card-title', text: 'إرسال طلب إلى الإدارة' }),
      el('p', { class: 'field-hint', text: 'يُرسل طلبك إلى لوحة إدارة المتاجر. لا تُرسل أي بيانات مبيعات أو مخزون — فقط المعلومات التي تكتبها أدناه.' }),
      el('p', { class: 'field-hint', text: `الإصدار: ${appVersion} — المنصة: ${isInterim() ? 'مؤقت (interim)' : 'كامل (full)'}` }),
    ]),
  );

  const form = el('form', { class: 'card', novalidate: '' }, [
    // Request type
    el('div', { class: 'form-group' }, [
      el('label', { for: 'req-type', text: 'نوع الطلب *' }),
      el('select', { id: 'req-type', required: '' },
        REQUEST_TYPES.map((t) => el('option', { value: t.value, text: `${t.label} — ${t.hint}` })),
      ),
    ]),

    // Store name
    el('div', { class: 'form-group' }, [
      el('label', { for: 'req-store', text: 'اسم المتجر *' }),
      el('input', { id: 'req-store', type: 'text', required: '', placeholder: 'مثال: متجر النور للأقمشة' }),
    ]),

    // Requester name
    el('div', { class: 'form-group' }, [
      el('label', { for: 'req-requester', text: 'اسمك *' }),
      el('input', { id: 'req-requester', type: 'text', required: '', placeholder: 'مثال: أحمد محمد' }),
    ]),

    // Contact (optional)
    el('div', { class: 'form-group' }, [
      el('label', { for: 'req-contact', text: 'طريقة التواصل (اختياري)' }),
      el('input', { id: 'req-contact', type: 'text', placeholder: 'رقم هاتف أو بريد إلكتروني' }),
      el('div', { class: 'field-hint', text: 'يُستخدم فقط للتواصل معك بشأن طلبك.' }),
    ]),

    // Description
    el('div', { class: 'form-group' }, [
      el('label', { for: 'req-description', text: 'وصف الطلب *' }),
      el('textarea', { id: 'req-description', rows: '4', required: '', placeholder: 'اذكر ما تحتاجه بوضوح…' }),
      el('div', { class: 'field-hint', text: 'الحد الأقصى 2000 حرف.' }),
    ]),

    el('div', { class: 'btn-group', style: 'margin-top:16px' }, [
      el('button', { class: 'btn btn-primary', type: 'submit', text: 'إرسال الطلب' }),
      el('button', { class: 'btn btn-secondary', type: 'button', text: 'إلغاء', onclick: () => navigate('dashboard') }),
    ]),
  ]);

  // Pre-fill requester name from Google account if signed in
  if (s?.email) {
    const input = host.querySelector('#req-requester');
    if (input) input.value = s.email;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'جارٍ الإرسال…';

    try {
      const typeSelect = form.querySelector('#req-type');
      const storeInput = form.querySelector('#req-store');
      const requesterInput = form.querySelector('#req-requester');
      const contactInput = form.querySelector('#req-contact');
      const descInput = form.querySelector('#req-description');

      const installId = await getOrCreateInstallId();

      const payload = {
        id: crypto.randomUUID(),
        type: typeSelect.value,
        storeName: storeInput.value.trim(),
        requesterName: requesterInput.value.trim(),
        contact: contactInput.value.trim(),
        description: descInput.value.trim(),
        appVersion,
        platform: isInterim() ? 'android-interim' : 'android-full',
        installId,
        ...(s?.googleSub ? { googleSub: s.googleSub } : {}),
      };

      const res = await fetch(buildApiUrl('/api/activation-requests'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `HTTP ${res.status}`);
      }

      const result = await res.json();

      toast('تم إرسال الطلب بنجاح', 'success');

      // Show reference number
      el('div', {}, [
        el('div.card', {}, [
          el('h3', { text: 'رقم مرجعي لطلبك' }),
          el('code', { class: 'mono', text: result.request.id }),
          el('p', { class: 'field-hint', text: 'احتفظ بهذا الرقم للمراجعة لاحقًا. يمكنك مراجعة حالة الطلب من شاشة الإعدادات.' }),
          el('button', {
            class: 'btn btn-primary',
            type: 'button',
            text: 'العودة للرئيسية',
            onclick: () => navigate('dashboard'),
          }),
        ]),
      ]);
      form.replaceChildren();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'إرسال الطلب';
      toast(`تعذّر الإرسال: ${err.message}`, 'error');
    }
  });

  host.appendChild(form);
}

/** Persists a random install id so the same device can be recognized. */
async function getOrCreateInstallId() {
  const key = 'saher.installId.v1';
  try {
    let id = localStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

export default { render };
