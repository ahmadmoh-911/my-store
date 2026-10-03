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
  };
}