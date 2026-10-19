'use strict';

// Installs the packed package into a fresh project, the way users get it, and runs a small
// app from CommonJS, ES modules and TypeScript (nodenext) against the app's own objection.
// Catches files missing from the package, broken `exports` and a second copy of objection
// (which would break `instanceof ValidationError`). Run: pnpm run test:pack
//
// The app installs with npm, like most users. Only this repo is pnpm-only.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const process = require('node:process');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'objection-schema-pack-'));
const keep = process.argv.includes('--keep');

function run(cmd, args, cwd = dir) {
  return execFileSync(cmd, args, { cwd, stdio: 'pipe', encoding: 'utf8' });
}

const write = (file, content) => fs.writeFileSync(path.join(dir, file), content.trimStart());

try {
  // The package contains only what users need.
  const packed = JSON.parse(run('pnpm', ['pack', '--json', '--pack-destination', dir], root));

  const unexpected = packed.files
    .map(it => it.path)
    .filter(it => !/^(?:dist\/|package\.json$|README\.md$)/.test(it));

  if (unexpected.length)
    throw new Error(`unexpected files in the package: ${unexpected}`);

  const deps = ['objection', 'knex', 'sqlite3', 'zod', 'typescript', '@types/node'];
  write('package.json', JSON.stringify({ name: 'app', private: true }));
  run('npm', [
    'install',
    '--no-audit',
    '--no-fund',
    path.resolve(dir, packed.filename),
    ...deps.map(name => `${name}@${pkg.devDependencies[name]}`),
  ]);

  write(
    'app.cjs',
    `
const assert = require('assert');
const Knex = require('knex');
const { z } = require('zod');
const { Model, ValidationError } = require('objection');
const { defineModel, defineModels, column } = require('objection-schema');

// objection-schema uses the app's objection, not a copy of its own.
const own = require.resolve('objection', { paths: [require.resolve('objection-schema')] });
assert.strictEqual(own, require.resolve('objection'));

module.exports = (async () => {
  const knex = Knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await knex.schema.createTable('items', (t) => { t.increments('id'); t.string('name'); });

  const Item = defineModel({ table: 'items', columns: { id: column(z.number()).generated(), name: z.string().trim().min(1) } });
  const db = defineModels({ Item });

  const item = await db.Item.query(knex).insert({ name: ' ok ' });
  assert.strictEqual(item.name, 'ok');
  assert.ok(item instanceof Model);

  const error = await db.Item.query(knex).insert({ name: '' }).catch((err) => err);
  assert.ok(error instanceof ValidationError, 'ValidationError from the app\\'s objection');
  assert.strictEqual(error.statusCode, 400);

  await knex.destroy();
  return 'cjs ok';
})();
`,
  );

  write(
    'app.mjs',
    `
import assert from 'node:assert';
import { createRequire } from 'node:module';
import * as esm from 'objection-schema';

const cjs = createRequire(import.meta.url)('objection-schema');
for (const name of Object.keys(cjs)) assert.strictEqual(esm[name], cjs[name], name);

console.log(await createRequire(import.meta.url)('./app.cjs'));
console.log('esm ok');
`,
  );

  const typed = imports => `
${imports}

const Item = defineModel({
  table: 'items',
  columns: { id: column(z.number()).generated(), name: z.string(), tags: column(z.array(z.string())).json() },
});
const db = defineModels({ Item });

export async function check() {
  const rows = await db.Item.query().select('id', 'name');
  const id: number = rows[0].id;
  const name: string = rows[0].name;
  // @ts-expect-error not selected
  rows[0].tags;
  // @ts-expect-error unknown column
  db.Item.query().where('nme', 'x');
  // @ts-expect-error required on insert
  db.Item.query().insert({ name: 'x' });
  return [id, name];
}
`;

  const zod = `import { z } from 'zod';`;
  write(
    'typed.mts',
    typed(`${zod}\nimport { defineModel, defineModels, column } from 'objection-schema';`),
  );
  write(
    'typed.cts',
    typed(
      `${zod}\nimport schema = require('objection-schema');\nconst { defineModel, defineModels, column } = schema;`,
    ),
  );
  write(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: 'es2020',
        module: 'nodenext',
        moduleResolution: 'nodenext',
        skipLibCheck: false,
        types: ['node'],
      },
      files: ['typed.mts', 'typed.cts'],
    }),
  );

  console.log(run('node', ['app.mjs']).trim());
  run(path.join(dir, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json']);
  console.log('types ok (nodenext, from ESM and CJS)');
}
catch (err) {
  console.error(err.stdout || '', err.stderr || '', err.stdout || err.stderr ? '' : err);
  process.exitCode = 1;
}
finally {
  if (keep)
    console.log(`kept ${dir}`);
  else fs.rmSync(dir, { recursive: true, force: true });
}
