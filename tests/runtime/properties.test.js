'use strict';

// Property-based tests (fast-check). Each property is checked against an independent
// oracle instead of hand-picked examples:
//
// - per-column validation behaves like one equivalent zod object schema,
// - validation never mutates its input, and is idempotent,
// - patch validation only looks at the given keys,
// - an inserted row reads back as it was validated,
// - relation merging matches an independent model of the rules for random registries.

const assert = require('node:assert');
const expect = require('expect.js');
const fc = require('fast-check');
const { defineModel, defineModels, relations, column } = require('objection-schema');
const { z } = require('zod');
const { connect } = require('./db');

const NUM_RUNS = Number(process.env.FC_NUM_RUNS || 200);

// --- a model covering the column kinds the validator treats differently -------------

const Address = z.object({ street: z.string().min(1), city: z.string() });

const shape = {
  id: { schema: z.number().int().positive(), meta: 'generated' },
  firstName: { schema: z.string().trim().min(1) }, // required, transformed
  email: { schema: z.string().toLowerCase() }, // required, transformed
  age: { schema: z.number().int().min(0).nullable().optional() }, // optional
  status: { schema: z.enum(['active', 'inactive']).default('active') }, // schema default
  address: { schema: Address.nullable(), meta: 'json' }, // required, nested
  tags: { schema: z.array(z.string()).max(3).optional(), meta: 'json' }, // optional, nested
  createdAt: { schema: z.string().min(1), meta: 'hasDefault' }, // database default
};

const Person = defineModel({
  table: 'people',
  columns: Object.fromEntries(
    Object.entries(shape).map(([prop, { schema, meta }]) => {
      if (meta === 'generated')
        return [prop, column(schema).generated()];
      if (meta === 'hasDefault')
        return [prop, column(schema).hasDefault()];
      if (meta === 'json')
        return [prop, column(schema).json()];
      return [prop, schema];
    }),
  ),
});

// The oracle: one zod object schema with the same semantics. Columns the database fills
// in are optional; unknown keys pass through, as objection allows them by default.
const oracle = z.looseObject(
  Object.fromEntries(
    Object.entries(shape).map(([prop, { schema, meta }]) => [
      prop,
      meta === 'generated' || meta === 'hasDefault' ? schema.optional() : schema,
    ]),
  ),
);

// --- arbitraries ---------------------------------------------------------------------

const junk = fc.oneof(
  fc.string({ maxLength: 6 }),
  fc.integer(),
  fc.double({ noNaN: false }),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.array(fc.oneof(fc.integer(), fc.string({ maxLength: 3 })), { maxLength: 4 }),
  fc.dictionary(
    fc.constantFrom('street', 'city', 'x'),
    fc.oneof(fc.string({ maxLength: 4 }), fc.integer()),
    {
      maxKeys: 3,
    },
  ),
);

const valid = {
  id: fc.integer({ min: 1, max: 1e6 }),
  firstName: fc.string({ minLength: 1, maxLength: 8 }).map(s => ` ${s.replace(/\s/g, 'x')} `),
  email: fc.string({ maxLength: 8 }).map(s => `${s}A@B.C`),
  age: fc.oneof(fc.integer({ min: 0, max: 120 }), fc.constant(null)),
  status: fc.constantFrom('active', 'inactive'),
  address: fc.oneof(
    fc.record({
      street: fc.string({ minLength: 1, maxLength: 6 }),
      city: fc.string({ maxLength: 6 }),
    }),
    fc.constant(null),
  ),
  tags: fc.array(fc.string({ maxLength: 4 }), { maxLength: 3 }),
  createdAt: fc.string({ minLength: 1, maxLength: 6 }),
};

// Each column: mostly valid, sometimes junk, sometimes missing. Plus, sometimes, a key the
// model doesn't know. The weights give a mix of valid and invalid inputs (see the
// distribution test below); uniform choices made almost every input invalid.
const MISSING = Symbol('missing');
const anyInput = fc
  .record({
    ...Object.fromEntries(
      Object.keys(shape).map(prop => [
        prop,
        fc.oneof(
          { arbitrary: valid[prop], weight: 12 },
          { arbitrary: junk, weight: 1 },
          { arbitrary: fc.constant(MISSING), weight: 1 },
        ),
      ]),
    ),
    extra: fc.oneof(fc.constant(MISSING), fc.string({ maxLength: 4 })),
  })
  .map(input =>
    Object.fromEntries(Object.entries(input).filter(([, value]) => value !== MISSING)),
  );

const validInput = fc.record(
  Object.fromEntries(Object.keys(shape).map(prop => [prop, valid[prop]])),
  { requiredKeys: ['firstName', 'email', 'address'] },
);

// --- helpers -------------------------------------------------------------------------

