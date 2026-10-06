# Admin Portal — Store Hub

The Admin Portal is the operator-facing half of Store Hub: it issues licence
codes, suspends and reactivates licences, and reads licence metadata. It is a
**separate application** from the Store Hub point-of-sale app, and this document
is the argument for why that separation is structural rather than cosmetic.

- Code: [`admin/`](admin/) — four files, no build step, no dependencies.
- Backend: [`server/src/admin-authorization.js`](server/src/admin-authorization.js)
  (the guard), [`server/src/admin-service.js`](server/src/admin-service.js)
  (licence operations), routes in [`server/src/http.js`](server/src/http.js).
- Tests: [`server/test/admin.test.mjs`](server/test/admin.test.mjs) — 38 tests.
- Customer-facing background: [GOOGLE_AUTH.md](GOOGLE_AUTH.md).

---

## 1. The property this design exists to guarantee

> **Knowing the admin URL must not be enough to access admin functionality. The
> backend must independently reject every unauthorized request, while customer
> business data remains completely isolated from the admin system.**

Both halves are enforced on the server and both are covered by tests:

| Claim | Where it is enforced | Where it is tested |
| --- | --- | --- |
| An unauthenticated request to any admin route is refused | `requireAdmin` in `admin-authorization.js` | `ADMIN: an unauthenticated request is refused on every guarded route` |
| An authenticated **customer** is refused | the `sub` allowlist in `isAuthorizedAdmin` | `ADMIN: an authenticated customer is refused on every guarded route` |
| A refusal happens *before* the mutation | the guard runs above the body read in `handle()` | `ADMIN: a refused request performs no mutation` |
| Customer business data is unreachable | no such route, table or column exists | six `ISOLATION:` / `SEPARATION:` tests |

The customer application is covered by the same sweep: a test reads `index.html`,
`manifest.json`, `sw.js` and every file in `js/`, strips comments, and fails if
any of them mentions `/api/admin`, `admin/`, or an `admin` route key. The portal
cannot be reached from the shop, and the shop contains nothing of the portal.

---

## 2. Authentication is not authorisation

These are two different questions, and the phase brief requires them to stay
separate. Conflating them is the mistake that turns an admin panel into a
customer feature.

**Authentication** — "is this a real Google account with a live session?"
Owned by [`server/src/auth-service.js`](server/src/auth-service.js): OAuth 2.0
authorization code + PKCE (S256), a server-side state and verifier with a
10-minute TTL, then an opaque session token in an `HttpOnly` cookie.

**Authorisation** — "may *this* account operate licences?"
Owned by [`server/src/admin-authorization.js`](server/src/admin-authorization.js).
The grant is a list of Google account `sub` values in the environment. That is
the entire grant: no password, no API token, no shared secret to leak.

Being signed in is not being an administrator. A shop that has activated Store
Hub holds a perfectly valid session and is still refused, with `403
ADMIN_REQUIRED`.

### Why the `sub`, and not the email

`sub` is an opaque, immutable account identifier. An email address can be
renamed, sold, deleted and reassigned on Workspace — and a grant that survives
that hands the entire licence database to whoever inherits the mailbox. The
allowlist matches on `sub` only, and no code path reads an email to decide
access.

### 401 versus 403

| Situation | Status | Code |
| --- | --- | --- |
| No session cookie, or a session that is unknown or expired | `401` | `INVALID_SESSION` |
| Valid session, account not in `STOREHUB_ADMIN_SUB` | `403` | `ADMIN_REQUIRED` |
| No identity provider wired at all | `403` | `ADMIN_REQUIRED` |

The distinction is not cosmetic. "Who are you" and "what may you do" need
different responses from the client: a 401 means sign in again, a 403 means
stop asking. Collapsing them sends a valid customer into a sign-in loop they can
never satisfy.

### There is no default administrator

`STOREHUB_ADMIN_SUB` is empty by default, which means **nobody** is an
administrator and every admin request is refused. There is no development
backdoor, no fallback account, and no password to reset. A fresh clone cannot be
walked into by whoever started it.

In `NODE_ENV=production` an empty allowlist **refuses to boot**, with a message
naming the variable. An operator who forgets it is told at deploy time rather
than discovering it the first time a genuine admin cannot sign in.

---

## 3. The API authorization boundary

