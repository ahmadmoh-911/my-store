/**
 * Store Hub — API configuration tests.
 *
 *   node tests/api-config.test.mjs
 *
 * Tests the shared API base URL configuration module.
 * Zero dependencies.
 */

const js = (rel) => new URL(`../js/${rel}`, import.meta.url).href;

let passed = 0;
let failed = 0;
const failures = [];

function ok(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ''}`);
  }
}

function eq(label, actual, expected) {
  if (Object.is(actual, expected)) {
    ok(label, true);
    return;
  }
  const bothObjects =
    actual !== null && expected !== null &&
    typeof actual === 'object' && typeof expected === 'object';
  const equal = bothObjects && JSON.stringify(actual) === JSON.stringify(expected);
  ok(label, equal, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(title) {
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------------ *
 * Import once, test by setting window and calling functions
 * ------------------------------------------------------------------ */

async function runTests() {
  const m = await import(js('api-config.js'));

  // Helper to set window config
  function setWindow(config) {
    globalThis.window = { STOREHUB_API_BASE: undefined, location: { origin: 'https://app.example.com' }, ...config };
  }

  section('1 · getApiBase (no config set)');
  {
    setWindow({});
    eq('returns empty for same-origin', m.getApiBase(), '');
  }

  section('2 · getApiBase (configured via window)');
  {
    setWindow({ STOREHUB_API_BASE: 'https://api.example.com' });
    eq('returns configured origin', m.getApiBase(), 'https://api.example.com');
  }

  section('3 · getApiBase strips trailing slash from window config');
  {
    setWindow({ STOREHUB_API_BASE: 'https://api.example.com/' });
    eq('strips trailing slash', m.getApiBase(), 'https://api.example.com');
  }

  section('4 · buildApiUrl');
  {
    setWindow({});
    eq('relative path when no base', m.buildApiUrl('/api/license/activate'), '/api/license/activate');

    setWindow({ STOREHUB_API_BASE: 'https://api.example.com' });
    eq('absolute URL when base set', m.buildApiUrl('/api/license/activate'), 'https://api.example.com/api/license/activate');

    setWindow({ STOREHUB_API_BASE: 'https://api.example.com/' });
    eq('no double slash with trailing slash in base', m.buildApiUrl('/api/auth/me'), 'https://api.example.com/api/auth/me');

    // Test rejection of non-absolute path
    setWindow({ STOREHUB_API_BASE: 'https://api.example.com' });
    try { m.buildApiUrl('api/license'); ok('rejects non-absolute path', false); }
    catch { ok('rejects non-absolute path', true); }
  }

  section('5 · getDefaultBase');
  {
    setWindow({});
    eq('license default', m.getDefaultBase('license'), '/api/license');
    eq('auth default', m.getDefaultBase('auth'), '/api/auth');
    eq('drive default', m.getDefaultBase('drive'), '/api/drive');

    try { m.getDefaultBase('unknown'); ok('rejects unknown group', false); }
    catch { ok('rejects unknown group', true); }
  }

  section('6 · resolveClientBase');
  {
    setWindow({});
    eq('license returns default path when no base', m.resolveClientBase('license'), '/api/license');
    eq('auth returns default path when no base', m.resolveClientBase('auth'), '/api/auth');
    eq('drive returns default path when no base', m.resolveClientBase('drive'), '/api/drive');

    setWindow({ STOREHUB_API_BASE: 'https://api.example.com' });
    eq('license returns full origin when base set', m.resolveClientBase('license'), 'https://api.example.com');
    eq('auth returns full origin when base set', m.resolveClientBase('auth'), 'https://api.example.com');
    eq('drive returns full origin when base set', m.resolveClientBase('drive'), 'https://api.example.com');
  }

  section('7 · setApiBaseForTesting / clearApiBaseForTesting');
  {
    setWindow({});
    m.setApiBaseForTesting('https://test.example.com');
    m.clearApiBaseForTesting();
    eq('clear removes override', m.getApiBase(), '');
    m.setApiBaseForTesting('https://a.com');
    const a = m.getApiBase();
    m.clearApiBaseForTesting();
    const b = m.getApiBase();
    eq('set then clear works', a === 'https://a.com' && b === '', true);
  }

  section('8 · invalid config rejected');
  {
    setWindow({ STOREHUB_API_BASE: 'https://api.example.com/v1' });
    try { m.getApiBase(); ok('rejects path in config', false); }
    catch { ok('rejects path in config', true); }

    setWindow({ STOREHUB_API_BASE: 'not-a-url' });
    try { m.getApiBase(); ok('rejects invalid URL', false); }
    catch { ok('rejects invalid URL', true); }
  }

  /* ------------------------------------------------------------------ *
   * Summary
   * ------------------------------------------------------------------ */
  console.log(`\n---`);
  console.log(`passed: ${passed}`);
  console.log(`failed: ${failed}`);
  if (failed > 0) {
    console.log('FAILURES:');
    failures.forEach(f => console.log(`  - ${f}`));
    process.exitCode = 1;
  } else {
    console.log('ALL TESTS PASSED');
  }
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exitCode = 1;
});