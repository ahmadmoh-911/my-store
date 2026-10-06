/**
 * Talks to the Store Hub backend about Google Drive authorisation.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Why this is a separate module from `drive-client.js`
 * ─────────────────────────────────────────────────────────────────────────
 * `drive-client.js` holds an invariant that is worth more than tidiness: every
 * URL it builds points at `googleapis.com`. That is the mechanical reason the
 * backend cannot be on the backup data path — there is no code in that file
 * capable of sending a product, a sale or a backup byte to us, because there is
 * no code in it that addresses us at all.
 *
 * Mixing four `/api/drive/*` calls into that file would quietly destroy the
 * invariant to save a filename. So the split is: this file asks the backend for
 * a *short-lived access token*, and `drive-client.js` uses that token to talk
 * to Google. The backup JSON itself never passes between them.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * What these four calls can and cannot do
 * ─────────────────────────────────────────────────────────────────────────
 * They can: report whether Drive is connected, mint an access token for the
 * *caller's own* Google account, start the OAuth consent, drop the grant.
 *
 * They cannot: read or write a product, a sale, an inventory line, a report, an
 * invoice, or a backup file. None of them accepts a request body at all — the
 * server never reads one on these routes — so no API here can be coaxed into
 * storing customer business data, no matter what is sent to it.
 *
 * Dependency-injected like `auth-client.js`, so tests stub the network and this
 * module never touches the DOM.
 */

import { resolveClientBase } from './api-config.js';

/** @typedef {{baseUrl?: string, fetchImpl?: typeof fetch}} DriveAuthClientOptions */

function resolveFetch(options) {
  const impl = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);
  if (!impl) throw new Error('لا يوجد اتصال بالإنترنت');
  return impl;
}

function getBase(options) {
  return (options.baseUrl || resolveClientBase('drive')).replace(/\/+$/, '');
}

/**
 * Reads the connection state for display in Settings.
 *
 * @param {DriveAuthClientOptions} [options]
 * @returns {Promise<{connected: boolean, configured: boolean, scope: string|null, folderName: string, enabled: boolean}>}
 */
export async function getDriveStatus(options = {}) {
  const base = getBase(options);
  const res = await resolveFetch(options)(`${base}/status`, {
    method: 'GET',
    credentials: 'same-origin',
  });
  const body = await res.json();
  if (!res.ok || !body?.ok) {
    const err = new Error(body?.error?.message || 'تعذّر قراءة حالة Google Drive');
    err.code = body?.error?.code || 'DRIVE_STATUS_FAILED';
    throw err;
  }
  return {
    connected: body.connected === true,
    configured: body.configured === true,
    scope: body.scope ?? null,
    folderName: body.folderName || 'Store Hub Backups',
    enabled: body.enabled !== false,
  };
}

/**
 * Mints a short-lived, `drive.file`-scoped access token for the signed-in
 * account. Rejected by the backend with `DRIVE_NOT_CONNECTED` when Drive has
 * not been connected, which callers treat as "not connected" rather than as a
 * fault.
 *
 * @param {DriveAuthClientOptions} [options]
 * @returns {Promise<{accessToken: string, expiresAt: number, scope: string}>}
 */
export async function getDriveAccessToken(options = {}) {
  const base = getBase(options);
  const res = await resolveFetch(options)(`${base}/token`, {
    method: 'GET',
    credentials: 'same-origin',
  });
  const body = await res.json();
  if (!res.ok || !body?.ok) {
    const err = new Error(body?.error?.message || 'تعذّر الحصول على إذن Google Drive');
    // Preserved so the scheduler can distinguish "never connected" from a real
    // outage, and stay quiet about the former.
    err.code = body?.error?.code || 'DRIVE_TOKEN_FAILED';
    err.notConnected = err.code === 'DRIVE_NOT_CONNECTED';
    throw err;
  }
  return { accessToken: body.accessToken, expiresAt: body.expiresAt, scope: body.scope };
}

/**
 * Begins the consent flow.
 *
 * The caller is expected to navigate to the returned `authUrl` in a popup. The
 * backend's callback closes the popup and posts the result back, which is why
 * no return URL needs to be configured anywhere.
 *
 * @param {DriveAuthClientOptions} [options]
 * @returns {Promise<{authUrl: string}>}
 */
export async function startDriveConnect(options = {}) {
  const base = getBase(options);
  const res = await resolveFetch(options)(`${base}/connect/start`, {
    method: 'GET',
    credentials: 'same-origin',
  });
  const body = await res.json();
  if (!res.ok || !body?.ok) {
    const err = new Error(body?.error?.message || 'تعذّر بدء ربط Google Drive');
    err.code = body?.error?.code || 'DRIVE_CONNECT_FAILED';
    throw err;
  }
  return { authUrl: body.authUrl };
}

/**
 * Drops the grant. The customer's backup stays in their Drive; Store Hub simply
 * stops being able to reach it.
 *
 * @param {DriveAuthClientOptions} [options]
 * @returns {Promise<{wasConnected: boolean}>}
 */
export async function disconnectDrive(options = {}) {
  const base = getBase(options);
  const res = await resolveFetch(options)(`${base}/disconnect`, {
    method: 'POST',
    credentials: 'same-origin',
  });
  const body = await res.json();
  if (!res.ok || !body?.ok) {
    const err = new Error(body?.error?.message || 'تعذّر فصل Google Drive');
    err.code = body?.error?.code || 'DRIVE_DISCONNECT_FAILED';
    throw err;
  }
  return { wasConnected: body.wasConnected === true };
}

/**
 * Opens the consent popup and resolves once the backend has posted the result.
 *
 * A popup rather than a full-page redirect on purpose: it keeps the shopkeeper
 * on the Settings screen, so the week of app behaviour is unchanged by the act of
 * connecting a backup. `postMessage` is checked against `window.location.origin`
 * on the receiving side, so a page on another origin cannot fake a result.
 *
 * @param {DriveAuthClientOptions & {timeoutMs?: number, opener?: Window}} [options]
 * @returns {Promise<boolean>} whether Drive ended up connected
 */
export function connectDriveInPopup(options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const opener = options.opener || (typeof window !== 'undefined' ? window : null);
  if (!opener) throw new Error('connectDriveInPopup needs a browser window');

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opener.removeEventListener('message', onMessage);
      fn(value);
    };

    const onMessage = (event) => {
      // Same-origin only. Without this, any page could claim Drive is connected.
      if (event.origin !== opener.location.origin) return;
      if (event.data?.source !== 'storehub-drive') return;
      finish(resolve, event.data.connected === true);
    };

    const timer = setTimeout(
      () => finish(reject, new Error('انتهت مهلة ربط Google Drive')),
      timeoutMs,
    );

    opener.addEventListener('message', onMessage);

    startDriveConnect(options)
      .then(({ authUrl }) => {
        const popup = opener.open(authUrl, 'storehub-drive-connect', 'width=520,height=680');
        if (!popup) {
          finish(reject, new Error('سمح بالنوافذ المنبثقة لربط Google Drive'));
          return;
        }
        // A popup the user closed never posts a message, so poll it. Cheap, and
        // it turns "the user gave up" into a clean resolution instead of a hang.
        const poll = setInterval(() => {
          if (settled) { clearInterval(poll); return; }
          if (!popup.closed) return;
          clearInterval(poll);
          finish(resolve, false);
        }, 700);
      })
      .catch((err) => finish(reject, err));
  });
}

export default {
  getDriveStatus,
  getDriveAccessToken,
  startDriveConnect,
  disconnectDrive,
  connectDriveInPopup,
};