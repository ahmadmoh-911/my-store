/**
 * Shared helpers: DOM building, formatting, animation, file utilities.
 */
import { icon } from './icons.js';
import { isNative, saveBlob } from './native.js';

/* ------------------------------------------------------------------ *
 * DOM
 * ------------------------------------------------------------------ */

/**
 * Tiny hyperscript-style element builder.
 *   el('div.card', { onClick }, child, child…)
 * Props: className/class, text, html, dataset {}, style {}, on* handlers,
 * anything else lands as an attribute.
 */
export function el(spec, props = null, ...children) {
  const [tagPart, ...classes] = String(spec).split('.');
  const node = document.createElement(tagPart || 'div');
  if (classes.length) node.className = classes.join(' ');

  if (props && (props.nodeType || Array.isArray(props) || typeof props === 'string')) {
    children.unshift(props);
    props = null;
  }

  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class' || k === 'className') node.className += (node.className ? ' ' : '') + v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k === 'style') {
        // accept both `style: 'color:red'` and `style: { color: 'red' }`
        if (typeof v === 'string') node.style.cssText += v;
        else Object.assign(node.style, v);
      }
      else if (k === 'value') node.value = v;
      else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, v);
    }
  }
  appendAll(node, children);
  return node;
}

export function appendAll(node, children) {
  for (const c of children.flat(4)) {
    if (c === null || c === undefined || c === false || c === '') continue;
    node.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  appendAll(f, children);
  return f;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** html string → element (used for icon markup and templates) */
export function fromHTML(str) {
  const t = document.createElement('template');
  t.innerHTML = str.trim();
  return t.content.firstElementChild;
}

export function escapeHTML(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

/* ------------------------------------------------------------------ *
 * Identity / misc
 * ------------------------------------------------------------------ */

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function debounce(fn, ms = 220) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function sum(arr, pick = (x) => x) {
  return arr.reduce((a, b) => a + (Number(pick(b)) || 0), 0);
}

export function groupBy(arr, key) {
  return arr.reduce((acc, item) => {
    const k = typeof key === 'function' ? key(item) : item[key];
    (acc[k] ||= []).push(item);
    return acc;
  }, {});
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

/** Western digits with grouping — matches the reference screens. */
const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const nfInt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function num(n) {
  return Number.isFinite(+n) ? nf.format(+n) : '0';
}
export function numInt(n) {
  return Number.isFinite(+n) ? nfInt.format(Math.round(+n)) : '0';
}

export function money(n, currency = 'ILS') {
  return `${num(n)} ${currency}`;
}

/** Markup variant used inside .amount spans. */
export function moneyHTML(n, currency = 'ILS') {
  return `${num(n)}<span class="cur">${escapeHTML(currency)}</span>`;
}

const AR_MONTHS = [
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
];
const AR_DAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

export function fmtDate(d, withTime = false) {
  const date = d instanceof Date ? d : new Date(d);
  const base = `${date.getDate()} ${AR_MONTHS[date.getMonth()]} ${date.getFullYear()}`;
  if (!withTime) return base;
  return `${base} — ${fmtTime(date)}`;
}

export function fmtTime(d) {
  const date = d instanceof Date ? d : new Date(d);
  let h = date.getHours();
  const m = String(date.getMinutes()).padStart(2, '0');
  const suffix = h < 12 ? 'ص' : 'م';
  h = h % 12 || 12;
  return `${h}:${m} ${suffix}`;
}

export function fmtDayName(d) {
  return AR_DAYS[(d instanceof Date ? d : new Date(d)).getDay()];
}

/** yyyy-mm-dd for <input type="date"> and comparisons — always LOCAL time. */
export function isoDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/**
 * The local calendar day a stored timestamp belongs to.
 *
 * Sale timestamps are stored as UTC ISO strings (`toISOString()`), so slicing
 * one to `yyyy-mm-dd` yields the *UTC* day, which is a different day from the
 * shop's for the hours around local midnight. Anything that groups records by
 * day has to go through here, so "today" means the same thing on the dashboard,
 * in the reports and in the receipt numbering.
 *
 * @param {string|Date|number} timestamp
 * @returns {string} yyyy-mm-dd in local time, or '' if the input is unusable
 */
export function dayKeyOf(timestamp) {
  // Guard the null/undefined/'' case explicitly: `new Date(null)` is the epoch,
  // which is a *valid* date and would file the record under 1970-01-01.
  if (timestamp === null || timestamp === undefined || timestamp === '') return '';
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '' : isoDate(date);
}

export function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function endOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function relTime(ts) {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'الآن';
  if (mins < 60) return `منذ ${mins} دقيقة`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `منذ ${hrs} ساعة`;
  const days = Math.round(hrs / 24);
  if (days === 1) return 'أمس';
  if (days < 30) return `منذ ${days} يوم`;
  return fmtDate(ts);
}

/* ------------------------------------------------------------------ *
 * Animation helpers (Web Animations API — no library needed)
 * ------------------------------------------------------------------ */

/** Count a number up inside an element; runs once when it scrolls into view. */
export function countUp(node, to, opts = {}) {
  const {
    duration = 950,
    decimals = 0,
    prefix = '',
    suffix = '',
    format = true,
  } = opts;
  const from = 0;
  const start = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3); // ease-out cubic

  function frame(now) {
    const t = clamp((now - start) / duration, 0, 1);
    const v = from + (to - from) * ease(t);
    const shown = decimals > 0 ? v.toFixed(decimals) : Math.round(v);
    node.textContent = prefix + (format ? numInt(shown) : shown) + suffix;
    if (t < 1) requestAnimationFrame(frame);
    else {
      const final = decimals > 0 ? (+to).toFixed(decimals) : Math.round(to);
      node.textContent = prefix + (format ? num(final) : final) + suffix;
    }
  }
  requestAnimationFrame(frame);
  return node;
}

/** One-shot ripple feedback on any pressable element. */
export function ripple(e, node) {
  const r = node.getBoundingClientRect();
  const d = document.createElement('i');
  d.className = 'btn__ripple';
  d.style.setProperty('--rx', `${e.clientX - r.left}px`);
  d.style.setProperty('--ry', `${e.clientY - r.top}px`);
  node.appendChild(d);
  d.addEventListener('animationend', () => d.remove());
}

/** Clone an element's image and fly it to a target box (POS add-to-cart). */
export function flyTo(source, target, src) {
  if (!source || !target) return Promise.resolve();
  const from = source.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  if (from.width === 0 || to.width === 0) return Promise.resolve();

  const layer = document.getElementById('fly-layer');
  const img = document.createElement(src ? 'img' : 'div');
  if (src) img.src = src;
  img.className = 'fly-img';
  Object.assign(img.style, {
    left: `${from.left}px`,
    top: `${from.top}px`,
    width: `${from.width}px`,
    height: `${from.height}px`,
  });
  layer.appendChild(img);

  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);

  const anim = img.animate(
    [
      { transform: 'translate3d(0,0,0) scale(1)', opacity: 1, offset: 0 },
      {
        transform: `translate3d(${dx * 0.55}px, ${dy * 0.45 - 46}px, 0) scale(0.72)`,
        opacity: 1,
        offset: 0.55,
      },
      {
        transform: `translate3d(${dx}px, ${dy}px, 0) scale(0.14)`,
        opacity: 0.15,
        offset: 1,
      },
    ],
    { duration: 620, easing: 'cubic-bezier(.4,.1,.25,1)' }
  );
  return anim.finished.then(() => img.remove()).catch(() => img.remove());
}

/** Burst of soft confetti around a centre point. */
export function confetti(originX = innerWidth / 2, originY = innerHeight / 2, count = 34) {
  const layer = document.createElement('div');
  layer.className = 'confetti-layer';
  document.body.appendChild(layer);
  const colors = ['#6b1d2f', '#c99750', '#1b3b36', '#ffd9dd', '#8a9e6f', '#b06a76'];

  for (let i = 0; i < count; i++) {
    const p = document.createElement('i');
    p.className = 'confetti';
    p.style.background = colors[i % colors.length];
    p.style.left = `${originX}px`;
    p.style.top = `${originY}px`;
    layer.appendChild(p);

    const angle = (Math.random() * Math.PI * 2);
    const dist = 70 + Math.random() * 190;
    const x = Math.cos(angle) * dist;
    const y = Math.sin(angle) * dist - 70;
    const rot = (Math.random() - 0.5) * 720;

    p.animate(
      [
        { transform: 'translate3d(0,0,0) rotate(0deg) scale(1)', opacity: 1 },
        { transform: `translate3d(${x}px, ${y}px, 0) rotate(${rot}deg) scale(1)`, opacity: 1, offset: 0.55 },
        { transform: `translate3d(${x * 1.1}px, ${y + 190}px, 0) rotate(${rot * 1.4}deg) scale(0.7)`, opacity: 0 },
      ],
      { duration: 1250 + Math.random() * 550, easing: 'cubic-bezier(.2,.6,.3,1)', fill: 'forwards' }
    );
  }
  setTimeout(() => layer.remove(), 2100);
}

/** Bump an element's scale briefly (used when a total changes). */
export function nudge(node) {
  if (!node) return;
  node.animate(
    [
      { transform: 'scale(1)' },
      { transform: 'scale(1.07)', offset: 0.4 },
      { transform: 'scale(1)' },
    ],
    { duration: 320, easing: 'cubic-bezier(.34,1.56,.64,1)' }
  );
}

/* ------------------------------------------------------------------ *
 * Files
 * ------------------------------------------------------------------ */

/**
 * Saves a blob as a file.
 *
 * On Android the anchor download below is inert, so it is routed through the
 * Capacitor filesystem/share bridge instead. The browser branch is untouched
 * so the web build behaves exactly as before.
 *
 * @returns {Promise<boolean>} whether the file was actually delivered
 */
export async function downloadBlob(blob, filename) {
  if (isNative()) {
    try {
      return await saveBlob(blob, filename);
    } catch (err) {
      console.warn('[files] native export failed', err);
      return false;
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return true;
}

export function downloadText(text, filename, type = 'text/plain;charset=utf-8') {
  return downloadBlob(new Blob(['\ufeff' + text], { type }), filename); // BOM keeps Excel happy with Arabic
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      resolve(input.files && input.files[0] ? input.files[0] : null);
      input.remove();
    });
    // cancel path: focus returning without a change event
    window.addEventListener(
      'focus',
      () => setTimeout(() => {
        if (input.parentNode) {
          resolve(null);
          input.remove();
        }
      }, 500),
      { once: true }
    );
    input.click();
  });
}