All admin routes are marked `admin: true` in the route table in `http.js`. The
guard runs in `handle()` immediately after routing and **above** the request body
read and above every handler, so an unauthorised caller cannot reach a mutation
and cannot even get a payload validated. The guard throws rather than returning a
boolean, so a handler cannot forget to branch on it.

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/admin/auth/start` | begins the Google flow, tagged `intent: 'admin'` |
| `GET` | `/api/admin/auth/callback` | completes it, then authorises or destroys the session |
| `GET` | `/api/admin/me` | "am I an administrator?" — used by the portal on boot |
| `GET` | `/api/admin/licenses` | list, with `status` / `limit` / `offset` |
| `POST` | `/api/admin/licenses` | issue a licence; returns the plaintext code once |
| `GET` | `/api/admin/licenses/:id` | one licence plus its install metadata |
| `POST` | `/api/admin/licenses/:id/suspend` | suspend |
| `POST` | `/api/admin/licenses/:id/reactivate` | reactivate (refused for a revoked licence) |
| `POST` | `/api/admin/licenses/:id/revoke` | revoke, permanently |
| `POST` | `/api/admin/licenses/:id/note` | set or clear the internal note |
| `GET` | `/api/admin/licenses/:id/events` | the state-change trail |

Everything except the two sign-in routes requires authorisation. The two
exceptions cannot read or change anything: `/api/admin/auth/start` mints an
OAuth state and the callback's only power is to decide whether to hand back a
session.

### The admin sign-in flow is separate from the customer's

`startAuth()` records an `intent` alongside the PKCE verifier and `completeAuth()`
returns it. A flow started at `/api/auth/google/start` **cannot** be completed at
`/api/admin/auth/callback`. The two entry points stay separately auditable, and
an admin session can never be minted by the customer route.

The admin callback is where authentication and authorisation visibly diverge:

1. The OAuth code is exchanged and a session is created — authentication
   succeeded.
2. The account's `sub` is checked against the allowlist.
3. If it is not authorised, `authService.logout()` **destroys the session just
   created** and the request is answered `403`.

Step 3 matters. Without it a failed admin attempt by a real customer would leave
behind a usable session cookie — authentication's side effect outliving the
refusal that was supposed to contain it.

### The activation code is shown exactly once

`POST /api/admin/licenses` returns the plaintext code. Nothing else ever does, and
it cannot: the server stores only a scrypt hash and salt, peppered with an
environment secret. There is no read endpoint for it and no recovery path. A
licence issued in error has to be revoked and replaced, not looked up.

In the portal the code appears in a dialog that says so, with a copy button, and
is never written into application state — so navigating away cannot leave it
sitting in memory for a later render to display.

---

## 4. Data isolation

The admin plane handles **licence metadata only**. A shop's products, variants,
inventory, sales, sale items, refunds, reports, suppliers, invoices, product
images and backups are not merely hidden from it — they are unreachable from it:

- **They live somewhere else.** A shop's data is in the customer's IndexedDB on
  the customer's device. It has never been uploaded, so there is no copy for the
  backend to hand out.
- **There are no routes for them.** `GET /api/admin/products`, `/sales`,
  `/inventory`, `/reports`, `/backups`, `/store`, `/db` and variants of each are
  probed as a *fully authorised administrator* and all answer `404`. Not `403` —
  there is nothing there to authorise.
- **There are no tables for them.** The licence database contains exactly four
  tables — `licenses`, `license_tokens`, `license_installs`, `license_events` —
  and no column anywhere in the schema could hold business data.
- **The UI cannot ask for them.** `admin/admin.js` opens no IndexedDB, reads no
  `localStorage`, registers no service worker, and imports nothing outside
  `admin/`.

The reverse direction holds too: the admin plane's projection is written out
field by field in `adminLicenseView()`, so adding a column to the licence table
cannot accidentally start leaking it to an operator screen. `codeHash`,
`codeSalt` and `codeLookup` are not in it, and neither are session tokens or
OAuth access/refresh tokens.

### What the admin plane never stores

| Material | Why it is absent |
| --- | --- |
| OAuth access/refresh/id tokens | exchanged with Google once, then discarded; `auth_accounts` and `auth_sessions` have no token column |
| Session tokens in admin payloads | the caller's own token is an `HttpOnly` cookie, never a response field |
| Licence code hashes and salts | the admin projection cannot reach them, and they cannot reconstruct a code anyway |
| Google client secret | read from the environment, never returned or logged |

---

## 5. Required production configuration

None of these values is committed, and none should be. Provide them through your
deployment's secret store or environment file.

| Variable | Required | Purpose |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | yes | OAuth client |
| `GOOGLE_CLIENT_SECRET` | yes | OAuth client secret |
| `GOOGLE_AUTH_REDIRECT_URI` | yes | Customer sign-in callback registered with Google |
| `GOOGLE_ADMIN_REDIRECT_URI` | yes | Admin portal callback registered with Google |
| `GOOGLE_DRIVE_REDIRECT_URI` | yes | Drive connect callback registered with Google |
| `GOOGLE_REDIRECT_URI` | no | **Compatibility fallback** — development only. Must NOT be the only URI in production. |
| `STOREHUB_PEPPER` | yes (in production) | mixed into every licence hash; never in the database |
| `STOREHUB_ADMIN_SUB` | yes (in production) | comma-separated Google `sub` values authorised to operate licences |
| `STOREHUB_ADMIN_PORTAL_URL` | no | where the admin callback returns the browser |
| `STOREHUB_CORS_ORIGINS` | if the portal is cross-origin | the portal's origin |
| `STOREHUB_TRUST_PROXY` | if behind a reverse proxy | `1` to honour `X-Forwarded-For` for rate limiting |
| `NODE_ENV` | yes in production | `production` tightens the checks and refuses an empty allowlist |

### Finding your `sub`

Sign in with the Google account you intend to authorise and read the `sub` claim
from the ID token — see Google's
[OpenID Connect documentation](https://developers.google.com/identity/protocols/oauth2/openid-connect).
The alternative, once you have signed in through the portal at least once, is to
read it out of the identity database:

```sql
SELECT google_sub, email, last_login_at FROM auth_accounts;
```

(The 403 response deliberately does not tell you the `sub` — a refusal does not
hand out the value you would need to impersonate the account.)

Then:

```
STOREHUB_ADMIN_SUB=1234567890abcdef123456,9876543210fedcba987654
```

Adding an administrator is a configuration change and a restart. There is no UI
for granting admin rights, which is deliberate: an admin panel that can grant
admin rights needs a different admin panel to guard it.

### The Google redirect URIs

**Three separate redirect URIs are now required in production**, one per Google
flow. The old `GOOGLE_REDIRECT_URI` is a development fallback only.

| Flow | Environment variable | Callback path | Scope added |
|------|----------------------|---------------|-------------|
| Customer sign-in | `GOOGLE_AUTH_REDIRECT_URI` | `/api/auth/google/callback` | `openid email profile` |
| Admin portal | `GOOGLE_ADMIN_REDIRECT_URI` | `/api/admin/auth/callback` | `openid email profile` |
| Drive connect | `GOOGLE_DRIVE_REDIRECT_URI` | `/api/drive/connect/callback` | `openid email profile https://www.googleapis.com/auth/drive.file` |

