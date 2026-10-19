'use strict';
const { execFileSync } = require('node:child_process');
// Type-checking cost of a `defineModels` registry by size. Each model has 10 columns,
// two `references()` (one with an inverse) and a `relations()` declaration, and the
// file runs one typed graph query. Run: node bench/tooling/typecheck-scale.js [sizes...]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const process = require('node:process');

const root = path.resolve(__dirname, '../..');
const sizes = process.argv.slice(2).map(Number);

function source(n) {
  const lines = [
    `import { z } from ${JSON.stringify(path.join(root, 'node_modules/zod'))};`,
    `import { defineModel, defineModels, relations, column } from ${JSON.stringify(root)};`,
  ];

  for (let i = 0; i < n; ++i) {
    const columns = [
      `id: column(z.number()).generated()`,
      ...Array.from({ length: 8 }, (_, j) => `c${j}: z.string()`),
      `parentId: column(z.number().nullable()).references('M${(i + 1) % n}', 'id', { inverse: 'kids${i}' })`,
      `ownerId: column(z.number().nullable()).references('M${(i + 2) % n}', 'id', { as: 'owner' })`,
    ];
    lines.push(
      `const M${i} = defineModel({ table: 't${i}', columns: { ${columns.join(', ')} } });`,
    );
    lines.push(
      `const r${i} = relations(M${i}, (r) => ({ peers: r.hasMany(M${(i + 3) % n}, { from: 'id', to: 'ownerId' }) }));`,
    );
  }

  const keys = Array.from({ length: n }, (_, i) => `M${i}`);
  const decls = Array.from({ length: n }, (_, i) => `r${i}`);
  lines.push(`const db = defineModels({ ${keys.join(', ')} }, [${decls.join(', ')}]);`);
  lines.push(
    `export async function f() { const [x] = await db.M0.query().withGraphFetched('[parent.owner, peers, kids${n - 1}]'); const s: string = x.kids${n - 1}[0].c0; return s; }`,
  );
  return `${lines.join('\n')}\n`;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'objection-typecheck-'));
const tsc = path.join(root, 'node_modules/.bin/tsc');

for (const n of sizes.length ? sizes : [10, 40, 80]) {
  const file = path.join(dir, `registry${n}.ts`);
  fs.writeFileSync(file, source(n));

  let out;
  try {
    out = execFileSync(
      tsc,
      [
        '--noEmit',
        '--strict',
        '--esModuleInterop',
        '--skipLibCheck',
        '--target',
        'es2020',
        '--moduleResolution',
        'node',
        '--extendedDiagnostics',
        file,
      ],
      { encoding: 'utf8' },
    );
  }
  catch (err) {
    out = err.stdout;
    console.log(
      `${n} models: type errors\n${out
        .split('\n')
        .filter(l => l.includes('error'))
        .join('\n')}`,
    );
  }

  const stat = name => (out.match(new RegExp(`^${name}:\\s+(.*)$`, 'm')) || [])[1];
  console.log(
    `${String(n).padStart(3)} models: ${stat('Check time')} check, ${stat('Instantiations')} instantiations`,
  );
}

fs.rmSync(dir, { recursive: true, force: true });
