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

import { readPublicUrl, assertProductionRedirectUris } from '../src/config.js';

test('PUBLIC URL: Render external URL derives every Google callback and the portal', () => {
  const cfg = loadConfig({
    ...PROD,
    STOREHUB_PEPPER: '9f1c2b7e4a0d6c3e8b5a1f7d2c9e4b60',
    RENDER_EXTERNAL_URL: 'https://storehub.onrender.com/',
  });
  assert.equal(cfg.google.authRedirectUri, 'https://storehub.onrender.com/api/auth/google/callback');
  assert.equal(cfg.google.adminRedirectUri, 'https://storehub.onrender.com/api/admin/auth/callback');
  assert.equal(cfg.google.driveRedirectUri, 'https://storehub.onrender.com/api/drive/connect/callback');
  assert.equal(cfg.admin.portalUrl, 'https://storehub.onrender.com/admin/');
  assert.doesNotThrow(() => assertProductionRedirectUris(cfg));
});

test('PUBLIC URL: an explicit variable wins over the derived value', () => {
  const cfg = loadConfig({
    ...PROD,
    STOREHUB_PEPPER: '9f1c2b7e4a0d6c3e8b5a1f7d2c9e4b60',
    STOREHUB_PUBLIC_URL: 'https://shop.example.com',
    GOOGLE_ADMIN_REDIRECT_URI: 'https://admin.example.com/api/admin/auth/callback',
  });
  assert.equal(cfg.google.adminRedirectUri, 'https://admin.example.com/api/admin/auth/callback');
  assert.equal(cfg.google.authRedirectUri, 'https://shop.example.com/api/auth/google/callback');
});

test('PUBLIC URL: junk reads as unset, so production still names what is missing', () => {
  assert.equal(readPublicUrl({ STOREHUB_PUBLIC_URL: 'not a url' }), '');
  assert.equal(readPublicUrl({ STOREHUB_PUBLIC_URL: 'ftp://x.example' }), '');
  const cfg = loadConfig({ ...PROD, STOREHUB_PEPPER: '9f1c2b7e4a0d6c3e8b5a1f7d2c9e4b60' });
  assert.throws(() => assertProductionRedirectUris(cfg), /GOOGLE_AUTH_REDIRECT_URI/);
});
