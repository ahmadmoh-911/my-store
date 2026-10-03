/**
 * Licence code generation, normalisation, and hashing.
 *
 * Three separate jobs live here because they share the same primitives and must
 * agree with each other:
 *
 *   1. `generateLicenseCode()`  — mint a code for a customer.
 *   2. `hashLicenseCode()`      — store it without storing it.
 *   3. `lookupKey()`            — find the row again, since scrypt is salted.
 */

import {
  createHmac,
  randomInt,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

/**
 * The alphabet a code is drawn from.
 *
 * Excludes I, L, O, U, 0 and 1. Those are the characters people mistype when
 * they read a code off a screen and type it back, or transcribe from a phone
 * call — L/1 and O/0 are the classic confusions, and U/V reads poorly in some
 * fonts. A customer who cannot enter their own code is a support ticket.
 *
 * 30 symbols ^ 12 positions = 5.3 × 10^17 codes. At a sustained million
 * guesses per second — far beyond what scrypt actually permits — exhaustively
 * searching the space would still take ~1700 years.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

/** Characters per group, and groups per code: SH-XXXX-XXXX-XXXX. */
const GROUP_SIZE = 4;
const GROUP_COUNT = 3;

/** Shape check: SH-XXXX-XXXX-XXXX. Anchored, so nothing is silently ignored. */
const CODE_PATTERN = /^SH(-[A-Z0-9]{4}){3}$/;

/** Total brute-force space, useful for docs and for the entropy test. */
export const CODE_SPACE = Math.pow(
  CODE_ALPHABET.length,
  GROUP_SIZE * GROUP_COUNT,
);

/**
 * Mints one licence code.
 *
 * Uses `randomInt`, which draws from the CSPRNG and rejects values that would
 * bias the distribution (modulo bias). `Math.random()` is not used anywhere in
 * this file: it is a seeded PRNG, its state is recoverable from a handful of
 * outputs, and a licence code is the only thing standing between a stranger and
 * a paid copy of the product.
 *
 * @returns {string} e.g. `SH-7K4P-92MX-Q8TA`
 */
export function generateLicenseCode() {
  const groups = [];
  for (let g = 0; g < GROUP_COUNT; g += 1) {
    let group = '';
    for (let i = 0; i < GROUP_SIZE; i += 1) {
      group += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
    }
    groups.push(group);
  }
  return `SH-${groups.join('-')}`;
}

/**
 * Cleans up whatever the customer typed into the canonical stored form.
 *
 * Case and separator style are the things people get wrong, not the characters
 * themselves, so both are forgiven. Everything else is preserved exactly: a
 * code containing a letter outside the alphabet must fail, not be "helpfully"
 * translated into a different code that belongs to someone else.
 *
 * @param {unknown} input
 * @returns {string} canonical `SH-XXXX-XXXX-XXXX`
 * @throws {Error} if the input cannot be a licence code
 */
export function normalizeLicenseCode(input) {
  if (typeof input !== 'string') {
    throw new Error('Licence code must be a string.');
  }
  // Accepts "sh 7k4p 92mx q8ta", "SH_7K4P_92MX_Q8TA", "sh-7k4p-92mx-q8ta" alike.
  const collapsed = input.trim().toUpperCase().replace(/[\s_]+/g, '-');
  if (!CODE_PATTERN.test(collapsed)) {
    throw new Error('Licence code is not in the format SH-XXXX-XXXX-XXXX.');
  }
  // The pattern permits any A-Z0-9; the alphabet is narrower. Check per character
  // so an 'O' or '1' fails here rather than becoming a silently valid code.
  const body = collapsed.slice(3).replace(/-/g, '');
  for (const char of body) {
    if (!CODE_ALPHABET.includes(char)) {
      throw new Error(`Licence code contains the unusable character "${char}".`);
    }
  }
  return collapsed;
}

/** @returns {boolean} true if `input` normalises cleanly. */
export function isValidLicenseCode(input) {
  try {
    normalizeLicenseCode(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * A deterministic, indexable fingerprint of a code.
 *
 * Why this exists at all: `hashLicenseCode()` below is salted with per-licence
 * random bytes, which is what you want for verification but makes the hash
 * useless as a lookup key — you cannot ask "which row has this code?" without
 * re-hashing every row. So the table carries both:
 *
 *   code_salt + code_hash   → proves a guessed code is right (scrypt, slow)
 *   code_lookup             → finds the candidate row (HMAC-SHA256, fast)
 *
 * `code_lookup` is safe to index and safe to leak *because it is keyed by the
 * server pepper, which lives in the environment and never in the database*. An
 * attacker with only a dump cannot compute it, cannot enumerate, and cannot
 * confirm that two dumps share a code.
 *
 * @param {string} code already normalised
 * @param {string} pepper application secret
 * @returns {string} hex HMAC-SHA256
 */
export function lookupKey(code, pepper) {
  return createHmac('sha256', pepper).update(code, 'utf8').digest('hex');
}

/**
 * Derives a verifier for a licence code.
 *
 * scrypt rather than a bare SHA-256: the pepper alone is a secret, but the
 * pepper can leak (a config dump, a log line, a reused value). scrypt means an
 * attacker who does get it still pays ~110ms of memory-hard work per guess.
 *
 * @param {string} code already normalised
 * @param {{pepper: string, scrypt: {N:number,r:number,p:number,keylen:number}}} config
 * @param {Buffer} [salt] supply to re-derive an existing verifier
 * @returns {{salt: string, hash: string}} hex strings, safe to store
 */
export function hashLicenseCode(code, config, salt) {
  const saltBuf = salt ? Buffer.from(salt, 'hex') : randomBytes(16);
  // The pepper goes in *before* scrypt, not after: keying the password with an
  // HMAC means an attacker holding only `codeSalt` and `codeHash` cannot even
  // begin a guess, let alone mount one. Hashing afterwards would leave the same
  // password in scrypt's memory-hard work factor, which a leaked config would
  // then undo.
  const keyed = createHmac('sha256', config.pepper).update(code, 'utf8').digest();
  const hash = scryptSync(keyed, saltBuf, config.scrypt.keylen, {
    N: config.scrypt.N,
    r: config.scrypt.r,
    p: config.scrypt.p,
    // scrypt needs memory ≈ 128 * N * r bytes; the default 32MB cap trips at
    // N=16384,r=8 on some Node builds, so it is raised explicitly.
    maxmem: 256 * config.scrypt.N * config.scrypt.r,
  });
  return { salt: saltBuf.toString('hex'), hash: hash.toString('hex') };
}

/**
 * Checks a candidate code against a stored verifier.
 *
 * Compares in constant time so the endpoint cannot be used as a timing oracle
 * to recover a hash byte by byte.
 *
 * @param {string} code already normalised
 * @param {{salt: string, hash: string}} stored
 * @param {{pepper: string, scrypt: object}} config
 * @returns {boolean}
 */
export function verifyLicenseCode(code, stored, config) {
  if (!stored || !stored.salt || !stored.hash) return false;
  let expected;
  try {
    expected = hashLicenseCode(code, config, Buffer.from(stored.salt, 'hex'));
  } catch {
    return false;
  }
  const a = Buffer.from(expected.hash, 'hex');
  const b = Buffer.from(stored.hash, 'hex');
  // timingSafeEqual throws on a length mismatch, and a short stored hash is
  // exactly the case we must answer "false" to rather than crash on.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ *
 * Session tokens
 *
 * A licence code is a long-lived secret that the customer may keep in a drawer.
 * Sending it on every verification would mean it travels constantly and lives
 * in whatever proxy logs sit in between. So activation hands back a separate
 * opaque bearer token, and /verify authenticates with that instead.
 *
 * The token is 32 bytes of CSPRNG output, not derived from the code: revoking a
 * token must not be guessable from the licence, and rotating one must not
 * depend on the customer re-reading their code.
 * ------------------------------------------------------------------ */

/** @returns {string} base64url token, 43 characters. */
export function generateSessionToken() {
  return randomBytes(32).toString('base64url');
}

/**
 * Fingerprints a session token for storage. Same keyed-HMAC approach as the
 * licence code, so the database holds no usable token even if the pepper does
 * not leak but the dump does.
 *
 * @param {string} token
 * @param {string} pepper
 * @returns {string} hex HMAC-SHA256
 */
export function hashSessionToken(token, pepper) {
  return createHmac('sha256', pepper).update(`token:${token}`, 'utf8').digest('hex');
}

/**
 * Compares two hex fingerprints in constant time.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}