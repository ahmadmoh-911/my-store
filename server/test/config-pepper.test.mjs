import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, isPlaceholderPepper } from '../src/config.js';

const PROD = { NODE_ENV: 'production', STOREHUB_ADMIN_SUB: '123456789012345678901' };

test('PEPPER: the .env.example placeholder is recognised', () => {
  assert.equal(isPlaceholderPepper('random_32_character_hex_string'), true);
  assert.equal(isPlaceholderPepper('your_pepper_here'), true);
  assert.equal(isPlaceholderPepper('9f1c2b7e4a0d6c3e8b5a1f7d2c9e4b60'), false);
});

test('PEPPER: production refuses to boot on the placeholder pepper', () => {
  assert.throws(
    () => loadConfig({ ...PROD, STOREHUB_PEPPER: 'random_32_character_hex_string' }),
    /placeholder/,
  );
});

test('PEPPER: production boots with a real random pepper', () => {
  const cfg = loadConfig({ ...PROD, STOREHUB_PEPPER: '9f1c2b7e4a0d6c3e8b5a1f7d2c9e4b60' });
  assert.equal(cfg.pepper, '9f1c2b7e4a0d6c3e8b5a1f7d2c9e4b60');
});
