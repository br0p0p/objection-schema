'use strict';
// What does validating with zod cost? Compared against no validation, Ajv (classic
// jsonSchema) and valibot, for a simple and a "realistic" schema (formats, regex,
// refinements, transforms). Each case runs in a fresh process over interleaved rounds;
// per process we keep the fastest iteration, the table shows the median of those.
// Run: node bench/zod-cost.js
const { execFileSync } = require('child_process');

const ROWS = 20000;
const ROUNDS = Number(process.env.ROUNDS || 5);

function makeModels(kind) {
  const { z } = require('zod');
  const v = require('valibot');
  const { Model } = require('objection');
  const { defineModel, column, unchecked } = require('objection-schema');

  const simple = {
    zod: () => ({
      id: column(z.number().int()).generated(),
      firstName: z.string().min(1),
      lastName: z.string(),
      age: z.number().int().min(0).nullable().optional(),
      email: z.string(),
      status: z.string(),
    }),
    valibot: () => ({
      id: column(v.number()).generated(),
      firstName: v.pipe(v.string(), v.minLength(1)),
      lastName: v.string(),
      age: v.nullish(v.pipe(v.number(), v.integer(), v.minValue(0))),
      email: v.string(),
      status: v.string(),
    }),
    ajv: {
      type: 'object',
      required: ['firstName', 'lastName', 'email', 'status'],
      properties: {
        id: { type: 'integer' },
        firstName: { type: 'string', minLength: 1 },
        lastName: { type: 'string' },
        age: { type: ['integer', 'null'], minimum: 0 },
        email: { type: 'string' },
        status: { type: 'string' },
      },
    },
  };

  const realistic = {
    zod: () => ({
      id: column(z.number().int()).generated(),
      firstName: z.string().trim().min(1).max(100),
      lastName: z.string().trim().min(1).max(100),
      age: z.number().int().min(0).max(150).nullable().optional(),
      email: z.string().trim().toLowerCase().email(),
      status: z.enum(['active', 'inactive', 'banned']).default('active'),
      website: z.string().url().nullable().optional(),
      zip: z.string().regex(/^\d{5}$/),
      tags: column(
        z
          .array(z.string().min(1))
          .max(10)
          .refine((t) => new Set(t).size === t.length),
      ).json(),
    }),
    valibot: () => ({
      id: column(v.number()).generated(),
      firstName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
      lastName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
      age: v.nullish(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(150))),
      email: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.email()),
      status: v.optional(v.picklist(['active', 'inactive', 'banned']), 'active'),
      website: v.nullish(v.pipe(v.string(), v.url())),
      zip: v.pipe(v.string(), v.regex(/^\d{5}$/)),
      tags: column(
        v.pipe(
          v.array(v.pipe(v.string(), v.minLength(1))),
          v.maxLength(10),
          v.check((t) => new Set(t).size === t.length),
        ),
      ).json(),
    }),
    // Ajv has no trim/lowercase transforms; this is the closest equivalent.
    ajv: {
      type: 'object',
      required: ['firstName', 'lastName', 'email', 'zip'],
      properties: {
        id: { type: 'integer' },
        firstName: { type: 'string', minLength: 1, maxLength: 100 },
        lastName: { type: 'string', minLength: 1, maxLength: 100 },
        age: { type: ['integer', 'null'], minimum: 0, maximum: 150 },
        email: { type: 'string', format: 'email' },
        status: { type: 'string', enum: ['active', 'inactive', 'banned'], default: 'active' },
        website: { type: ['string', 'null'], format: 'uri' },
        zip: { type: 'string', pattern: '^\\d{5}$' },
        tags: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          maxItems: 10,
          uniqueItems: true,
        },
      },
    },
  };

  const [schemaName, lib] = kind.split(':');
  const schema = schemaName === 'simple' ? simple : realistic;

  if (lib === 'ajv') {
    return class Person extends Model {
      static tableName = 'people';
      static jsonSchema = schema.ajv;
    };
  }

  if (lib === 'none') {
    const columns = Object.fromEntries(
      Object.keys(schema.ajv.properties).map((k) => [k, unchecked()]),
    );
    return defineModel({ table: 'people', columns }).modelClass;
  }

  return defineModel({ table: 'people', columns: schema[lib]() }).modelClass;
}

function inputs(kind) {
  const realistic = kind.startsWith('realistic');
  return Array.from({ length: ROWS }, (_, i) => {
    const row = {
      firstName: ` First${i} `,
      lastName: `Last${i}`,
      age: i % 90,
      email: `User${i}@Example.com`,
      status: 'active',
    };
    if (realistic) {
      Object.assign(row, {
        website: i % 2 ? `https://example.com/${i}` : null,
        zip: '12345',
        tags: ['a', 'b', `t${i % 7}`],
      });
      row.firstName = row.firstName.trim();
    }
    return row;
  });
}