Register **all three** with the same Web application client in Google Cloud Console.
The admin callback will never receive a customer sign-in's code (intent separation
is enforced server-side), and the Drive callback will reject any state not minted
by the Drive flow.

---

## 6. Deployment

### Intended shape

The portal is four static files. Hosting them is a copy operation, which is what
makes a separate deployment cheap:

```
portal   admin.example.com      ->  admin/{index.html,admin.js,admin.css,config.js}
api      api.example.com        ->  node server/src/index.js
shop     example.com            ->  the Store Hub PWA (unchanged)
```

Point the portal at the API by editing one line in
[`admin/config.js`](admin/config.js):

```js
export const API_BASE = 'https://api.example.com';
```

Empty means same-origin, which is the simplest thing to develop against. No
production hostname is hardcoded anywhere, because none has been chosen, and
inventing an unowned domain is worse than an obvious empty value.

### The same-site constraint

The session cookie is `HttpOnly` and `SameSite=Lax`. The portal and the API must
therefore be **same-site** — different subdomains of one registrable domain is
fine; genuinely different sites would not send the cookie. This is enforced by
the browser rather than by a workaround, which is the right place for it: a
misconfigured `API_BASE` fails closed instead of quietly leaking a session.

For the cross-origin case the backend must also list the portal origin in
`STOREHUB_CORS_ORIGINS`.

### The service worker deliberately does not know about it

`sw.js` is at BUILD v17 and unchanged by this phase. The portal is not precached,
not cached, and not referenced from the customer shell — precaching admin assets
would put them in every customer's offline cache, on every customer's device.

### Running it locally

```bash
cd server
STOREHUB_ADMIN_SUB=<your-sub> node src/index.js
```

Serve `admin/` from any static server on the same host, or set `API_BASE`. With
`STOREHUB_ADMIN_SUB` unset the backend logs:

```
admin portal disabled — STOREHUB_ADMIN_SUB is not set, so every admin request is refused
```

---

## 7. Not finalised, and why

Honest about what is not production-ready, rather than implying it is.

1. **No domain, host or TLS certificate has been chosen.** `STOREHUB_ADMIN_PORTAL_URL`
   and `STOREHUB_CORS_ORIGINS` cannot be filled in until that decision is made.
   `admin/config.js` ships empty for the same reason.
2. **No administrator has been named.** Until a `sub` is configured, every admin
   request is refused — including yours. The backend tells you so at boot.
3. **The admin session is the customer session.** Both flows set the same
   `storehub_session` cookie, and authorisation is the allowlist check on top.
   That is sufficient — a customer session cannot pass the check — but a
   distinct admin session store, and a shorter admin session lifetime, would be a
   reasonable next step.
4. **The PKCE store is in-process.** `pkceStore` is a `Map`. A single instance is
   fine; running two or more behind a load balancer needs a shared store. This is
   inherited from Phase 3 and applies to the customer flow equally.
5. **SQLite is a file.** Fine for one backend instance; a hosted database is a new
   adapter behind the repository port, not a rewrite.
6. **Rate limiting covers the licence endpoints only.** Admin routes are
   authenticated and allowlisted, so the abuse surface is a compromised
   administrator account rather than an anonymous one.

## 8. Deliberately out of scope for this phase

Not implemented here, and not started:

- Google Drive backup
- Android release and signing
- Supabase or any hosted-database migration
- Any redesign of the customer UI or the licence model
- An admin-side view of *any* customer business data
- Multi-tenant admin roles beyond a flat allowlist (no read-only operator, no
  audit log of admin actions beyond `license_events`)
