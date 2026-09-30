/**
 * Barcode scanning.
 *
 * Three layers, tried in order, so the camera always has the best chance:
 *
 *  1. Google ML Kit via the native Capacitor plugin (Android shell only) — the
 *     same on-device engine behind Google Lens.
 *  2. html5-qrcode over getUserMedia, using the vendor copy already loaded by
 *     index.html. This is the path the Android WebView actually takes.
 *  3. Manual entry, as a last resort.
 *
 * Plugins are read off the bridge (Capacitor.Plugins) and never imported: the
 * web build ships no bundler and no node_modules, so a bare
 * `import('@capacitor-mlkit/barcode-scanning')` can only ever fail to resolve.
 */
import { el } from './utils.js';
import { openModal, toast } from './components.js';

/* ------------------------------------------------------------------ *
 * 1. Native: Google ML Kit
 * ------------------------------------------------------------------ */

function nativeScanner() {
  const c = typeof window !== 'undefined' ? window.Capacitor : null;
  return c && c.Plugins ? c.Plugins.BarcodeScanner : null;
}

async function scanNative() {
  const scanner = nativeScanner();
  if (!scanner) return { unavailable: true };

  if (typeof scanner.requestPermissions === 'function') {
    const perm = await scanner.requestPermissions();
    if (perm && perm.camera && perm.camera !== 'granted') {
      return { error: 'صلاحية الكاميرا مرفوضة' };
    }
  }

  const result = await scanner.scan();
  const first = result && result.barcodes && result.barcodes[0];
  if (!first) return null;
  return first.displayValue || first.rawValue || null;
}

/* ------------------------------------------------------------------ *
 * 2. Web: html5-qrcode
 * ------------------------------------------------------------------ */

const READER_ID = 'scan-reader';

/** Picks the rear camera — `facingMode` is unreliable inside an Android WebView. */
async function pickCamera() {
  const cameras = await window.Html5Qrcode.getCameras();
  if (!cameras || !cameras.length) return null;
  return (
    cameras.find((c) => /back|rear|environment|خلف/i.test(c.label)) ||
    cameras[cameras.length - 1]
  );
}

function scanWeb() {
  return new Promise((resolve) => {
    const reader = el('div', {
      id: READER_ID,
      style: {
        width: '100%',
        minHeight: '62vh',
        background: '#000',
        borderRadius: 'var(--r-md)',
        overflow: 'hidden',
      },
    });

    let settled = false;
    let scanner = null;
    let started = false;

    const done = (value) => {
      if (settled) return;
      settled = true;
      // The camera has to be released before the modal goes away, otherwise the
      // LED stays on and the next scan fails to acquire the device.
      stop().finally(() => {
        m.close();
        resolve(value);
      });
    };

    const stop = async () => {
      if (!scanner || !started) return;
      started = false;
      try {
        await scanner.stop();
        scanner.clear();
      } catch {
        /* already torn down */
      }
    };

    const m = openModal({
      title: 'وجّه الكاميرا نحو الباركود',
      body: el(
        'div',
        {},
        reader,
        el('p.tiny.muted.scan__hint', {
          text: 'وجّه الكاميرا نحو الباركود — سيُقرأ تلقائياً.',
          style: { marginTop: '10px', textAlign: 'center' },
        })
      ),
      onClose: () => {
        if (settled) return;
        settled = true;
        stop().finally(() => resolve(null));
      },
    });

    const onDecoded = (text) => done(String(text).trim());
    const onDecodeError = () => {
      /* not a barcode this frame — keep scanning */
    };

    (async () => {
      try {
        if (!window.Html5Qrcode) throw new Error('html5-qrcode unavailable');
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('getUserMedia unavailable');
        }

        const camera = await pickCamera();
        if (!camera) throw new Error('no camera found');

        scanner = new window.Html5Qrcode(READER_ID, false);
        await scanner.start(
          camera.id,
          { fps: 10, qrbox: { width: 240, height: 150 }, aspectRatio: 1.6 },
          onDecoded,
          onDecodeError
        );
        started = true;
      } catch (err) {
        console.warn('[scan] web scanner failed', err);
        if (!settled) {
          settled = true;
          stop().finally(() => {
            m.close();
            resolve({ error: describeCameraError(err) });
          });
        }
      }
    })();
  });
}

function describeCameraError(err) {
  const name = err && (err.name || err.message) ? String(err.name || err.message) : '';
  if (/NotAllowed|Permission/i.test(name)) return 'صلاحية الكاميرا مرفوضة';
  if (/NotFound|Requested device/i.test(name)) return 'لا يوجد كاميرا متاحة';
  if (/NotReadable|TrackStart/i.test(name)) return 'الكاميرا مستخدمة من تطبيق آخر';
  if (/getUserMedia unavailable/i.test(name)) return 'متصفح التطبيق لا يدعم الكاميرا';
  return 'تعذّر تشغيل الكاميرا';
}

/* ------------------------------------------------------------------ *
 * 3. Manual entry
 * ------------------------------------------------------------------ */

function askManually(title) {
  return new Promise((resolve) => {
    const input = el('input.input', {
      id: 'scan-code',
      type: 'text',
      placeholder: 'اكتب رقم الباركود ثم Enter',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      inputmode: 'numeric',
      style: { direction: 'ltr', textAlign: 'center', letterSpacing: '.08em' },
    });

    const submit = () => {
      const code = input.value.trim();
      if (!code) {
        input.focus();
        return;
      }
      m.close();
      resolve(code);
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    });

    const m = openModal({
      title,
      body: el(
        'div',
        {},
        input,
        el('p.tiny.muted', {
          text: 'الرقم الطويل أسفل الباركود، أو أي كود مطبوع على المنتج.',
          style: { marginTop: '10px' },
        })
      ),
      foot: [el('button.btn.btn--primary', { type: 'button', text: 'تأكيد', onClick: submit })],
      onClose: () => resolve(null),
    });

    setTimeout(() => input.focus(), 60);
  });
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Scans one barcode, trying the native engine first, then the web one.
 * @returns {Promise<string|null>}
 */
export async function scanBarcode({ title = 'مسح الباركود' } = {}) {
  // 1. Google ML Kit — only present inside the Android shell.
  try {
    const native = await scanNative();
    if (!native) return null; // scanned, or the user dismissed the native view
    if (!native.unavailable && !native.error) return native;
    if (native.error) console.warn('[scan] native:', native.error);
  } catch (err) {
    console.warn('[scan] native failed', err);
  }

  // 2. html5-qrcode in the WebView.
  let web;
  try {
    web = await scanWeb();
  } catch (err) {
    console.warn('[scan] web failed', err);
    web = { error: describeCameraError(err) };
  }
  if (typeof web === 'string') return web;
  if (web) {
    toast(`${web.error} — أدخل الباركود يدوياً`, 'warn', 3400);
  }

  // 3. Manual entry.
  return await askManually(title);
}

export function cameraAvailable() {
  return true;
}

export function listenForScan(onCode) {
  let buffer = '';
  let last = 0;

  const onKey = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    const now = Date.now();
    if (now - last > 90) buffer = '';
    last = now;

    if (e.key === 'Enter') {
      if (buffer.length >= 4) {
        e.preventDefault();
        const code = buffer;
        buffer = '';
        onCode(code);
      }
      return;
    }
    if (e.key.length === 1) buffer += e.key;
  };

  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}

export function reportMissing(code) {
  toast(`لا يوجد منتج بالباركود ${code}`, 'warn', 2600);
}