async function bestOf(fn, n) {
  for (let i = 0; i < 3; ++i) await fn();
  let best = Infinity;
  for (let i = 0; i < n; ++i) {
    const t0 = process.hrtime.bigint();
    await fn();
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return best;
}

async function child(kind) {
  const Model = makeModels(kind);
  const rows = inputs(kind);
  const result = {
    insert: await bestOf(() => rows.map((it) => Model.fromJson(it)), 15),
    patch: await bestOf(
      () =>
        rows.map((it) => Model.fromJson({ age: it.age, lastName: it.lastName }, { patch: true })),
      15,
    ),
  };

  // The same validation next to a real (in-memory sqlite) insert, one row per query.
  if (kind.startsWith('realistic')) {
    const Knex = require('knex');
    const knex = Knex({
      client: 'sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    await knex.schema.createTable('people', (t) => {
      t.increments('id');
      for (const c of ['firstName', 'lastName', 'email', 'status', 'website', 'zip', 'tags'])
        t.string(c);
      t.integer('age');
    });
    const some = rows.slice(0, 1000);
    result['1k sqlite inserts'] = await bestOf(async () => {
      for (const row of some) await Model.query(knex).insert(row);
    }, 3);
    await knex.destroy();
  }

  process.stdout.write(JSON.stringify(result));
}

function startup() {
  const time = (code) => {
    const out = execFileSync(
      process.execPath,
      [
        '-e',
        `const t=process.hrtime.bigint();${code};process.stdout.write(String(Number(process.hrtime.bigint()-t)/1e6))`,
      ],
      {
        cwd: __dirname,
        encoding: 'utf8',
      },
    );
    return Number(out);
  };
  const median = (f) => [0, 1, 2, 3, 4].map(f).sort((a, b) => a - b)[2];

  console.log('\nStartup (median of 5 fresh processes):');
  console.log(
    `  require('zod')                      ${median(() => time("require('zod')")).toFixed(1)} ms`,
  );
  console.log(
    `  require('valibot')                  ${median(() => time("require('valibot')")).toFixed(1)} ms`,
  );
  console.log(
    `  require('ajv') + ajv-formats        ${median(() => time("require('ajv');require('ajv-formats')")).toFixed(1)} ms`,
  );
  const define = `const {z}=require('zod');const {defineModel,column}=require('objection-schema');const t0=process.hrtime.bigint();for(let i=0;i<100;i++)defineModel({table:'t'+i,columns:{id:column(z.number()).generated(),a:z.string().min(1),b:z.string().email(),c:z.number().int().nullable().optional(),d:z.enum(['x','y']).default('x'),e:z.string(),f:z.boolean(),g:z.date(),h:z.string().url().optional(),i:z.number()}});process.stdout.write(String(Number(process.hrtime.bigint()-t0)/1e6));process.exit()`;
  const out = median(() =>
    Number(execFileSync(process.execPath, ['-e', define], { cwd: __dirname, encoding: 'utf8' })),
  );
  console.log(
    `  defineModel() x100 (10 zod columns) ${out.toFixed(1)} ms  (schemas built + one validate(undefined) probe per column)`,
  );
}

function report() {
  const kinds = [
    'simple:none',
    'simple:ajv',
    'simple:zod',
    'simple:valibot',
    'realistic:none',
    'realistic:ajv',
    'realistic:zod',
    'realistic:valibot',
  ];
  const samples = {};
  for (let r = 0; r < ROUNDS; ++r) {
    for (const kind of kinds) {
      const out = execFileSync(process.execPath, [__filename, kind], { encoding: 'utf8' });
      (samples[kind] = samples[kind] || []).push(JSON.parse(out));
    }
  }
  const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const label = { none: 'no validation', ajv: 'classic (Ajv)', zod: 'zod', valibot: 'valibot' };

  console.log(
    `${ROWS} rows per validation run, ${ROUNDS} rounds, node ${process.version}. ms, lower is better.\n`,
  );
  console.log('| schema | validator | insert | patch | µs/row (insert) | 1k sqlite inserts |');
  console.log('|---|---|---:|---:|---:|---:|');
  for (const kind of kinds) {
    const [schema, lib] = kind.split(':');
    const m = (k) =>
      samples[kind][0][k] === undefined ? null : median(samples[kind].map((s) => s[k]));
    const ins = m('insert');
    const db = m('1k sqlite inserts');
    console.log(
      `| ${schema} | ${label[lib]} | ${ins.toFixed(1)} | ${m('patch').toFixed(1)} | ${((ins * 1000) / ROWS).toFixed(2)} | ${db === null ? '–' : db.toFixed(0)} |`,
    );
  }
  startup();
}

if (process.argv[2]) {
  child(process.argv[2]);
} else {
  report();
}
