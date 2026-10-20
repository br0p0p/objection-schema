'use strict';

// Features beyond the main walkthrough in defineModel.test.js: every hook, model and
// relation options, composite keys, classic model handles, error paths and handle methods.

const expect = require('expect.js');
const { Model, ValidationError, raw } = require('objection');

const {
  defineModel,
  defineModels,
  relations,
  column,
  defineModelNames,
  toQueryBuilder,
  isModelDefinition,
} = require('objection-schema');

const v = require('valibot');
const { z } = require('zod');
const { connect } = require('./db');

describe('features', () => {
  let knex;

  before(async () => {
    knex = await connect();
    Model.knex(knex);

    await knex.schema
      .createTable('owners', (t) => {
        t.increments('id');
        t.string('name');
        t.text('address');
      })
      .createTable('pets', (t) => {
        t.increments('id');
        t.string('name');
        t.string('species');
        t.integer('ownerId');
      })
      .createTable('accounts', (t) => {
        t.string('tenant');
        t.integer('id');
        t.string('name');
        t.primary(['tenant', 'id']);
      })
      .createTable('memberships', (t) => {
        t.increments('id');
        t.string('tenant');
        t.integer('accountId');
        t.string('role');
      })
      .createTable('films', (t) => {
        t.increments('id');
        t.string('title');
      })
      .createTable('owner_films', (t) => {
        t.integer('ownerId');
        t.integer('filmId');
      });
  });

  after(() => knex.destroy());

  beforeEach(async () => {
    for (const table of ['owners', 'pets', 'accounts', 'memberships', 'films', 'owner_films']) {
      await knex(table).delete();
    }
  });

  const ownerColumns = () => ({
    id: column(z.number()).generated(),
    name: z.string().min(1),
  });

  describe('hooks', () => {
    it('calls every hook with the row, and the options where objection passes them', async () => {
      const calls = [];

      const record
        = name =>
          (row, ...args) => {
            const last = args[args.length - 1];
            calls.push({
              name,
              row: { ...row },
              args: args.length,
              ctx: !!last && 'transaction' in last,
            });

            if (args.length === 2)
              calls[calls.length - 1].patch = args[0].patch;
          };

      const Owner = defineModel({
        table: 'owners',
        columns: ownerColumns(),
        hooks: {
          beforeInsert: record('beforeInsert'),
          afterInsert: record('afterInsert'),
          beforeUpdate: record('beforeUpdate'),
          afterUpdate: record('afterUpdate'),
          afterFind: record('afterFind'),
          beforeDelete: record('beforeDelete'),
          afterDelete: record('afterDelete'),
        },
      });

      const owner = await Owner.query().insert({ name: 'A' });
      await Owner.query().findById(owner.id);
      await owner.$query().patch({ name: 'B' });
      await owner.$query().delete();

      expect(calls.map(it => it.name)).to.eql([
        'beforeInsert',
        'afterInsert',
        'afterFind',
        'beforeUpdate',
        'afterUpdate',
        'beforeDelete',
        'afterDelete',
      ]);

      // (row, ctx) hooks get 1 extra argument, (row, options, ctx) hooks get 2.
      const byName = Object.fromEntries(calls.map(it => [it.name, it]));

      for (const name of [
        'beforeInsert',
        'afterInsert',
        'afterFind',
        'beforeDelete',
        'afterDelete',
      ]) {
        expect(byName[name].args).to.be(1);
        expect(byName[name].ctx).to.be(true);
      }

      for (const name of ['beforeUpdate', 'afterUpdate']) {
        expect(byName[name].args).to.be(2);
        expect(byName[name].patch).to.be(true);
        expect(byName[name].ctx).to.be(true);
      }

      expect(byName.beforeInsert.row.name).to.be('A');
      expect(byName.beforeUpdate.row.name).to.be('B');
    });

    it('awaits async hooks, which is where async validation goes', async () => {
      const Owner = defineModel({
        table: 'owners',
        columns: ownerColumns(),
        hooks: {
          async beforeInsert(row) {
            await new Promise(resolve => setTimeout(resolve, 5));

            if (row.name === 'taken') {
              throw new ValidationError({
                type: 'ModelValidation',
                data: { name: [{ message: 'is taken' }] },
              });
            }
          },
        },
      });

      await Owner.query().insert({ name: 'free' });

      try {
        await Owner.query().insert({ name: 'taken' });
        expect().fail('should have thrown');
      }
      catch (err) {
        expect(err).to.be.a(ValidationError);
        expect(err.data.name[0].message).to.be('is taken');
      }

      expect(await Owner.query().resultSize()).to.be(1);
    });

    it('rejects unknown hooks', () => {
      expect(() =>
        defineModel({ table: 'owners', columns: ownerColumns(), hooks: { beforeSave() {} } }),
      ).to.throwError(/unknown hook "beforeSave"/);
    });

    it('rejects hook names that are only inherited from Object.prototype', () => {
      for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
        const hooks = Object.defineProperty({}, name, { value() {}, enumerable: true });

        expect(() => defineModel({ table: 'owners', columns: ownerColumns(), hooks })).to.throwError(
          new RegExp(`unknown hook "${name}"`),
        );
      }
    });
  });

  describe('model options', () => {
    it('`validate: false` keeps the types but skips runtime validation', async () => {
      const Owner = defineModel({ table: 'owners', columns: ownerColumns(), validate: false });

      const owner = await Owner.query().insert({ name: '' });
      expect(owner.name).to.be('');
      expect(Owner.validate({ name: 42 })).to.eql({ name: 42 });
    });

    it('validates its configuration', () => {
      expect(() => defineModel({ columns: ownerColumns() })).to.throwError(
        /`table` must be a string/,
      );
      expect(() =>
        defineModel({ table: 'x', columns: ownerColumns(), base: class {} }),
      ).to.throwError(/`base` must be an objection Model class/);
      expect(() => defineModel({ table: 'x', columns: ownerColumns(), id: 'uuid' })).to.throwError(
        /id column "uuid" is not in `columns`/,
      );
      expect(() => defineModel({ table: 'x', columns: { id: 'nope' } })).to.throwError(
        /column "id" must be a Standard Schema/,
      );
      expect(() => column({})).to.throwError(/expects a Standard Schema/);
      expect(() =>
        column(z.number()).references('Owner', 'id', { inverse: { name: 'x', kind: 'some' } }),
      ).to.throwError(/inverse kind must be "many" or "one"/);
    });
  });

  describe('relation options', () => {
    function makePetModels(petRelationOptions) {
      const Owner = defineModel({
        table: 'owners',
        columns: ownerColumns(),
      });

      const Pet = defineModel({
        table: 'pets',
        columns: {
          id: column(z.number()).generated(),
          name: z.string(),
          species: z.string(),
          ownerId: z.number().nullable().optional(),
        },
        modifiers: { dogs: q => q.where('species', 'dog') },
      });

      const db = defineModels({ Owner, Pet }, [
        relations(Owner, r => ({
          pets: r.hasMany(Pet, { from: 'id', to: 'ownerId' }),
          dogs: r.hasMany(Pet, { from: 'id', to: 'ownerId' }, petRelationOptions),
        })),
      ]);

      return db;
    }

    for (const [label, modify] of [
      ['function', q => q.where('species', 'dog')],
      ['modifier name', 'dogs'],
    ]) {
      it(`\`modify\` (${label}) filters the relation`, async () => {
        const db = makePetModels({ modify });

        const owner = await db.Owner.query().insertGraph({
          name: 'A',
          pets: [
            { name: 'Rex', species: 'dog' },
            { name: 'Tom', species: 'cat' },
          ],
        });

        const fetched = await db.Owner.query().findById(owner.id).withGraphFetched('[pets, dogs]');
        expect(fetched.pets).to.have.length(2);
        expect(fetched.dogs.map(it => it.name)).to.eql(['Rex']);
      });
    }

    it('`beforeInsert` runs for models inserted through the relation', async () => {
      const seen = [];

      const db = makePetModels({
        beforeInsert(pet) {
          seen.push(pet.name);
          pet.species = 'dog';
        },
      });

      const owner = await db.Owner.query().insert({ name: 'A' });
      await db.Owner.relatedQuery('dogs').for(owner.id).insert({ name: 'Rex', species: 'unknown' });

      expect(seen).to.eql(['Rex']);
      expect((await knex('pets').first()).species).to.be('dog');
    });
  });

  describe('relation kinds', () => {
    it('hasOne and hasOneThrough', async () => {
      const Owner = defineModel({ table: 'owners', columns: ownerColumns() });

      const Pet = defineModel({
        table: 'pets',
        columns: {
          id: column(z.number()).generated(),
          name: z.string(),
          species: z.string(),
          ownerId: z.number(),
        },
      });

      const Film = defineModel({
        table: 'films',
        columns: { id: column(z.number()).generated(), title: z.string() },
      });

      const db = defineModels(
        { Owner, Pet, Film },
        {
          Owner: r => ({
            pet: r.hasOne('Pet', { from: 'id', to: 'ownerId' }),
            film: r.hasOneThrough('Film', {
              from: 'id',
              through: { table: 'owner_films', from: 'ownerId', to: 'filmId' },
              to: 'id',
            }),
          }),
        },
      );

      const owner = await db.Owner.query().insertGraph({
        name: 'A',
        pet: { name: 'Rex', species: 'dog' },
        film: { title: 'Up' },
      });

      expect(Owner.modelClass.getRelation('pet')).to.be.a(Model.HasOneRelation);
      expect(Owner.modelClass.getRelation('film')).to.be.a(Model.HasOneThroughRelation);

      const fetched = await db.Owner.query().findById(owner.id).withGraphFetched('[pet, film]');
      expect(fetched.pet.name).to.be('Rex');
      expect(fetched.film.title).to.be('Up');
    });
  });

  describe('naming', () => {
    it('derives the generated class name from the table, unless `name` is given', () => {
      const derived = defineModel({ table: 'user_accounts', columns: { id: z.number() } });
      expect(derived.name).to.be('UserAccounts');
      expect(derived.modelClass.name).to.be('UserAccounts');
      expect(defineModel({ table: 'line-items 2', columns: { id: z.number() } }).name).to.be(
        'LineItems2',
      );
      expect(defineModel({ table: '_line__items', columns: { id: z.number() } }).name).to.be(
        'LineItems',
      );

      const named = defineModel({
        name: 'Account',
        table: 'user_accounts',
        columns: { id: z.number() },
      });

      expect(named.name).to.be('Account');
      expect(named.modelClass.name).to.be('Account');
    });

    it('only strips a trailing `Id` / `_id` to name a foreign key relation', () => {
      const Owner = defineModel({ table: 'owners', columns: { id: z.number() } });

      const Pet = defineModel({
        table: 'pets',
        columns: { id: z.number(), ownerIdentity: column(z.number()).references('Owner', 'id') },
      });

      expect(() => defineModels({ Owner, Pet })).to.throwError(
        /Pet\.ownerIdentity\.references\(\) needs an `as` relation name/,
      );
    });
  });

  describe('composite keys', () => {
    it('supports composite ids and composite relation keys', async () => {
      const Account = defineModel({
        table: 'accounts',
        id: ['tenant', 'id'],
        columns: { tenant: z.string(), id: z.number(), name: z.string() },
      });

      const Membership = defineModel({
        table: 'memberships',
        columns: {
          id: column(z.number()).generated(),
          tenant: z.string(),
          accountId: z.number(),
          role: z.string(),
        },
      });

      const db = defineModels({ Account, Membership }, [
        relations(Account, r => ({
          members: r.hasMany(Membership, { from: ['tenant', 'id'], to: ['tenant', 'accountId'] }),
        })),
        relations(Membership, r => ({
          account: r.belongsToOne(Account, { from: ['tenant', 'accountId'], to: ['tenant', 'id'] }),
        })),
      ]);

      await db.Account.query().insertGraph([
        { tenant: 'a', id: 1, name: 'A1', members: [{ role: 'admin' }] },
        { tenant: 'b', id: 1, name: 'B1', members: [{ role: 'viewer' }, { role: 'editor' }] },
      ]);

      const b1 = await db.Account.query().findById(['b', 1]).withGraphFetched('members');
      expect(b1.name).to.be('B1');
      expect(b1.members.map(it => it.role).sort()).to.eql(['editor', 'viewer']);
      expect(b1.members.every(it => it.tenant === 'b' && it.accountId === 1)).to.be(true);

      const [admin] = await db.Membership.query()
        .where('role', 'admin')
        .withGraphFetched('account');

      expect(admin.account.name).to.be('A1');
    });
  });

  describe('classic models in a registry', () => {
    class Film extends Model {
      static tableName = 'films';
    }

    it('get a handle with the typed query API surface', async () => {
      const Owner = defineModel({ table: 'owners', columns: ownerColumns() });
      const db = defineModels({ Owner, Film });

      expect(db.Film.modelClass).to.be(Film);
      expect(db.Film.table).to.be('films');
      expect(db.Film.name).to.be('Film');
      expect(isModelDefinition(db.Film)).to.be(true);

      const film = await db.Film.query().insert({ title: 'Up' });
      expect(film).to.be.a(Film);
      expect((await db.Film.query().findById(film.id)).title).to.be('Up');
      expect(db.Film.fromJson({ title: 'x' })).to.be.a(Film);
    });
  });

  describe('validation error paths', () => {
    it('prefix nested graph errors with the path of the model in the graph', async () => {
      const Owner = defineModel({ table: 'owners', columns: ownerColumns() });

      const Pet = defineModel({
        table: 'pets',
        columns: {
          id: column(z.number()).generated(),
          name: z.string().min(2),
          species: z.string(),
          ownerId: column(z.number()).references('Owner', 'id', { inverse: 'pets' }),
        },
      });

      const db = defineModels({ Owner, Pet });

      try {
        await db.Owner.query().insertGraph({
          name: 'A',
          pets: [
            { name: 'ok', species: 'dog' },
            { name: 'x', species: 'cat' },
          ],
        });
        expect().fail('should have thrown');
      }
      catch (err) {
        expect(err).to.be.a(ValidationError);
        expect(Object.keys(err.data)).to.eql(['pets[1].name']);
      }
    });

    it('unwrap path segments that are objects (valibot) into dotted keys', () => {
      const Owner = defineModel({
        table: 'owners',
        columns: {
          id: column(v.number()).generated(),
          name: v.string(),
          address: column(
            v.object({ city: v.string(), geo: v.object({ lat: v.number() }) }),
          ).json(),
        },
      });

      try {
        Owner.validate({ name: 'A', address: { city: 1, geo: { lat: 'x' } } });
        expect().fail('should have thrown');
      }
      catch (err) {
        expect(Object.keys(err.data).sort()).to.eql(['address.city', 'address.geo.lat']);
        expect(err.data['address.city'][0].params.issue.message).to.be.a('string');
      }
    });
  });

  describe('function schemas', () => {
    it('accepts Standard Schemas that are functions (like arktype types)', () => {
      const positive = Object.assign(value => value, {
        '~standard': {
          version: 1,
          vendor: 'fn',
          validate: value =>
            typeof value === 'number' && value > 0
              ? { value }
              : { issues: [{ message: 'must be positive' }] },
        },
      });

      const Thing = defineModel({
        table: 'things',
        columns: { id: z.number(), size: positive, other: column(positive) },
      });

      expect(Thing.validate({ id: 1, size: 2, other: 3 })).to.eql({ id: 1, size: 2, other: 3 });
      expect(() => Thing.validate({ id: 1, size: -1, other: 3 })).to.throwError(
        /size: must be positive/,
      );
    });
  });

  describe('argument validation', () => {
    const Owner = () => defineModel({ table: 'owners', columns: ownerColumns() });

    const cases = [
      [
        'column() without a schema',
        () => column({}),
        /column\(\) expects a Standard Schema compliant schema/,
      ],
      ['column() with null', () => column(null), /column\(\) expects a Standard Schema/],
      [
        'a schema whose ~standard is null',
        () => column({ '~standard': null }),
        /column\(\) expects a Standard Schema/,
      ],
      [
        'a schema without a validate function',
        () => column({ '~standard': { validate: 1 } }),
        /column\(\) expects a Standard Schema/,
      ],
      [
        'references() without a column',
        () => column(z.number()).references('Owner'),
        /expects a model name and a column name/,
      ],
      [
        'references() with a non-string model',
        () => column(z.number()).references(1, 'id'),
        /expects a model name and a column name/,
      ],
      [
        'defineModelNames() without names',
        () => defineModelNames(),
        /expects one or more model names/,
      ],
      [
        'defineModelNames() with a non-string',
        () => defineModelNames('A', 1),
        /expects one or more model names/,
      ],
      [
        'defineModel() with non-object columns',
        () => defineModel({ table: 'x', columns: 'id' }),
        /`columns` must be an object/,
      ],
      [
        'defineModel() with an undefined column',
        () => defineModel({ table: 'x', columns: { id: undefined } }),
        /column "id" must be a Standard Schema/,
      ],
      [
        'defineModel() without columns',
        () => defineModel({ table: 'x' }),
        /`columns` must be an object/,
      ],
      [
        'defineModel() with a null column',
        () => defineModel({ table: 'x', columns: { id: null } }),
        /column "id" must be a Standard Schema/,
      ],
      [
        'relations() for a non-definition',
        () => relations({}, () => ({})),
        /expects a defineModel\(\) definition as its first argument/,
      ],
      [
        'relations() without a function',
        () => relations(Owner(), {}),
        /expects a function as its second argument/,
      ],
      [
        'defineModels() with a non-model',
        () => defineModels({ X: {} }),
        /"X" is neither a defineModel\(\) definition nor a Model class/,
      ],
      [
        'defineModels() with a null model',
        () => defineModels({ X: null }),
        /"X" is neither a defineModel\(\) definition nor a Model class/,
      ],
      [
        'defineModels() with a non-declaration in the array',
        () => defineModels({ Owner: Owner() }, [{}]),
        /the declarations array may only contain relations\(\) results/,
      ],
      [
        'defineModels() with a non-object source',
        () => defineModels({ Owner: Owner() }, 'relations'),
        /expected a relations\(\) array and\/or a relations object/,
      ],
      [
        'keyed relations for an unknown model',
        () => defineModels({ Owner: Owner() }, { Ownr: () => ({}) }),
        /relations given for unknown model "Ownr"/,
      ],
      [
        'a keyed relation to an unknown model',
        () => {
          const db = defineModels(
            { Owner: Owner() },
            { Owner: r => ({ x: r.hasMany('Ownr', { from: 'id', to: 'id' }) }) },
          );

          db.Owner.modelClass.getRelations();
        },
        /relation of "Owner" points to unknown model "Ownr"/,
      ],
    ];

    for (const [label, fn, pattern] of cases) {
      it(`rejects ${label}`, () => expect(fn).to.throwError(pattern));
    }

    it('accepts an explicitly undefined relations source', () => {
      const db = defineModels({ Owner: Owner() }, undefined);
      expect(Object.keys(db)).to.eql(['Owner']);
    });

    it('names the offending model in relations() errors', () => {
      const Stranger = defineModel({ name: 'Stranger', table: 'x', columns: { id: z.number() } });
      expect(() =>
        defineModels({ Owner: Owner() }, [relations(Stranger, () => ({}))]),
      ).to.throwError(/isn't part of this registry \(Stranger\)/);

      class Classic extends Model {
        static tableName = 'classic';
      }

      const own = Owner();
      expect(() =>
        defineModels({ Owner: own }, [
          relations(own, r => ({ x: r.hasMany(Classic, { from: 'id', to: 'id' }) })),
        ]),
      ).to.throwError(/points to a model that isn't part of this registry \(Classic\)/);
    });
  });

  describe('handle methods', () => {
    it('fromJson, ref, bindKnex, toQueryBuilder', async () => {
      const Owner = defineModel({ table: 'owners', columns: ownerColumns() });

      const instance = Owner.fromJson({ name: 'A' });
      expect(instance).to.be.a(Owner.modelClass);
      expect(() => Owner.fromJson({ name: '' })).to.throwError(err =>
        expect(err).to.be.a(ValidationError),
      );

      await Owner.query().insert({ name: 'A' });
      await Owner.query().insert({ name: 'B' });

      const names = await Owner.query()
        .where(Owner.ref('name'), '!=', 'A')
        .select(raw('upper(??) as up', ['name']));

      expect(names.map(it => it.up)).to.eql(['B']);

      const query = Owner.query();
      expect(toQueryBuilder(query)).to.be(query);

      const Bound = Owner.bindKnex(knex);
      expect(Bound.modelClass).not.to.be(Owner.modelClass);
      expect(await Bound.query().resultSize()).to.be(2);
    });
  });
});
