/**
 * Store Hub — run EVERY test in one command:
 *
 *   node tests/run-all.mjs
 *
 * Runs the licence-server suite (`node --test` inside server/) and every
 * client suite in tests/*.test.mjs, then prints one summary and exits
 * non-zero if anything failed.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rows = [];
let failed = 0;

function run(label, cwd, command, args) {
  // No shell: process.execPath lives under "C:\Program Files", which a cmd
  // shell would split at the space and then everything "fails" with exit 1.
  const res = spawnSync(command, args, { cwd, encoding: 'utf8' });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  let summary = '';
  const s = out.match(/ℹ tests (\d+)[\s\S]*?ℹ pass (\d+)/);
  if (s) summary = `${s[2]}/${s[1]} passed (node --test)`;
  const m = [...out.matchAll(/(\d+) passed, (\d+) failed/g)].pop();
  if (m) summary = `${m[1]} passed, ${m[2]} failed`;
  const p2 = out.match(/passed: (\d+)\s*\n\s*failed: (\d+)/);
  if (p2) summary = `${p2[1]} passed, ${p2[2]} failed`;
  const ok = res.status === 0;
  if (!ok) failed++;
  rows.push({ label, ok, summary: summary || `exit ${res.status}` });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(22)} ${summary || `exit ${res.status}`}`);
}

console.log('Store Hub — full test run (server + client)\n');

// 1 · licence server: `node --test` (its own package, sqlite support included)
run('server (node --test)', path.join(root, 'server'), process.execPath, ['--test']);

// 2 · every client suite
const testDir = path.join(root, 'tests');
for (const f of readdirSync(testDir).filter((n) => n.endsWith('.test.mjs')).sort()) {
  run(f, testDir, process.execPath, [path.join(testDir, f)]);
}

console.log('\n——————————————————————————————');
for (const r of rows) console.log(`${r.ok ? '  ✅' : '  ❌'} ${r.label.padEnd(22)} ${r.summary}`);
console.log('——————————————————————————————');
console.log(failed === 0 ? 'ALL SUITES PASSED' : `${failed} SUITE(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
