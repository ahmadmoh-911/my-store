/**
 * Shared API base URL configuration.
 *
 * This module provides a single place to configure the backend API origin for
 * all Store Hub clients (Web, Android/Capacitor). It avoids duplicating URL
 * normalization logic across licence, auth, and Drive clients.
 *
 * Configuration sources (in priority order):
 *   1. `window.STOREHUB_API_BASE` — set by the hosting page (index.html for
 *      PWA, a small config script for Android). Value can be:
 *         - '' (empty) → same-origin, relative paths to /api/*
 *         - 'https://api.example.com' → absolute backend origin
 *   2. Fallback: '' (relative paths) — preserves current dev behaviour
 *
 * The value must be the API *origin* (scheme + host + optional port), NOT
 * including any path. The clients append their own `/api/...` paths.
 *
 * Examples:
 *   window.STOREHUB_API_BASE = ''                    // same-origin (dev)
 *   window.STOREHUB_API_BASE = 'https://api.example.com'  // production
 *
 * Android/Capacitor: inject via a small script in index.html before the
 * application loads, or set on the window object from native code.
 */

const GLOBAL_KEY = 'STOREHUB_API_BASE';

/**
 * Normalises an API base URL.
 *
 * @param {string} base
 * @returns {string} empty string for same-origin, or origin without trailing slash
 */
export function normalizeApiBase(base) {
  if (!base || base === '') return '';

  // Must be an absolute URL with origin only (no path)
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`STOREHUB_API_BASE must be a valid absolute URL or empty, got: ${base}`);
  }

  // Reject if there's a pathname beyond '/'
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(`STOREHUB_API_BASE must not include a path (got ${url.pathname}). Use origin only, e.g. https://api.example.com`);
  }

  // Return origin without trailing slash
  return url.origin;
}

/**
 * Gets the configured API base URL.
 *
 * @returns {string} '' for same-origin, or 'https://api.example.com'
 */
export function getApiBase() {
  // Check global first (set by index.html or native bridge)
  if (typeof window !== 'undefined' && window[GLOBAL_KEY] !== undefined) {
    return normalizeApiBase(window[GLOBAL_KEY]);
  }

  // Fallback: same-origin (relative paths)
  return '';
}

/**
 * Builds a full API endpoint URL from the configured base and a path.
 *
 * @param {string} path  Path starting with '/', e.g. '/api/license/activate'
 * @returns {string} Full URL, or just the path if using same-origin
 */
export function buildApiUrl(path) {
  const base = getApiBase();
  if (!base) return path;
  if (!path.startsWith('/')) throw new Error(`API path must start with '/', got: ${path}`);
  return `${base}${path}`;
}

/**
 * Returns the default base path for a specific API group.
 * Used by clients that still need the path-only form for same-origin.
 *
 * @param {'license'|'auth'|'drive'} group
 * @returns {string} e.g. '/api/license'
 */
export function getDefaultBase(group) {
  switch (group) {
    case 'license': return '/api/license';
    case 'auth':    return '/api/auth';
    case 'drive':   return '/api/drive';
    default:        throw new Error(`Unknown API group: ${group}`);
  }
}

/**
 * Resolves the effective base for a client.
 *
 * - If a global API base is configured, returns the full origin URL.
 * - Otherwise, returns the group-specific default path (same-origin).
 *
 * This is the value clients should use as their `baseUrl` when building
 * endpoint URLs.
 *
 * @param {'license'|'auth'|'drive'} group
 * @returns {string} Full origin or relative path
 */
export function resolveClientBase(group) {
  const base = getApiBase();
  if (base) return base;
  return getDefaultBase(group);
}

/**
 * Sets the API base programmatically (for tests or native bridges).
 *
 * @param {string} base  '' for same-origin, or absolute origin URL
 * @throws {Error} if the value is invalid
 */
export function setApiBaseForTesting(base) {
  const normalized = normalizeApiBase(base);
  if (typeof window !== 'undefined') {
    window[GLOBAL_KEY] = normalized;
  }
  return normalized;
}

/**
 * Clears any test override.
 */
export function clearApiBaseForTesting() {
  if (typeof window !== 'undefined') {
    delete window[GLOBAL_KEY];
  }
}