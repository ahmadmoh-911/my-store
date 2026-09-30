/**
 * Reusable UI pieces: toasts, modals, bottom sheets, confirmation dialogs,
 * the success celebration and empty/loading states.
 */
import { icon } from './icons.js';
import { el, fromHTML, clear, escapeHTML, wait } from './utils.js';

/* ------------------------------------------------------------------ *
 * Toasts
 * ------------------------------------------------------------------ */

let toastTimer = null;

export function toast(message, type = '', ms = 2600) {
  let host = document.getElementById('toasts');
  if (!host) {
    // Never let a missing host turn a notification into a thrown error: callers
    // often have real work queued after the toast, and that work gets skipped.
    host = el('div.toasts', { id: 'toasts', 'aria-live': 'polite' });
    document.body.appendChild(host);
  }
  // one toast at a time keeps the header readable on a phone
  [...host.children].forEach((c) => c.remove());

  const ico = type === 'ok' ? 'checkCircle' : type === 'err' ? 'alertCircle' : type === 'warn' ? 'alert' : 'info';
  const node = el(`div.toast${type ? '.toast--' + type : ''}`, {}, fromHTML(icon(ico)), el('span', { text: message }));
  host.appendChild(node);

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.classList.add('is-out');
    node.addEventListener('animationend', () => node.remove(), { once: true });
  }, ms);
  return node;
}

/* ------------------------------------------------------------------ *
 * Scrim / focus trap shared by modal + sheet
 * ------------------------------------------------------------------ */

let openCount = 0;

function trapFocus(container) {
  const sel =
    'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';
  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    const items = [...container.querySelectorAll(sel)].filter((n) => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  container.addEventListener('keydown', onKey);
  return () => container.removeEventListener('keydown', onKey);
}

/* ------------------------------------------------------------------ *
 * Overlay stack
 *
 * Android's hardware back button has no equivalent of the Escape key, so the
 * topmost overlay is tracked here to give it something sensible to close.
 * ------------------------------------------------------------------ */

const overlayStack = [];

/**
 * Closes the most recently opened modal or sheet.
 * @returns {boolean} true if something was actually closed.
 */
export function closeTopOverlay() {
  const close = overlayStack[overlayStack.length - 1];
  if (!close) return false;
  close();
  return true;
}

function pushOverlay(close) {
  overlayStack.push(close);
}

function popOverlay(close) {
  const i = overlayStack.lastIndexOf(close);
  if (i !== -1) overlayStack.splice(i, 1);
}

/**
 * Opens a modal.
 * @returns {{close: Function, root: HTMLElement, panel: HTMLElement}}
 */
export function openModal({ title, body, foot, onClose, size = '', dismissable = true }) {
  const scrim = el('div.scrim');
  const panel = el(`div.modal__panel${size ? '.' + size : ''}`);
  const root = el('div.modal', {}, panel);

  if (title) {
    panel.appendChild(
      el(
        'div.modal__head',
        {},
        fromHTML(icon('sparkles')),
        el('h3', { text: title }),
        dismissable
          ? el('button.icon-btn', { type: 'button', 'aria-label': 'إغلاق', onClick: () => close() }, fromHTML(icon('x')))
          : null
      )
    );
  }

  const bodyWrap = el('div.modal__body');
  if (body) bodyWrap.appendChild(body.nodeType ? body : fromHTML(body));
  panel.appendChild(bodyWrap);

  if (foot) panel.appendChild(el('div.modal__foot', {}, foot));

  document.body.appendChild(scrim);
  document.body.appendChild(root);
  document.body.style.overflow = 'hidden';
  openCount++;

  const untrap = trapFocus(panel);
  let closed = false;

  function close(result) {
    if (closed) return;
    closed = true;
    popOverlay(close);
    untrap();
    scrim.classList.add('is-closing');
    root.classList.add('is-closing');
    openCount--;
    if (openCount <= 0) document.body.style.overflow = '';
    setTimeout(() => {
      scrim.remove();
      root.remove();
      onClose && onClose(result);
    }, 200);
  }

  if (dismissable) {
    scrim.addEventListener('click', () => close());
    panel.addEventListener('click', (e) => e.stopPropagation());
    root.addEventListener('click', (e) => {
      if (e.target === root) close();
    });
  }
  const onEsc = (e) => {
    if (e.key === 'Escape' && dismissable) {
      close();
      document.removeEventListener('keydown', onEsc);
    }
  };
  document.addEventListener('keydown', onEsc);
  pushOverlay(close);

  requestAnimationFrame(() => {
    const f = panel.querySelector('input,textarea,button:not(.icon-btn)');
    if (f) f.focus({ preventScroll: true });
  });

  return { close, root, panel, body: bodyWrap };
}

/** Bottom sheet — used for variant picking, filters, quick pickers. */
export function openSheet({ title, body, foot, onClose }) {
  const scrim = el('div.scrim');
  const sheet = el(
    'div.sheet',
    {},
    el('div.sheet__grip'),
    title
      ? el(
          'div.sheet__head',
          {},
          el('h3', { text: title }),
          el('button.icon-btn', { type: 'button', 'aria-label': 'إغلاق', onClick: () => close() }, fromHTML(icon('x')))
        )
      : null,
    el('div.sheet__body', {}, body && body.nodeType ? body : body ? fromHTML(body) : ''),
    foot ? el('div.sheet__foot', {}, foot) : null
  );

  document.body.appendChild(scrim);
  document.body.appendChild(sheet);
  document.body.style.overflow = 'hidden';
  openCount++;

  const untrap = trapFocus(sheet);
  let closed = false;

  function close(result) {
    if (closed) return;
    closed = true;
    popOverlay(close);
    untrap();
    scrim.classList.add('is-closing');
    sheet.classList.add('is-closing');
    openCount--;
    if (openCount <= 0) document.body.style.overflow = '';
    setTimeout(() => {
      scrim.remove();
      sheet.remove();
      onClose && onClose(result);
    }, 230);
  }

  scrim.addEventListener('click', () => close());
  const onEsc = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onEsc);
  sheet.addEventListener('keydown', onEsc);
  pushOverlay(close);

  return { close, root: sheet };
}

