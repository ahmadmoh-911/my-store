/**
 * Admin Portal deployment configuration.
 *
 * The one thing an operator has to set, and it is deliberately a plain file
 * rather than a build step: this portal has no bundler, so deploying it is
 * copying four files to a host and pointing this value at the backend.
 *
 * `API_BASE` is the origin that serves `/api/admin/*`. Two shapes:
 *
 *   ''  — same origin as this page. Correct when the backend and this portal are
 *         served from one host, and the simplest thing to develop against.
 *   'https://api.example.com'
 *       — a separate backend origin, which is what a real separate deployment
 *         looks like (portal on `admin.…`, API on `api.…`).
 *
 * For the cross-origin shape the backend must list this portal's origin in
 * `STOREHUB_CORS_ORIGINS`, and both origins must be under the same registrable
 * domain: the session cookie is `SameSite=Lax`, which a cross-*site* request
 * would not send. See ADMIN_PORTAL.md.
 *
 * No production domain is hardcoded here on purpose — one has not been chosen,
 * and inventing an unowned hostname is worse than an obvious empty value.
 */

export const API_BASE = '';