function outcome(fn) {
  try {
    return { ok: true, value: dropUndefined(fn()) };
  }
  catch (err) {
    if (!err.data)
      throw err;
    return { ok: false, keys: Object.keys(err.data).sort() };
  }
}

function oracleOutcome(input) {
  const result = oracle.safeParse(input);
  return result.success
    ? { ok: true, value: dropUndefined(result.data) }
    : { ok: false, keys: [...new Set(result.error.issues.map(it => it.path.join('.')))].sort() };
}

function dropUndefined(obj) {
  return Object.fromEntries(Object.entries({ ...obj }).filter(([, value]) => value !== undefined));
}

const clone = value => (value === undefined ? undefined : structuredClone(value));

// --- properties ----------------------------------------------------------------------

describe('properties', () => {
  describe('validation', () => {
    it('generates a mix of valid and invalid inputs', () => {
      // Guards the generator itself: a property over inputs that are (almost) always
      // invalid would never check successful output.
      const samples = fc.sample(anyInput, { numRuns: 2000, seed: 42 });
      const validShare
        = samples.filter(it => oracle.safeParse(it).success).length / samples.length;
      expect(validShare).to.be.within(0.2, 0.8);
    });

    it('agrees with an equivalent zod object schema on success, output and error keys', () => {
      fc.assert(
        fc.property(anyInput, (input) => {
          expect(outcome(() => Person.validate(input))).to.eql(oracleOutcome(input));
        }),
        { numRuns: NUM_RUNS * 5 },
      );
    });

    it('never mutates its input', () => {
      fc.assert(
        fc.property(anyInput, (input) => {
          const before = clone(input);
          outcome(() => Person.modelClass.fromJson(input));
          outcome(() => Person.modelClass.fromJson(input, { patch: true }));
          // Both sides go through `clone` so that only values are compared (generated
          // dictionaries have null prototypes), and with `deepStrictEqual` rather than
          // expect.js `eql`, which treats NaN (a generated junk value) as unequal to itself.
          assert.deepStrictEqual(clone(input), before);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('is idempotent: validating valid output again changes nothing', () => {
      fc.assert(
        fc.property(validInput, (input) => {
          const once = Person.validate(input);
          expect(Person.validate(once)).to.eql(once);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('patch only validates the given keys and adds no defaults', () => {
      fc.assert(
        fc.property(anyInput, (input) => {
          const result = outcome(() => Person.validate(input, { patch: true }));
          const given = Object.keys(dropUndefined(input));
          const invalid = given.filter(
            prop => shape[prop] && !shape[prop].schema.safeParse(input[prop]).success,
          );

          if (invalid.length) {
            expect(result.ok).to.be(false);
            // Every error belongs to one of the invalid keys.
            for (const key of result.keys) {
              expect(invalid).to.contain(key.split('.')[0]);
            }
          }
          else {
            expect(result.ok).to.be(true);
            expect(Object.keys(result.value).sort()).to.eql(given.sort());
          }
        }),
        { numRuns: NUM_RUNS * 2 },
      );
    });
  });

  describe('database round-trip', () => {
    let knex;

    before(async () => {
      knex = await connect();
      await knex.schema.createTable('people', (t) => {
        t.increments('id');
        for (const col of ['firstName', 'email', 'status', 'createdAt']) t.string(col);
        t.integer('age');
        t.text('address');
        t.text('tags');
      });
    });

    after(() => knex.destroy());

    it('reads an inserted row back exactly as it was validated', async () => {
      await fc.assert(
        fc.asyncProperty(validInput, async ({ id, ...input }) => {
          const validated = Person.validate(input);
          const inserted = await Person.query(knex).insert(input);
          const read = await Person.query(knex).findById(inserted.id);

          const expected = {
            age: null,
            tags: null,
            createdAt: null,
            ...validated,
            id: inserted.id,
          };
          expect(dropUndefined(read)).to.eql(dropUndefined(expected));
        }),
        { numRuns: Math.ceil(NUM_RUNS / 4) },
      );
    });
  });

  describe('relation merging', () => {
    // Names are drawn from small pools so that collisions (duplicates across sources,
    // and relations named like columns) happen often.
    const NAMES = [
      'owner',
      'pets',
      'parent',
      'items',
      'label',
      'friends',
      'tags',
      'boss',
      'notes',
      'home',
    ];

    const registrySpec = fc.integer({ min: 2, max: 4 }).chain((modelCount) => {
      const model = fc.integer({ min: 0, max: modelCount - 1 });
      const name = fc.constantFrom(...NAMES);
      return fc.record({
        modelCount: fc.constant(modelCount),
        references: fc.array(
          fc.record({
            from: model,
            to: model,
            as: fc.option(name, { nil: undefined }),
            inverse: fc.option(name, { nil: undefined }),
            inverseKind: fc.constantFrom('many', 'one'),
          }),
          { maxLength: 4 },
        ),
        declarations: fc.array(fc.record({ owner: model, target: model, name }), { maxLength: 4 }),
        keyed: fc.array(fc.record({ owner: model, target: model, name }), { maxLength: 3 }),
      });
    });

    // Builds the registry for a spec. Every model has a `label` column, so a relation
    // named `label` must be rejected.
    function build(spec) {
      const columnsOf = (i) => {
        const columns = { id: z.number(), label: z.string() };
        spec.references.forEach((ref, j) => {
          if (ref.from === i) {
            const options = {};
            if (ref.as)
              options.as = ref.as;
            if (ref.inverse)
              options.inverse = { name: ref.inverse, kind: ref.inverseKind };
            columns[`fk${j}Id`] = column(z.number()).references(`M${ref.to}`, 'id', options);
          }
        });
        return columns;
      };

      const models = {};
      for (let i = 0; i < spec.modelCount; ++i) {
        models[`M${i}`] = defineModel({ name: `M${i}`, table: `t${i}`, columns: columnsOf(i) });
      }

      const declarations = spec.declarations.map(d =>
        relations(models[`M${d.owner}`], r => ({
          [d.name]: r.hasMany(models[`M${d.target}`], { from: 'id', to: 'id' }),
        })),
      );

      const keyed = {};
      for (const k of spec.keyed) {
        const previous = keyed[`M${k.owner}`];
        keyed[`M${k.owner}`] = r => ({
          ...(previous ? previous(r) : {}),
          [k.name]: r.belongsToOne(`M${k.target}`, { from: 'id', to: 'id' }),
        });
      }

      return () => defineModels(models, declarations, keyed);
    }

    // The independent model of the rules: every relation each source defines.
    function expectedRelations(spec) {
      const defs = [];
      spec.references.forEach((ref, j) => {
        defs.push({ owner: ref.from, name: ref.as || `fk${j}`, kind: 'BelongsToOneRelation' });
        if (ref.inverse) {
          defs.push({
            owner: ref.to,
            name: ref.inverse,
            kind: ref.inverseKind === 'one' ? 'HasOneRelation' : 'HasManyRelation',
          });
        }
      });
      spec.declarations.forEach((d, i) => {
        // Two relations() declarations can't define the same name for a model either.
        defs.push({ owner: d.owner, name: d.name, kind: 'HasManyRelation', declaration: i });
      });
      // The keyed object holds one function per model, so a repeated name there overwrites
      // instead of conflicting: the last one wins, like an object literal.
      const keyedLast = new Map();
      for (const k of spec.keyed) keyedLast.set(`${k.owner}.${k.name}`, k);
      for (const k of keyedLast.values()) {
        defs.push({ owner: k.owner, name: k.name, kind: 'BelongsToOneRelation' });
      }
      return defs;
    }

    // `Model.relation` keys that the rules reject: defined twice, or named like a column.
    function predictedConflicts(defs) {
      const seen = new Set();
      const conflicts = new Set();
      for (const def of defs) {
        const key = `M${def.owner}.${def.name}`;
        if (seen.has(key) || def.name === 'label')
          conflicts.add(key);
        seen.add(key);
      }
      return conflicts;
    }

    it('generates registries with and without conflicts', () => {
      const samples = fc.sample(registrySpec, { numRuns: 1000, seed: 42 });
      const share
        = samples.filter(spec => predictedConflicts(expectedRelations(spec)).size > 0).length
          / samples.length;
      expect(share).to.be.within(0.2, 0.8);
    });

    it('throws exactly when a name is defined twice or clashes with a column', () => {
      fc.assert(
        fc.property(registrySpec, (spec) => {
          const defs = expectedRelations(spec);
          const conflicts = predictedConflicts(defs);

          let error = null;
          let db = null;
          try {
            db = build(spec)();
          }
          catch (err) {
            error = err;
          }

          if (conflicts.size) {
            expect(error).not.to.be(null);
            const named = /relation "(M\d+\.\w+)"/.exec(error.message);
            expect(named).not.to.be(null);
            expect([...conflicts]).to.contain(named[1]);
          }
          else {
            if (error)
              throw error;
            for (let i = 0; i < spec.modelCount; ++i) {
              const actual = Object.entries(db[`M${i}`].modelClass.getRelations())
                .map(([name, relation]) => `${name}:${relation.constructor.name}`)
                .sort();
              const expected = defs
                .filter(d => d.owner === i)
                .map(d => `${d.name}:${d.kind}`)
                .sort();
              expect(actual).to.eql(expected);
            }
          }
        }),
        { numRuns: NUM_RUNS * 2 },
      );
    });
  });
});