/* ------------------------------------------------------------------ *
 * Confirmation
 * ------------------------------------------------------------------ */

/**
 * @returns {Promise<boolean>}
 */
export function confirmDialog({
  title = 'هل أنت متأكد؟',
  message = '',
  confirmLabel = 'تأكيد',
  cancelLabel = 'إلغاء',
  danger = false,
}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const body = el(
      'div',
      { style: 'text-align:center;padding:6px 0 2px' },
      el(
        'div',
        {
          class: 'empty__art empty__art--sm',
          style: `margin:0 auto 12px;background:${danger ? 'var(--danger-tint)' : 'var(--brass-tint)'};color:${danger ? 'var(--danger)' : 'var(--brass-deep)'}`,
        },
        fromHTML(icon(danger ? 'alert' : 'helpCircle'))
      ),
      el('p', { html: escapeHTML(message), style: 'font-size:14.5px;color:var(--ink-2);line-height:1.65' })
    );

    const m = openModal({
      title,
      body,
      dismissable: true,
      onClose: () => done(false),
      foot: [
        el('button.btn', { type: 'button', text: cancelLabel, onClick: () => m.close(false) }),
        el(`button.btn.${danger ? 'btn--danger' : 'btn--primary'}`, {
          type: 'button',
          text: confirmLabel,
          onClick: () => {
            done(true);
            m.close(true);
          },
        }),
      ],
    });
  });
}

/** Compact prompt for a single text value. Resolves with null when cancelled. */
export function promptDialog({ title, label, value = '', placeholder = '', confirmLabel = 'حفظ' }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const input = el('input.input', { type: 'text', value, placeholder });
    const body = el(
      'div',
      {},
      el('div.field', {}, el('label.field__label', { text: label }), input)
    );

    const submit = () => {
      const v = input.value.trim();
      done(v);
      m.close();
    };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());

    const m = openModal({
      title,
      body,
      onClose: () => done(null),
      foot: [
        el('button.btn', { type: 'button', text: 'إلغاء', onClick: () => m.close() }),
        el('button.btn.btn--primary', { type: 'button', text: confirmLabel, onClick: submit }),
      ],
    });
    setTimeout(() => {
      input.focus();
      input.select();
    }, 60);
  });
}

/* ------------------------------------------------------------------ *
 * Success celebration — animated check + confetti
 * ------------------------------------------------------------------ */

