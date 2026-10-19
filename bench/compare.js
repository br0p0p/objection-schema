'use strict';
// Classic class + JSON schema (Ajv) model vs. defineModel with zod / valibot.
// Same table, same columns, same constraints. Run: node bench/compare.js
//
// Each model is measured in a fresh process (objection's shared code paths would
// otherwise be JIT-optimized for whichever model runs first), in interleaved rounds.
// Per process we keep the fastest iteration; the table shows the median of those.
const process = require('node:process');
const Knex = require('knex');
const { Model } = require('objection');
const { defineModel, column } = require('objection-schema');
const v = require('valibot');
const { z } = require('zod');

const ROWS = 20000;

const jsonSchema = {
  type: 'object',
  required: ['firstName', 'lastName'],
  properties: {
    id: { type: 'integer' },
    firstName: { type: 'string', minLength: 1 },
    lastName: { type: 'string' },
    age: { type: ['integer', 'null'], minimum: 0 },
    address: {
      type: ['object', 'null'],
      required: ['street', 'city'],
      properties: { street: { type: 'string' }, city: { type: 'string' } },
    },
    parentId: { type: ['integer', 'null'] },
  },
};

class ClassicPerson extends Model {
  static tableName = 'people';
  static jsonSchema = jsonSchema;
}

const ZodPerson = defineModel({
  table: 'people',
  columns: {
    id: column(z.number().int()).generated(),
    firstName: z.string().min(1),
    lastName: z.string(),
    age: z.number().int().min(0).nullable().optional(),
    address: column(
      z.object({ street: z.string(), city: z.string() }).nullable().optional(),
    ).json(),
    parentId: z.number().int().nullable().optional(),
  },
});

const ValibotPerson = defineModel({
  table: 'people',
  columns: {
    id: column(v.number()).generated(),
    firstName: v.pipe(v.string(), v.minLength(1)),
    lastName: v.string(),
    age: v.nullish(v.pipe(v.number(), v.integer(), v.minValue(0))),
    address: column(v.nullish(v.object({ street: v.string(), city: v.string() }))).json(),
    parentId: v.nullish(v.pipe(v.number(), v.integer())),
  },
});

const models = {
  'classic (Ajv)': ClassicPerson,
  'defineModel (zod)': ZodPerson.modelClass,
  'defineModel (valibot)': ValibotPerson.modelClass,
};

async function bench(fn, n = 15) {
  for (let i = 0; i < 5; ++i) await fn();
  let best = Infinity;
  for (let i = 0; i < n; ++i) {
    const t0 = process.hrtime.bigint();
    await fn();
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return best;
}

async function main() {
  const dbRows = [];
  const inputs = [];
  for (let i = 0; i < ROWS; ++i) {
    const address = { street: `s${i}`, city: 'c' };
    dbRows.push({
      id: i + 1,
      firstName: `F${i}`,
      lastName: `L${i}`,
      age: i % 90,
      address: JSON.stringify(address),
      parentId: null,
    });
    inputs.push({ firstName: `F${i}`, lastName: `L${i}`, age: i % 90, address });
  }

  const knex = Knex({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await knex.schema.createTable('people', (t) => {
    t.increments('id');
    t.string('firstName');
    t.string('lastName');
    t.integer('age');
    t.text('address');
    t.integer('parentId');
  });
  for (let i = 0; i < dbRows.length; i += 500)
    await knex('people').insert(dbRows.slice(i, i + 500));

  const M = models[process.argv[2]];
  const result = {
    'rows → models': await bench(() => dbRows.map(row => M.fromDatabaseJson({ ...row }))),
    'validate insert': await bench(() => inputs.map(it => M.fromJson(it))),
    'validate patch': await bench(() =>
      inputs.map(it => M.fromJson({ age: it.age, lastName: it.lastName }, { patch: true })),
    ),
    'sqlite select': await bench(() => M.query(knex), 8),
  };
  await knex.destroy();
  process.stdout.write(JSON.stringify(result));
}

function report() {
  const { execFileSync } = require('node:child_process');
  const ROUNDS = Number(process.env.ROUNDS || 5);
  const samples = {};

  for (let round = 0; round < ROUNDS; ++round) {
    for (const name of Object.keys(models)) {
      const out = execFileSync(process.execPath, [__filename, name], { encoding: 'utf8' });
      (samples[name] = samples[name] || []).push(JSON.parse(out));
    }
  }

  const median = xs => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const cols = Object.keys(samples[Object.keys(models)[0]][0]);
  console.log(
    `${ROWS} rows, ${ROUNDS} rounds, node ${process.version}. Milliseconds, lower is better.\n`,
  );
  console.log(`| model | ${cols.join(' | ')} |`);
  console.log(`|---|${cols.map(() => '---:').join('|')}|`);
  for (const name of Object.keys(models)) {
    const cells = cols.map(c => median(samples[name].map(s => s[c])).toFixed(1));
    console.log(`| ${name} | ${cells.join(' | ')} |`);
  }
}

if (process.argv[2]) {
  main();
}
else {
  report();
}
