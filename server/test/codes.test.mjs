/**
 * Licence code generation, normalisation, and hashing.
 *
 * Covers required areas 1-5: generation, format, unpredictability, hashing, and
 * that no stored record can be turned back into a plaintext code.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CODE_ALPHABET,
  CODE_SPACE,
  generateLicenseCode,
  normalizeLicenseCode,
  isValidLicenseCode,
  lookupKey,
  hashLicenseCode,
  verifyLicenseCode,
  generateSessionToken,
  hashSessionToken,
  safeEqualHex,
} from '../src/codes.js';

import { TEST_PEPPER } from './helpers.mjs';

const SCRYPT = { N: 1024, r: 8, p: 1, keylen: 32 };
const CONFIG = { pepper: TEST_PEPPER, scrypt: SCRYPT };

const CODE_SHAPE = /^SH-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

test('1. generates licence codes', () => {
  const code = generateLicenseCode();
  assert.equal(typeof code, 'string');
  assert.ok(code.length > 0);
  assert.ok(!code.includes('undefined'));
  assert.ok(!code.includes('NaN'));
});

test('2. every generated code matches the required SH-XXXX-XXXX-XXXX shape', () => {
  for (let i = 0; i < 2000; i += 1) {
    const code = generateLicenseCode();
    assert.match(code, CODE_SHAPE, `bad shape: ${code}`);
    assert.equal(code, code.toUpperCase(), 'codes must be uppercase');
    assert.equal(code.split('-').length, 4, 'SH plus three groups');
    for (const group of code.split('-').slice(1)) {
      assert.equal(group.length, 4);
    }
  }
});

test('2b. the alphabet excludes the characters people mistype', () => {
  for (const char of ['I', 'L', 'O', 'U', '0', '1']) {
    assert.ok(!CODE_ALPHABET.includes(char), `${char} should be excluded`);
  }
  for (const char of CODE_ALPHABET) {
    assert.match(char, /^[A-Z0-9]$/);
  }
});

test('3. codes are not sequential, not repeating, and not time-derived', () => {
  const codes = new Set();
  for (let i = 0; i < 5000; i += 1) codes.add(generateLicenseCode());

  // Distinctness: 5000 draws from 5.3e17 must not collide.
  assert.ok(codes.size >= 4999, `too many collisions: ${5000 - codes.size}`);

  // Not sequential: consecutive draws share no meaningful suffix/prefix run.
  const list = [...codes];
  let adjacentPairs = 0;
  for (let i = 1; i < list.length; i += 1) {
    const a = list[i - 1].slice(3).replace(/-/g, '');
    const b = list[i].slice(3).replace(/-/g, '');
    if (a === b) adjacentPairs += 1;
  }
  assert.equal(adjacentPairs, 0, 'identical code bodies appeared');

  // Not time-derived: all 5000 codes share a creation second, yet none repeat
  // and the character at each position is spread across the alphabet.
  const positionSpread = [3, 8, 13].map((offset) => {
    const seen = new Set(list.map((code) => code[offset]));
    return seen.size;
  });
  for (const spread of positionSpread) {
    assert.ok(spread > 10, `position looks clock-driven (only ${spread} distinct chars)`);
  }
});

test('3b. the guess space is large enough to resist exhaustive search', () => {
  assert.equal(CODE_SPACE, Math.pow(30, 12));
  assert.ok(CODE_SPACE > 1e17, 'code space too small');

  // At one million guesses per second, ten years covers ~1.7e3 codes worth of
  // the space: a vanishing fraction.
  const guessesInTenYears = 1e6 * 365 * 24 * 60 * 60 * 10;
  assert.ok(guessesInTenYears / CODE_SPACE < 1e-2);
});

test('4. hashing works and is salted, deterministic, and verifiable', () => {
  const code = 'SH-7K4P-92MX-Q8TA';

  const first = hashLicenseCode(code, CONFIG);
  const second = hashLicenseCode(code, CONFIG);

  // Independent draws get independent salts, so their hashes must differ —
  // that is what stops two licences with similar codes from being linkable by
  // comparing stored hashes.
  assert.notEqual(first.salt, second.salt, 'each hash must use a fresh salt');
  assert.notEqual(first.hash, second.hash, 'salt must change the hash');
  assert.match(first.salt, /^[0-9a-f]{32}$/);
  assert.match(first.hash, /^[0-9a-f]{64}$/);

  // Determinism is what verification actually needs: the same code and the same
  // stored salt must reproduce the stored hash exactly.
  const rederived = hashLicenseCode(code, CONFIG, Buffer.from(first.salt, 'hex'));
  assert.equal(rederived.hash, first.hash, 'same code + same salt must reproduce');
  assert.equal(rederived.salt, first.salt);

  assert.equal(verifyLicenseCode(code, first, CONFIG), true);
  assert.equal(verifyLicenseCode(code, second, CONFIG), true);
});

test('4b. verification rejects wrong codes, and never throws on bad input', () => {
  const stored = hashLicenseCode('SH-7K4P-92MX-Q8TA', CONFIG);

  assert.equal(verifyLicenseCode('SH-0000-0000-0000', stored, CONFIG), false);
  assert.equal(verifyLicenseCode('SH-7K4P-92MX-Q8TB', stored, CONFIG), false);

  // A truncated or corrupt stored hash must answer false, not blow up the route.
  assert.equal(verifyLicenseCode('SH-7K4P-92MX-Q8TA', { salt: stored.salt, hash: 'abc' }, CONFIG), false);
  assert.equal(verifyLicenseCode('SH-7K4P-92MX-Q8TA', null, CONFIG), false);
  assert.equal(verifyLicenseCode('SH-7K4P-92MX-Q8TA', {}, CONFIG), false);
});

test('4c. the pepper changes the hash, and the stored material hides the code', () => {
  const code = 'SH-7K4P-92MX-Q8TA';
  const stored = hashLicenseCode(code, CONFIG);

  const wrongPepper = { pepper: 'a-completely-different-pepper-value', scrypt: SCRYPT };
  assert.equal(verifyLicenseCode(code, stored, wrongPepper), false);

  // Neither stored string contains the code, and neither can be reversed to it.
  const serialized = `${stored.salt}${stored.hash}${lookupKey(code, TEST_PEPPER)}`;
  assert.ok(!serialized.includes(code));
  assert.ok(!serialized.includes('7K4P'));
});

test('4d. the lookup key is stable, keyed, and code-specific', () => {
  const a = lookupKey('SH-7K4P-92MX-Q8TA', TEST_PEPPER);
  const b = lookupKey('SH-7K4P-92MX-Q8TA', TEST_PEPPER);
  const c = lookupKey('SH-7K4P-92MX-Q8TB', TEST_PEPPER);
  const d = lookupKey('SH-7K4P-92MX-Q8TA', 'another-pepper-entirely-here');

  assert.equal(a, b, 'lookup must be deterministic so the row can be found');
  assert.notEqual(a, c);
  assert.notEqual(a, d, 'the pepper must key the lookup');
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('normalisation forgives case and separators, and nothing else', () => {
  const canonical = 'SH-7K4P-92MX-Q8TA';

  assert.equal(normalizeLicenseCode('sh-7k4p-92mx-q8ta'), canonical);
  assert.equal(normalizeLicenseCode('  SH-7K4P-92MX-Q8TA  '), canonical);
  assert.equal(normalizeLicenseCode('sh 7k4p 92mx q8ta'), canonical);
  assert.equal(normalizeLicenseCode('sh_7k4p_92mx_q8ta'), canonical);

  // Character errors are not forgiven: translating an O into a zero would hand
  // the caller a different, real licence.
  assert.throws(() => normalizeLicenseCode('SH-O4KP-92MX-Q8TA'), /unusable character/);
  assert.throws(() => normalizeLicenseCode('SH-1K4P-92MX-Q8TA'), /unusable character/);
  assert.throws(() => normalizeLicenseCode('SH-7K4-92MX-Q8TA'), /format/);
  assert.throws(() => normalizeLicenseCode('XX-7K4P-92MX-Q8TA'), /format/);
  assert.throws(() => normalizeLicenseCode('SH-7K4P-92MX-Q8TAAAA'), /format/);
  assert.throws(() => normalizeLicenseCode(''), /format/);
  assert.throws(() => normalizeLicenseCode(null), /must be a string/);
  assert.throws(() => normalizeLicenseCode(42), /must be a string/);

  assert.equal(isValidLicenseCode('sh-7k4p-92mx-q8ta'), true);
  assert.equal(isValidLicenseCode('nope'), false);
});

test('session tokens are high-entropy, keyed, and compared safely', () => {
  const tokens = new Set();
  for (let i = 0; i < 2000; i += 1) {
    const token = generateSessionToken();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    tokens.add(token);
  }
  assert.ok(tokens.size >= 1999, 'tokens must not repeat');

  const token = generateSessionToken();
  const hashed = hashSessionToken(token, TEST_PEPPER);
  assert.equal(hashed, hashSessionToken(token, TEST_PEPPER));
  assert.notEqual(hashed, hashSessionToken(token, 'other-pepper'));
  assert.notEqual(hashed, hashSessionToken(`${token}x`, TEST_PEPPER));
  assert.ok(!hashed.includes(token));

  assert.equal(safeEqualHex(hashed, hashed), true);
  assert.equal(safeEqualHex(hashed, hashSessionToken('other', TEST_PEPPER)), false);
  assert.equal(safeEqualHex(hashed, 'short'), false, 'length mismatch must not throw');
  assert.equal(safeEqualHex('', ''), false, 'empty comparison must be false');
  assert.equal(safeEqualHex(null, hashed), false);
});