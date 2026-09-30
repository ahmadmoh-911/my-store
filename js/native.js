/**
 * Capacitor bridge helpers for the Android build.
 *
 * The app is a PWA first, so nothing here may be *required* for the web build —
 * every native path sits behind isNative(), and plugins are read off the
 * Capacitor bridge proxy (Capacitor.Plugins) instead of being imported. The
 * plugin JS packages are not part of the bundled web assets, so a static
 * import of them would break the browser build with a 404 on module load.
 */

const bridge = () => (typeof window !== 'undefined' && window.Capacitor) || null;

/** @returns {boolean} true inside the Android (Capacitor) shell. */
export function isNative() {
  const c = bridge();
  return !!(c && typeof c.isNativePlatform === 'function' && c.isNativePlatform());
}

function plugin(name) {
  const c = bridge();
  return c && c.Plugins ? c.Plugins[name] : null;
}

/* ------------------------------------------------------------------ *
 * Printing / PDF
 * ------------------------------------------------------------------ */

/**
 * Prints the current page. WebView has no window.print(), so natively the page
 * is handed to the platform print pipeline (see NativePrint.java).
 *
 * The whole live DOM is serialised on purpose: the app's own @media print rules
 * decide what shows, which is the same contract the desktop print path relies
 * on. Passing a stripped-down fragment instead would silently drop the layout.
 */
export async function printPage() {
  if (!isNative()) {
    window.print();
    return;
  }

  const p = plugin('NativePrint');
  if (!p) {
    console.warn('[native] NativePrint plugin missing — falling back to window.print()');
    window.print();
    return;
  }

  const label = (document.getElementById('topbar-context')?.textContent || 'متجري').trim();
  await p.print({
    html: '<!doctype html>\n' + document.documentElement.outerHTML,
    jobName: label,
  });

  // Android never fires afterprint, so run the same cleanup the browser path
  // does (it drops the large print-root table out of the DOM).
  setTimeout(() => window.dispatchEvent(new Event('afterprint')), 600);
}

/* ------------------------------------------------------------------ *
 * File export
 * ------------------------------------------------------------------ */

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Saves a blob to the device and offers the Android share sheet.
 * <a download> is inert inside a WebView, so exports have to go through here.
 *
 * @returns {Promise<boolean>} true if the file reached the device.
 */
export async function saveBlob(blob, filename) {
  const fs = plugin('Filesystem');
  if (!fs) return false;

  const written = await fs.writeFile({
    path: filename,
    data: await toBase64(blob),
    directory: 'Documents',
    recursive: true,
  });

  const share = plugin('Share');
  if (share) {
    try {
      await share.share({
        title: filename,
        text: filename,
        files: [written.uri],
        dialogTitle: filename,
      });
    } catch {
      // the file is already on disk; a dismissed sheet is not a failure
    }
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Sharing
 * ------------------------------------------------------------------ */

/**
 * Shares plain text through the Android share sheet.
 *
 * Android WebView does not implement the Web Share API, so the plugin stands in
 * for it. Cancelling is reported separately from "no plugin" because the two
 * need different handling in the caller.
 *
 * @returns {Promise<'shared'|'cancelled'|'unavailable'>}
 */
export async function shareText(title, text) {
  if (!isNative()) return 'unavailable';
  const share = plugin('Share');
  if (!share) return 'unavailable';
  try {
    await share.share({ title, text, dialogTitle: title });
    return 'shared';
  } catch {
    return 'cancelled';
  }
}

/* ------------------------------------------------------------------ *
 * Hardware back button
 * ------------------------------------------------------------------ */

/**
 * @param {(info:{canGoBack:boolean}) => void|Promise<void>} handler
 * @returns {() => void} unsubscribe
 */
export function onNativeBack(handler) {
  if (!isNative()) return () => {};
  const app = plugin('App');
  if (!app) return () => {};
  const handle = app.addListener('backButton', handler);
  return () => handle.then((h) => h.remove()).catch(() => {});
}

/** Sends the app to the background instead of killing it. */
export function minimizeApp() {
  const app = plugin('App');
  return app ? app.minimizeApp() : Promise.resolve();
}
