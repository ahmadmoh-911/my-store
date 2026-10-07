/**
 * Runtime configuration for the Store Hub licence backend.
 *
 * Everything that differs between a laptop and a real deployment is read here,
 * once, so the rest of the server never touches process.env directly and no
 * module has to guess a default that might be wrong in production.
 *
 * Env-file loading also happens here, so the server reads `server/.env` the
 * same way no matter which directory it is launched from.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Root of the server package, derived from this file's own location rather than
 * `process.cwd()`. That is what lets `node server/src/index.js` and
 * `npm start` inside `server/` resolve the same `server/.env` file.
 */
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @returns {string} the absolute path of the env file this server reads. */
export function envFilePath() {
  return path.join(SERVER_ROOT, '.env');
}

/**
 * Loads `server/.env` into `into` if the file exists.
 *
 * Existing variables are never overwritten — an explicitly exported value wins
 * over the file, which is what lets a production deploy override the file.
 * Values are parsed like dotenv: `KEY=VALUE` lines, `#` comments (a comment
 * starts at the first ` #` or at the start of the line), and surrounding
 * matching quotes are stripped. Nothing is logged and no value leaves this
 * function.
 *
 * @param {Record<string, string>} [into=process.env]
 * @returns {boolean} true when a file was found and read
 */
export function loadEnvFile(into = process.env) {
  const file = envFilePath();
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // An inline comment must be preceded by whitespace so a value containing
    // '#' (a legal URI/secret character) is kept intact: `A=foo#bar` keeps
    // "foo#bar", `A=foo # comment` keeps "foo".
    const comment = value.search(/\s+#/);
    if (comment !== -1) value = value.slice(0, comment).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in into)) into[key] = value;
  }
  return true;
}

/**
 * The pepper mixed into every code hash.
 *
 * A hash of a licence code is only as strong as what an attacker can do offline.
 * With a random salt alone, an attacker holding a copy of the database could
 * brute-force all ~5×10^17 codes at ~10M/sec on a GPU — hours, not years. The
 * pepper lives in the environment and NEVER in the database, so a stolen
 * database dump alone is not enough; the attacker also needs the application's
 * secret. scrypt's cost factor is the second layer: ~110ms per guess per core
 * turns a fast hash into an expensive one.
 *
 * Required in production, defaulted in development so `npm start` works on a
 * fresh clone without ceremony.
 */