/**
 * Full-screen success moment. Auto-dismisses; resolves when dismissed.
 * @param {{title:string, sub?:string, confetti?:boolean, ms?:number}} opts
 */
export function celebrate({ title, sub = '', confetti: burst = true, ms = 1500 }) {
  const root = el(
    'div.celebrate',
    {},
    el(
      'div',
      { class: 'success-pop' },
      el(
        'div.success-pop__ring',
        { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' }
      ),
      el('div.success-pop__title', { text: title }),
      sub ? el('div.success-pop__sub', { html: sub }) : null
    )
  );
  document.body.appendChild(root);

  return new Promise((resolve) => {
    // The burst is decorative: a failure to load or run it must never stop the
    // promise from resolving, otherwise whatever awaited it stalls forever.
    if (burst) {
      import('./utils.js')
        .then(({ confetti }) => setTimeout(() => confetti(innerWidth / 2, innerHeight * 0.42, 40), 140))
        .catch(() => {});
    }

    setTimeout(() => {
      root.classList.add('is-closing');
      setTimeout(() => {
        root.remove();
        resolve();
      }, 220);
    }, ms);
  });
}

/* ------------------------------------------------------------------ *
 * Empty & loading states
 * ------------------------------------------------------------------ */

/**
 * @param {{iconName:string, title:string, text?:string, action?:HTMLElement, small?:boolean}} opts
 */
export function emptyState({ iconName = 'inbox', title, text = '', action = null, small = false }) {
  return el(
    'div.empty',
    {},
    el(`div.empty__art${small ? '.empty__art--sm' : ''}`, {}, fromHTML(icon(iconName))),
    el('h3', { text: title }),
    text ? el('p', { text }) : null,
    action
  );
}

/** Skeleton stand-in for a grid of cards while data loads. */
export function skeletonGrid(count = 6, cls = 'pcard') {
  const wrap = el(`div.${cls === 'pcard' ? 'product-grid' : 'plist'}`);
  for (let i = 0; i < count; i++) {
    wrap.appendChild(
      el(
        'div',
        { class: cls === 'pcard' ? 'pcard' : 'prow' },
        el('div', {
          class: cls === 'pcard' ? 'pcard__media skeleton' : 'thumb skeleton',
          style: cls === 'pcard' ? '' : 'width:54px;height:54px;border-radius:12px',
        }),
        el(
          'div',
          { style: cls === 'pcard' ? 'padding:12px;display:grid;gap:8px' : 'flex:1;display:grid;gap:7px' },
          el('div.skeleton', { style: 'height:15px;width:70%;border-radius:7px' }),
          el('div.skeleton', { style: 'height:11px;width:45%;border-radius:7px' }),
          el('div.skeleton', { style: 'height:13px;width:35%;border-radius:7px' })
        )
      )
    );
  }
  return wrap;
}

export function loadingRow(text = 'جارٍ التحميل…') {
  return el('div.loading-row', {}, el('i.spinner.spinner--ink'), el('span', { text }));
}

/* ------------------------------------------------------------------ *
 * Small builders reused across screens
 * ------------------------------------------------------------------ */

export function sectionTitle(titleText, { iconName, count, action } = {}) {
  return el(
    'div.section-title',
    {},
    iconName ? fromHTML(icon(iconName)) : null,
    el('span', { text: titleText }),
    count !== undefined && count !== null ? el('span.count', { text: String(count) }) : null,
    action ? el('span', { style: 'margin-inline-start:auto' }, action) : null
  );
}

export function pageHead({ title, sub, actions = [], back = null, badge = null }) {
  return el(
    'div.page-head',
    {},
    back
      ? el('button.back-btn', { type: 'button', 'aria-label': 'رجوع', onClick: back }, fromHTML(icon('arrowBack')))
      : null,
    el(
      'div.page-head__text',
      {},
      el('h1.page-title', {}, el('span', { text: title }), badge || null),
      sub ? el('p.page-sub', { text: sub }) : null
    ),
    actions.length ? el('div.page-head__actions', {}, actions) : null
  );
}

/** Standard empty-state + skeleton swap for list screens. */
export function mountList(host, { isEmpty, empty, make }) {
  clear(host);
  if (isEmpty) host.appendChild(empty);
  else host.appendChild(make());
}
