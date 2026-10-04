/**
 * Runtime configuration for the Store Hub licence backend.
 *
 * Everything that differs between a laptop and a real deployment is read here,
 * once, so the rest of the server never touches process.env directly and no
 * module has to guess a default that might be wrong in production.
 */

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
 * }}
 */
export function loadConfig(env = process.env) {
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
     * All three are required in production. In development they can be omitted
     * to allow the server to start without Google credentials, but the auth
     * endpoints will return configuration errors until they are provided.
     */
    google: {
      clientId: env.GOOGLE_CLIENT_ID || null,
      clientSecret: env.GOOGLE_CLIENT_SECRET || null,
      redirectUri: env.GOOGLE_REDIRECT_URI || null,
    },

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
