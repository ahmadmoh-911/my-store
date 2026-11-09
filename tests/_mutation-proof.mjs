/**
 * Mutation proofs: break a fix, the covering test must go red, restore, it must
 * go green again. Restores byte-for-byte. Prints a table.
 *
 *   node tests/_mutation-proof.mjs
 */
import fs from 'fs';
import { execFileSync } from 'child_process';

const ROOT = new URL('..', import.meta.url);
const run = (args) => {
  try {
    const out = execFileSync(process.execPath, args, {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
  }
};

const summaryLine = (out) => {
  const m = [...out.matchAll(/(\d+) passed, (\d+) failed/g)].pop();
  return m ? `${m[1]} passed, ${m[2]} failed` : '(no summary)';
};

const cases = [
  {
    task: '7 · الدفعة المختارة تُستهلك أولًا (takeLots preferredLotId)',
    file: 'js/db.js',
    find: '  if (preferredLotId) {\n    const pref = ordered.find((b) => b.id === preferredLotId);',
    replace: '  if (false && preferredLotId) {\n    const pref = ordered.find((b) => b.id === preferredLotId);',
    test: 'tests/lots.test.mjs',
  },
  {
    task: '7أ · التجديد بسعر جديد يُنشئ دفعة جديدة بسعرها (purchaseCore)',
    file: 'js/db.js',
    find: 'const sellingPrice = newPrice !== null ? newPrice : (Number(p.price) || 0);',
    replace: 'const sellingPrice = (Number(p.price) || 0);',
    test: 'tests/lots.test.mjs',
  },
  {
    task: '6 · حجز السلة يرفض الزيادة عن المتاح (cart-store addLine)',
    file: 'js/cart-store.js',
    find: "  if (available <= 0) return 'full';",
    replace: "  if (false) return 'full';",
    test: 'tests/lots.test.mjs',
  },
  {
    task: '4 · حدث تغيّر المنتجات يُبطل كاش شاشة البيع (pos.js)',
    file: 'js/screens/pos.js',
    find: "if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {",
    replace: 'if (false) {',
    test: 'tests/pos-refresh.test.mjs',
  },
  {
    task: '8/9 · checkout لا يفتح promptDialog ويستدعي منتقي الدفعة (static)',
    file: 'js/checkout.js',
    find: '      if (!needsLotPicker(lots)) continue;',
    replace: '      if (false) continue;',
    test: 'server/test/module-imports.test.mjs',
  },
];

console.log('mutation proofs\n');
const rows = [];
for (const c of cases) {
  const abs = new URL(c.file, ROOT);
  const original = fs.readFileSync(abs);
  const src = original.toString('utf8');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const find = c.find.replace(/\n/g, eol);
  const replace = c.replace.replace(/\n/g, eol);
  if (!src.includes(find)) {
    rows.push([c.task, 'ANCHOR NOT FOUND', '', '']);
    console.log(`!! anchor not found: ${c.task} -> ${c.file}`);
    continue;
  }
  // baseline
  const base = run(c.test.startsWith('server/') ? ['--test', c.test] : [c.test]);
  // mutated
  fs.writeFileSync(abs, src.replace(find, replace), 'utf8');
  let mutated;
  try {
    mutated = run(c.test.startsWith('server/') ? ['--test', c.test] : [c.test]);
  } finally {
    fs.writeFileSync(abs, original); // byte-for-byte restore
  }
  // restored
  const restored = run(c.test.startsWith('server/') ? ['--test', c.test] : [c.test]);
  const sameBytes = fs.readFileSync(abs).equals(original);

  rows.push([
    c.task,
    base.ok ? `green (${summaryLine(base.out)})` : `RED baseline! (${summaryLine(base.out)})`,
    mutated.ok ? `still GREEN (${summaryLine(mutated.out)}) <-- NOT PROVEN` : `RED (${summaryLine(mutated.out)})`,
    restored.ok ? `green again (${summaryLine(restored.out)})${sameBytes ? '' : ' [BYTES DIFFER!]'}` : `still RED after restore!`,
  ]);
}

const w = [46, 30, 34, 34];
console.log('\n' + rows.map((r) => r.map((v, i) => String(v).padEnd(w[i])).join(' | ')).join('\n'));
const bad = rows.filter((r) => !r[1].startsWith('green') || !r[2].startsWith('RED') || !r[3].startsWith('green'));
console.log(bad.length ? `\n${bad.length} case(s) NOT proven` : '\nALL CASES PROVEN');
process.exit(bad.length ? 1 : 0);