function readPepper(env) {
  const fromEnv = env.STOREHUB_PEPPER;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;

  if (env.NODE_ENV === 'production') {
    // Failing loudly here is the whole point: a production server silently
    // running on a well-known development pepper would make every code hash
    // in the database trivially attackable.
    throw new Error(
      'STOREHUB_PEPPER must be set to at least 16 characters in production. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return 'storehub-development-pepper-not-for-production';
}

/**
 * Builds the config object.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {{
 *   env: string,
 *   pepper: string,
 *   port: number,
 *   host: string,
 *   databaseFile: string,
 *   scrypt: {N: number, r: number, p: number, keylen: number},
 *   useMemoryDb: boolean,
 *   supabaseUrl: string|null,
 *   supabaseDbUrl: string|null,
 *   supabaseServiceRoleKey: string|null,
 *   usePostgres: boolean,
 * }}
 */
export function loadConfig(env = process.env) {
  // One place where the `.env` file feeds the process: only when the caller
  // really means "the environment" (not when a test passes a bespoke object),
  // and it never clobbers variables that are already set.
  if (env === process.env) {
    loadEnvFile();
  }
  const nodeEnv = env.NODE_ENV || 'development';
  const memory = env.STOREHUB_DB === ':memory:';

  return {
    env: nodeEnv,
    pepper: readPepper(env),
    port: Number(env.PORT || 8787),
    host: env.HOST || '127.0.0.1',
    // A real file by default so a restart does not lose every issued licence;
    // ':memory:' is opt-in for tests.
    databaseFile: env.STOREHUB_DB || './data/storehub.db',
    useMemoryDb: memory,

    supabaseUrl: env.SUPABASE_URL || null,
    supabaseDbUrl: env.SUPABASE_DB_URL || null,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || null,
    usePostgres: !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) || !!env.SUPABASE_DB_URL,

    /**
     * scrypt work factors.
     *
     * N=16384 with r=8 is the documented interactive-login setting: expensive
     * enough to hurt an attacker, fast enough that a licence check feels
     * instant. Overridable so the test suite can run at a lower cost.
     */
    scrypt: {
      N: Number(env.STOREHUB_SCRYPT_N || 16384),
      r: Number(env.STOREHUB_SCRYPT_R || 8),
      p: Number(env.STOREHUB_SCRYPT_P || 1),
      keylen: 32,
    },

    /**
     * Where the browser build may call from.
     *
     * Empty by default, which means no cross-origin caller at all. That is the
     * correct setting for a backend sitting behind the same host as the app.
     * The Android build is a different origin (Capacitor serves it from
     * https://localhost), so deploying to a separate host requires listing it
     * explicitly — a deliberate step, not a default.
     */
    corsOrigins: (env.STOREHUB_CORS_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),

    /**
     * Whether to believe `X-Forwarded-For` when rate limiting.
     *
     * Off by default, and it must stay off unless a reverse proxy in front of
     * this process is the thing setting that header. If a client can set it, it
     * can choose its own rate-limit bucket, and the limit stops being a limit.
     */
    trustProxy: env.STOREHUB_TRUST_PROXY === '1' || env.STOREHUB_TRUST_PROXY === 'true',

    /**
     * Fixed-window request limits, per client IP.
     *
     * The code space is 5.3×10^17 so this is not what makes guessing hopeless —
     * it is what stops someone spending server CPU on the attempt anyway, and
     * what keeps one script from enumerating a customer's real code.
     */
    rateLimit: {
      windowMs: Number(env.STOREHUB_RATE_WINDOW_MS || 900000),
      maxActivate: Number(env.STOREHUB_RATE_MAX_ACTIVATE || 20),
      maxVerify: Number(env.STOREHUB_RATE_MAX_VERIFY || 120),
    },

    /**
     * Google OAuth configuration.
     *
     * `clientId` and `clientSecret` are required in production. In development
     * they can be omitted to allow the server to start without Google
     * credentials, but the auth endpoints will return configuration errors until
     * they are provided.
     *
     * The redirect URI is read per flow rather than as one shared value — see
     * `readGoogleConfig` and `resolveRedirectUri` below.
     */
    google: readGoogleConfig(env),

    /**
     * Session configuration.
     *
     * Session TTL controls how long a user stays logged in. The backend issues
     * its own session token (opaque, high-entropy) rather than exposing the
     * Google refresh token. Sessions are stored server-side and can be revoked.
     */
    session: {
      ttlMs: Number(env.STOREHUB_SESSION_TTL_MS || 30 * 24 * 60 * 60 * 1000), // 30 days
      cookieName: env.STOREHUB_SESSION_COOKIE || 'storehub_session',
    },

    /**
     * Admin authorisation.
     *
     * Two separate facts, and the whole design is that they are kept separate:
     *
     *   authentication  — "this is a real Google account" (see `google` + the
     *                      auth session above), and
     *   authorisation   — "this specific account may operate the licences".
     *
     * `authorizedSubs` is the second fact, and it is a list of Google account
     * `sub` values: the stable, immutable account identifier. Email is
     * deliberately not used — an email can be renamed, recycled, or reassigned
     * on Workspace, and an admin grant that survives that would hand the
     * licence database to whoever inherits the mailbox.
     *
     * Empty by default, which means *nobody is an admin* and every admin
     * endpoint answers 403. There is no fallback account, no development
     * backdoor, and no password: the only way to grant admin access is to name
     * an account in the environment. A fresh clone therefore cannot be walked
     * into by whoever started it.
     *
     * Required in production, and failing loudly there is deliberate: an
     * operator who forgets it should be told at boot, not discover it the first
     * time a genuine admin cannot sign in.
     */
    admin: readAdminConfig(env, nodeEnv),

    /**
     * Google Drive backup authorisation.
     *
     * The backend's role here is authorisation infrastructure and nothing else:
     * it brokers the Google grant so the device can hold a short-lived access
     * token instead of a permanent one, and it never receives the backup.
     *
     * `databaseFile` is a *separate* database from `databaseFile` above, on
     * purpose. The Drive grant is a long-lived credential, so it is kept apart
     * from licence and account tables — a dump of one cannot yield the other,
     * and the grant can be rotated or revoked without touching shop records.
     *
     * `enabled` is opt-out rather than opt-in so that turning backups on never
     * requires a redeploy — but the grant still has to be granted by the account
     * itself before anything happens, so enabling this grants nobody anything.
     */
    drive: readDriveConfig(env, memory),
  };
}

/**
 * The three Google flows, and the single configuration key each one reads.
 *
 * Google is sent exactly one `redirect_uri` per authorize request and redirects
 * the browser to *that* value, so a flow can only ever land on the callback its
 * own URI points at. There used to be one `GOOGLE_REDIRECT_URI` shared by all
 * three, which made `/api/admin/auth/callback` and `/api/drive/connect/callback`
 * unreachable: an admin sign-in stranded the operator on a JSON response, and a
 * Drive connect stranded the popup on the same response so the app never got its
 * `postMessage` and reported a timeout even though the grant had been recorded.
 *
 * Each flow now reads its own variable, and only falls back to the shared
 * `GOOGLE_REDIRECT_URI` outside production so existing development and test
 * setups keep working unchanged. Production refuses to boot until all three are
 * set — see `assertProductionRedirectUris`.
 */
const REDIRECT_FLOWS = Object.freeze({
  customer: Object.freeze({
    field: 'authRedirectUri',
    env: 'GOOGLE_AUTH_REDIRECT_URI',
    path: '/api/auth/google/callback',
  }),
  admin: Object.freeze({
    field: 'adminRedirectUri',
    env: 'GOOGLE_ADMIN_REDIRECT_URI',
    path: '/api/admin/auth/callback',
  }),
  drive: Object.freeze({
    field: 'driveRedirectUri',
    env: 'GOOGLE_DRIVE_REDIRECT_URI',
    path: '/api/drive/connect/callback',
  }),
});

/**
 * Reads the Google block, keeping the shared redirect URI as a fallback value.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{
 *   clientId: string|null,
 *   clientSecret: string|null,
 *   redirectUri: string|null,
 *   authRedirectUri: string|null,
 *   adminRedirectUri: string|null,
 *   driveRedirectUri: string|null,
 * }}
 */
function readGoogleConfig(env) {
  return {
    clientId: env.GOOGLE_CLIENT_ID || null,
    clientSecret: env.GOOGLE_CLIENT_SECRET || null,
    // Kept for compatibility only. It is never authoritative in production: it
    // is the shared value this change exists to get away from.
    redirectUri: env.GOOGLE_REDIRECT_URI || null,
    authRedirectUri: env.GOOGLE_AUTH_REDIRECT_URI || null,
    adminRedirectUri: env.GOOGLE_ADMIN_REDIRECT_URI || null,
    driveRedirectUri: env.GOOGLE_DRIVE_REDIRECT_URI || null,
  };
}

/**
 * The redirect URI one flow must use, in both the authorize request and the code
 * exchange that follows it — Google rejects an exchange whose `redirect_uri`
 * differs from the one the code was issued for, so these two must agree and they
 * agree by coming from this one function.
 *
 * The flow's own variable wins; the shared `GOOGLE_REDIRECT_URI` is the
 * compatibility fallback; `null` means the flow is not configured.
 *
 * @param {ReturnType<typeof readGoogleConfig>} google
 * @param {'customer'|'admin'|'drive'} intent
 * @returns {string|null}
 */
export function resolveRedirectUri(google, intent) {
  const flow = REDIRECT_FLOWS[intent] || REDIRECT_FLOWS.customer;
  return google[flow.field] || google.redirectUri || null;
}

/**
 * The environment variable a flow reads, for an error message that names the
 * variable the operator actually has to set.
 *
 * @param {'customer'|'admin'|'drive'} intent
 * @returns {string}
 */
export function redirectUriEnvName(intent) {
  return (REDIRECT_FLOWS[intent] || REDIRECT_FLOWS.customer).env;
}

/**
 * Refuses a production start that would put all three flows back on one shared
 * redirect URI.
 *
 * Deliberately *not* called from `loadConfig`: configuration is read there and
 * nothing is validated beyond what is needed to build the object, so a caller
 * that only wants to inspect config is not forced to satisfy a deployment rule.
 * `./index.js` calls this when it actually assembles the backend, which is the
 * point at which the rule matters.
 *
 * @param {ReturnType<typeof loadConfig>} config
 * @throws {Error} listing every redirect URI variable production is missing
 */
export function assertProductionRedirectUris(config) {
  if (config.env !== 'production') return;

  const missing = Object.values(REDIRECT_FLOWS)
    .filter((flow) => !config.google[flow.field])
    .map((flow) => flow.env);

  if (missing.length > 0) {
    throw new Error(
      `production requires one redirect URI per Google flow, missing ${missing.join(', ')}. ` +
        'GOOGLE_REDIRECT_URI is a development fallback and must not be the only URI in production.',
    );
  }
}

/**
 * Reads the Drive backup block.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{enabled: boolean, databaseFile: string, folderName: string}}
 */
function readDriveConfig(env, memory) {
  const folderName = (env.STOREHUB_DRIVE_FOLDER || '').trim() || 'Store Hub Backups';
  return {
    enabled: env.STOREHUB_DRIVE !== '0' && env.STOREHUB_DRIVE !== 'false',
    // `STOREHUB_DB=':memory:'` means *every* database is in memory, not just the
    // licence one. Honouring it here is what keeps a test run from quietly
    // creating a real `storehub_drive.db` file next to the test output — a test
    // that writes a durable credential store is a test that leaves secrets
    // behind on the developer's disk.
    databaseFile: env.STOREHUB_DRIVE_DB || (memory ? ':memory:' : './data/storehub_drive.db'),
    folderName,
  };
}

/**
 * Reads the admin authorisation block, refusing a production deploy that has no
 * administrators rather than starting a portal nobody can reach.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} nodeEnv
 * @returns {{authorizedSubs: string[], portalUrl: string}}
 */
function readAdminConfig(env, nodeEnv) {
  const authorizedSubs = (env.STOREHUB_ADMIN_SUB || '')
    .split(',')
    .map((sub) => sub.trim())
    .filter(Boolean);

  if (nodeEnv === 'production' && authorizedSubs.length === 0) {
    throw new Error(
      'STOREHUB_ADMIN_SUB must list at least one Google account sub in production. ' +
        'Find it by signing in with Google and reading the `sub` claim from the ' +
        'ID token at https://developers.google.com/identity/protocols/oauth2/openid-connect'
    );
  }

  return {
    authorizedSubs,
    /**
     * Where the admin sign-in callback sends the browser afterwards.
     *
     * Optional and unset by default. When it is set it must be an absolute
     * http(s) URL, and it is the *only* redirect target the admin callback will
     * ever use — no target is read from the request, which is what keeps this
     * from becoming an open redirect. Left unset, the callback answers with the
     * same JSON envelope as the customer flow, which is the correct behaviour
     * until a production domain has actually been chosen.
     */
    portalUrl: readPortalUrl(env, nodeEnv),
  };
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} nodeEnv
 * @returns {string} the validated portal URL, or '' when unset
 */
function readPortalUrl(env, nodeEnv) {
  const raw = (env.STOREHUB_ADMIN_PORTAL_URL || '').trim();
  if (!raw) return '';

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      'STOREHUB_ADMIN_PORTAL_URL must be an absolute URL, e.g. https://admin.example.com',
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('STOREHUB_ADMIN_PORTAL_URL must use http or https');
  }
  // Plain http would carry the session cookie in the clear on the way back from
  // Google. Loopback is exempt, because that is how the portal is developed.
  const isLoopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol === 'http:' && nodeEnv === 'production' && !isLoopback) {
    throw new Error('STOREHUB_ADMIN_PORTAL_URL must use https in production');
  }
  return parsed.toString();
}