export function readFileAsDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

export function readFileAsText(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsText(file);
  });
}

/**
 * Downscale + recompress an image to a data URL.
 * Storing base64 keeps IndexedDB blobs JSON-serialisable, so the JSON backup
 * includes pictures — and capping the size keeps storage use sane.
 */
export function processImage(file, maxEdge = 900, quality = 0.82) {
  return readFileAsDataURL(file).then(
    (dataUrl) =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          let { width: w, height: h } = img;
          if (Math.max(w, h) > maxEdge) {
            const k = maxEdge / Math.max(w, h);
            w = Math.round(w * k);
            h = Math.round(h * k);
          }
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          resolve(c.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
      })
  );
}

/* ------------------------------------------------------------------ *
 * Misc UI helpers
 * ------------------------------------------------------------------ */

export function initials(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '؟';
  return (parts[0][0] || '') + (parts[1] ? parts[1][0] : '');
}

export function iconEl(name, cls = '') {
  return fromHTML(icon(name, undefined, cls));
}

export function setBusy(btn, busy, label) {
  if (!btn) return;
  if (busy) {
    btn.dataset.prevHtml = btn.innerHTML;
    btn.classList.add('is-busy');
    btn.innerHTML = `<i class="spinner"></i>${label ? `<span>${escapeHTML(label)}</span>` : ''}`;
  } else {
    btn.classList.remove('is-busy');
    if (btn.dataset.prevHtml) btn.innerHTML = btn.dataset.prevHtml;
  }
}

/** Simple CSV writer that handles quotes, newlines and Arabic. */
export function toCSV(rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(esc).join(',')).join('\r\n');
}
