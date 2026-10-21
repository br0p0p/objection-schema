'use strict';

// Features beyond the main walkthrough in defineModel.test.js: every hook, model and
// relation options, composite keys, classic model handles, error paths and handle methods.

const expect = require('expect.js');
const { Model, ValidationError, raw, ref, snakeCaseMappers } = require('objection');

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
const { client, connect } = require('./db');

function only(...clients) {
  return (title, fn) =>
    it(`${title} (${clients.join(', ')})`, function () {
      if (!clients.includes(client))
        this.skip();

      return fn.call(this);
    });
}

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
      })
      .createTable('crew', (t) => {
        t.increments('crew_id');
        t.string('full_name');
        t.string('nick');
        t.integer('login_count').notNullable().defaultTo(0);
      })
      .createTable('tenant_accounts', (t) => {
        t.string('tenant_code');
        t.integer('account_no');
        t.string('display_name');
        t.primary(['tenant_code', 'account_no']);
      });
  });

  after(() => knex.destroy());

  beforeEach(async () => {
    const tables = ['owners', 'pets', 'accounts', 'memberships', 'films', 'owner_films', 'crew', 'tenant_accounts'];

    for (const table of tables) {
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
    it('defines own statics over getter-only classic properties', async () => {
      class Base extends Model {
        static get tableName() { return 'unused'; }
        static get idColumn() { return 'unused'; }
        static get jsonAttributes() { return ['unused']; }
        static get modifiers() { return { unused: () => {} }; }
        static get createValidator() { throw new Error('base validator must not be read'); }
      }

      const Owner = defineModel({
        base: Base,
        table: 'owners',
        columns: ownerColumns(),
        modifiers: { named: q => q.where('name', 'A') },
      });

      const owner = await Owner.query().insert({ name: 'A' });
      expect((await Owner.query().modify('named')).map(it => it.id)).to.eql([owner.id]);
      expect(Owner.modelClass.idColumn).to.equal('id');
      expect(Owner.modelClass.jsonAttributes).to.eql([]);
      expect(() => Owner.validate({ name: '' })).to.throwError(err => expect(err).to.be.a(ValidationError));
      expect(Base.tableName).to.equal('unused');
      expect(Base.idColumn).to.equal('unused');
      expect(Base.jsonAttributes).to.eql(['unused']);
      expect(Object.keys(Base.modifiers)).to.eql(['unused']);
    });

    it('the class keeps the base\'s statics and members, as typed (tests/types/typed.ts)', async () => {
      class AppModel extends Model {
        static deleteType = 'soft';
        static softDelete() { return 'deleted'; }
        fetchExtra() { return `extra ${this.name}`; }
      }

      const seen = [];

      const Owner = defineModel({
        base: AppModel,
        table: 'owners',
        columns: ownerColumns(),
        hooks: { beforeInsert(row) { seen.push(row.fetchExtra()); } },
      });

      const db = defineModels({ Owner });

      for (const modelClass of [Owner.modelClass, db.Owner.modelClass, Owner.bindKnex(knex).modelClass]) {
        expect(modelClass.deleteType).to.be('soft');
        expect(modelClass.softDelete()).to.be('deleted');
        expect(modelClass.fromJson({ name: 'A' }).fetchExtra()).to.be('extra A');
      }

      await Owner.modelClass.query().insert({ name: 'B' });
      expect(seen).to.eql(['extra B']);
      const [owner] = await Owner.modelClass.query();
      expect(owner).to.be.an(AppModel);
      expect(owner.fetchExtra()).to.be('extra B');
    });

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

  describe('column names', () => {
    const crewColumns = () => ({
      crewId: column(z.number()).generated(),
      fullName: z.string(),
      // `.name()` overrides the casing rule (snake_case would be `nickname`).
      nickname: column(z.string().nullable().optional()).name('nick'),
      loginCount: column(z.number()).hasDefault(),
    });

    const Crew = () =>
      defineModel({ table: 'crew', id: 'crewId', columnNames: 'snake_case', columns: crewColumns() });

    // The SQL of a query, with identifiers unquoted so the assertions work on every database.
    const sql = query => toQueryBuilder(query).toKnexQuery().toQuery().replace(/[`"]/g, '');

    it('maps properties to snake_case columns, and `.name()` overrides the casing', async () => {
      const crew = Crew();

      const ann = await crew.query().insert({ fullName: 'Ann', nickname: 'A' });
      expect(ann.toJSON()).to.eql({ fullName: 'Ann', nickname: 'A', crewId: ann.crewId });
      expect(await knex('crew').select('crew_id', 'full_name', 'nick', 'login_count')).to.eql([
        { crew_id: ann.crewId, full_name: 'Ann', nick: 'A', login_count: 0 },
      ]);

      const read = await crew.query().findById(ann.crewId);
      expect(read.toJSON()).to.eql({ crewId: ann.crewId, fullName: 'Ann', nickname: 'A', loginCount: 0 });

      expect(await crew.query().patch({ nickname: 'Annie' }).findById(ann.crewId)).to.be(1);
      await crew.query().findById(ann.crewId).increment('loginCount', 2);
      expect((await crew.query().findById(ann.crewId)).toJSON()).to.eql({
        crewId: ann.crewId,
        fullName: 'Ann',
        nickname: 'Annie',
        loginCount: 2,
      });

      expect(crew.idColumn).to.be('crewId');
      expect(crew.modelClass.idColumn).to.be('crew_id');
      expect(crew.modelClass.propertyNameToColumnName('loginCount')).to.be('login_count');
      expect(crew.modelClass.columnNameToPropertyName('nick')).to.be('nickname');

      const bound = crew.bindKnex(knex);
      expect((await bound.query().where('fullName', 'Ann')).map(it => it.nickname)).to.eql(['Annie']);
      expect(sql(bound.query().where('fullName', 'Ann'))).to.contain('full_name');
    });

    it('maps composite ids', async () => {
      const Account = defineModel({
        table: 'tenant_accounts',
        id: ['tenantCode', 'accountNo'],
        columnNames: 'snake_case',
        columns: { tenantCode: z.string(), accountNo: z.number(), displayName: z.string() },
      });

      await Account.query().insert({ tenantCode: 'a', accountNo: 1, displayName: 'A1' });
      await Account.query().insert({ tenantCode: 'b', accountNo: 1, displayName: 'B1' });

      expect(Account.idColumn).to.eql(['tenantCode', 'accountNo']);
      expect(Account.modelClass.idColumn).to.eql(['tenant_code', 'account_no']);
      expect((await Account.query().findById(['b', 1])).displayName).to.be('B1');
      expect((await Account.query().findByIds([['a', 1]])).map(it => it.displayName)).to.eql(['A1']);
      expect(await Account.query().patch({ displayName: 'B2' }).findById(['b', 1])).to.be(1);
      expect((await Account.query().findById(['b', 1])).displayName).to.be('B2');
      expect(await Account.query().deleteById(['a', 1])).to.be(1);
      expect(await knex('tenant_accounts').select('display_name')).to.eql([{ display_name: 'B2' }]);
    });

    it('maps property names in the typed query methods', () => {
      const crew = Crew();
      const q = () => crew.query();

      const cases = [
        q().where('fullName', 'a'),
        q().where('fullName', '=', 'a'),
        q().where({ fullName: 'a' }),
        q().andWhere('fullName', 'a'),
        q().orWhere('fullName', 'a'),
        q().whereNot('fullName', 'a'),
        q().orWhereNot('fullName', 'a'),
        q().whereIn('fullName', ['a']),
        q().orWhereIn('fullName', ['a']),
        q().whereNotIn('fullName', ['a']),
        q().orWhereNotIn('fullName', ['a']),
        q().whereNull('fullName'),
        q().orWhereNull('fullName'),
        q().whereNotNull('fullName'),
        q().orWhereNotNull('fullName'),
        q().whereBetween('fullName', ['a', 'b']),
        q().whereNotBetween('fullName', ['a', 'b']),
        q().orderBy('fullName', 'desc'),
        q().groupBy('crewId', 'fullName'),
        q().select('crewId', 'fullName'),
        q().findOne({ fullName: 'a' }),
        q().where('crew.fullName', 'a'),
        q().select('crew.fullName'),
        toQueryBuilder(q()).whereIn(['crewId', 'fullName'], [[1, 'a']]),
        toQueryBuilder(q()).alias('c').where('c.fullName', 'a'),
        q().where(crew.ref('fullName'), 'a'),
      ];

      for (const query of cases) {
        expect(sql(query)).to.contain('full_name');
        expect(sql(query)).not.to.contain('fullName');
      }

      expect(sql(q().groupBy('crewId', 'fullName'))).to.contain('crew_id, full_name');
      expect(sql(q().where({ fullName: 'a', crewId: 1 }))).to.contain('full_name = \'a\' and crew_id = 1');
      expect(sql(q().where('crew.fullName', 'a'))).to.contain('crew.full_name');
      expect(sql(q().where(crew.ref('fullName'), 'a'))).to.contain('crew.full_name');
      expect(sql(q().select('fullName as name', 'nickname AS short'))).to.contain(
        'select full_name as name, nick as short from',
      );
      expect(sql(q().select('crew.fullName'))).to.contain('select crew.full_name from');
    });

    it('maps property names inside where callbacks', function () {
      const crew = Crew();
      let isObjectionBuilder = false;

      sql(crew.query().where((query) => {
        isObjectionBuilder = query.isObjectionQueryBuilderBase === true;
      }));

      // objection 3.0.x doesn't recognize knex 3's builders, and passes them to the callback.
      if (!isObjectionBuilder)
        this.skip();

      expect(sql(crew.query().where(query => query.where('fullName', 'fullName')))).to.contain(
        'where (full_name = \'fullName\')',
      );
      expect(sql(crew.query().where('crewId', 1).orWhere(query => query.whereNull('nickname')))).to.contain(
        'or (nick is null)',
      );
    });

    only('sqlite', 'pg')('maps returning()', () => {
      const crew = Crew();
      expect(sql(crew.query().insert({ fullName: 'a' }).returning('crewId', 'fullName'))).to.contain(
        'returning crew_id, full_name',
      );
    });

    it('leaves values, raw(), ref(), unknown names and subqueries alone', () => {
      const crew = Crew();
      const q = () => crew.query();

      expect(sql(q().where('fullName', 'fullName'))).to.contain('full_name = \'fullName\'');
      expect(sql(q().where('fullName', '=', 'fullName'))).to.contain('full_name = \'fullName\'');
      expect(sql(q().where('full_name', 'a'))).to.contain('where full_name = \'a\'');
      expect(sql(q().where('other.fullName', 'a'))).to.contain('where other.fullName = \'a\'');
      expect(sql(q().where(ref('fullName'), 'a'))).to.contain('where fullName = \'a\'');
      expect(sql(q().where(raw('??', ['fullName']), 'a'))).to.contain('where fullName = \'a\'');
      expect(sql(q().select('*'))).to.contain('select * from');
      expect(sql(q().select('crew.*'))).to.contain('select crew.* from');
      expect(sql(toQueryBuilder(q()).select({ fullName: 'nick' }))).to.contain('select nick as fullName from');
      expect(() => toQueryBuilder(q()).where(null)).not.to.throwError();
      expect(() => toQueryBuilder(q()).where(undefined)).to.throwError(
        /undefined passed as argument #0 for 'where' operation/,
      );
      expect(sql(q().whereIn('crewId', q().select('crewId')))).to.contain(
        'crew_id in (select crew_id from crew)',
      );
    });

    it('extends the base\'s query builder', () => {
      class CustomQueryBuilder extends Model.QueryBuilder {
        tagged() {
          return this.where('fullName', 'tagged');
        }
      }

      class Base extends Model {
        static QueryBuilder = CustomQueryBuilder;
      }

      const crew = defineModel({
        table: 'crew',
        base: Base,
        id: 'crewId',
        columnNames: 'snake_case',
        columns: crewColumns(),
      });

      expect(crew.query()).to.be.a(CustomQueryBuilder);
      expect(sql(crew.query().tagged())).to.contain('full_name = \'tagged\'');
      expect(Base.QueryBuilder).to.be(CustomQueryBuilder);
    });

    it('sets no mappers up when no column is renamed', () => {
      const same = defineModel({
        table: 'owners',
        columnNames: 'snake_case',
        columns: { id: column(z.number()).name('id'), name: z.string(), first_name: z.string() },
      });

      expect(Object.hasOwn(same.modelClass, 'columnNameMappers')).to.be(false);
      expect(same.modelClass.getColumnNameMappers()).to.be(null);
      expect(same.modelClass.idColumn).to.be('id');

      const plain = defineModel({ table: 'owners', columns: ownerColumns() });
      expect(Object.hasOwn(plain.modelClass, 'columnNameMappers')).to.be(false);
    });

    it('defines the mappers like a static class field', () => {
      const descriptor = Object.getOwnPropertyDescriptor(Crew().modelClass, 'columnNameMappers');
      expect([descriptor.configurable, descriptor.enumerable, descriptor.writable]).to.eql([
        true,
        true,
        true,
      ]);
    });

    it('keeps a base\'s own mappers when the definition renames nothing', () => {
      const mappers = snakeCaseMappers();

      class Snake extends Model {
        static columnNameMappers = mappers;
      }

      const def = defineModel({ table: 'owners', base: Snake, columns: ownerColumns() });
      expect(def.modelClass.columnNameMappers).to.be(mappers);
      expect(Object.hasOwn(def.modelClass, 'columnNameMappers')).to.be(false);
    });

    it('passes the keys it doesn\'t know through when converting rows', () => {
      const { modelClass } = Crew();

      expect(
        modelClass.fromDatabaseJson({ full_name: 'a', nick: 'b', extra_col: 1, fullName_x: 2 }).toJSON(),
      ).to.eql({ fullName: 'a', nickname: 'b', extra_col: 1, fullName_x: 2 });
      expect(modelClass.fromJson({ fullName: 'a', nickname: null, other: 1 }).$toDatabaseJson()).to.eql({
        full_name: 'a',
        nick: null,
        other: 1,
      });
    });

    const errors = [
      [
        'a non-string column name',
        () => column(z.string()).name(1),
        /^name\(\): expects a column name \(a non-empty string\), got 1$/,
      ],
      [
        'an empty column name',
        () => column(z.string()).name(''),
        /^name\(\): expects a column name \(a non-empty string\), got ""$/,
      ],
      [
        'an unknown casing',
        () => defineModel({ table: 'x', columnNames: 'camelCase', columns: { id: z.number() } }),
        /^defineModel\(X\): `columnNames` must be "snake_case", got "camelCase"$/,
      ],
      [
        'two columns with the same column name',
        () =>
          defineModel({
            table: 'x',
            columnNames: 'snake_case',
            columns: { id: z.number(), firstName: z.string(), first_name: z.string() },
          }),
        /^defineModel\(X\): columns "firstName" and "first_name" both map to column "first_name"$/,
      ],
      [
        'two columns given the same name with .name()',
        () =>
          defineModel({
            table: 'x',
            columns: {
              id: z.number(),
              a: column(z.string()).name('c'),
              b: column(z.string()).name('c'),
            },
          }),
        /^defineModel\(X\): columns "a" and "b" both map to column "c"$/,
      ],
      [
        'a column named like another property',
        () =>
          defineModel({
            table: 'x',
            columns: {
              id: z.number(),
              a: column(z.string()).name('b'),
              b: column(z.string()).name('a'),
            },
          }),
        /^defineModel\(X\): column "a" maps to "b", the name of another column in `columns`$/,
      ],
      [
        'a base with its own columnNameMappers and `columnNames`',
        () => {
          class Snake extends Model {
            static columnNameMappers = snakeCaseMappers();
          }

          defineModel({
            table: 'x',
            base: Snake,
            columnNames: 'snake_case',
            columns: { id: z.number() },
          });
        },
        /^defineModel\(X\): `base` has its own `columnNameMappers`, which can't be combined with `columnNames` or `\.name\(\)`$/,
      ],
      [
        'a base with its own columnNameMappers and .name()',
        () => {
          class Snake extends Model {
            static get columnNameMappers() {
              return snakeCaseMappers();
            }
          }

          defineModel({
            table: 'x',
            base: Snake,
            columns: { id: z.number(), name: column(z.string()).name('label') },
          });
        },
        /^defineModel\(X\): `base` has its own `columnNameMappers`/,
      ],
    ];

    for (const [label, fn, pattern] of errors) {
      it(`rejects ${label}`, () => expect(fn).to.throwError(pattern));
    }

    describe('relations of joined models', () => {
      const models = (base = Model) => {
        const crew = defineModel({
          table: 'crew',
          id: 'crewId',
          columnNames: 'snake_case',
          columns: {
            ...crewColumns(),
            ownerId: column(z.number().nullable().optional())
              .name('owner_ref')
              .references('Owner', 'id', { inverse: 'crew' }),
          },
        });

        const owner = defineModel({ table: 'owners', base, columns: ownerColumns() });

        return { crew, owner };
      };

      it('maps joined names once the registry is set up, without reading relations earlier', () => {
        const { crew, owner } = models();

        // Before defineModels the relations don't exist yet: the reference passes through,
        // and objection doesn't cache an empty set of relations.
        expect(sql(owner.query().where('crew.fullName', 'x'))).to.contain('where crew.fullName = \'x\'');

        const db = defineModels({ Crew: crew, Owner: owner });
        // A bound class asks the definition it's bound from.
        const bound = db.Owner.bindKnex(knex);

        expect(db.Owner.modelClass.getRelationNames()).to.eql(['crew']);
        expect(sql(db.Owner.query().joinRelated('crew').where('crew.fullName', 'x'))).to.contain(
          'inner join crew on crew.owner_ref = owners.id where crew.full_name = \'x\'',
        );
        expect(sql(bound.query().joinRelated('crew').where('crew.fullName', 'x'))).to.contain(
          'where crew.full_name = \'x\'',
        );
        expect(sql(db.Crew.query().joinRelated('owner.crew').where('owner:crew.fullName', 'x'))).to.contain(
          'where owner:crew.full_name = \'x\'',
        );
      });

      it('doesn\'t read the relations of a base before the registry replaces them', () => {
        class Base extends Model {
          static relationMappings = () => ({
            legacy: {
              relation: Model.HasManyRelation,
              modelClass: Base,
              join: { from: 'owners.id', to: 'owners.id' },
            },
          });
        }

        const { crew, owner } = models(Base);

        expect(sql(owner.query().where('crew.fullName', 'x'))).to.contain('where crew.fullName = \'x\'');
        expect(sql(owner.query().where('legacy.fullName', 'x'))).to.contain('where legacy.fullName = \'x\'');

        const db = defineModels({ Crew: crew, Owner: owner });
        expect(db.Owner.modelClass.getRelationNames()).to.eql(['crew']);
        expect(sql(db.Owner.query().joinRelated('crew').where('crew.fullName', 'x'))).to.contain(
          'where crew.full_name = \'x\'',
        );
      });
    });

    it('returns a new column from .name()', () => {
      const plain = column(z.string());
      const named = plain.name('x');

      expect(named).not.to.be(plain);
      expect(named['~column'].name).to.be('x');
      expect(plain['~column'].name).to.be(null);
      expect(named.json()['~column']).to.eql({
        generated: false,
        hasDefault: false,
        json: true,
        references: null,
        name: 'x',
      });
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

    describe('bindKnex gives each definition its own bound class', () => {
      it('two definitions of the same table', async () => {
        const Owner1 = defineModel({ table: 'owners', columns: ownerColumns() });

        const Owner2 = defineModel({
          table: 'owners',
          columns: { ...ownerColumns(), name: z.string().min(5) },
        });

        const Bound1 = Owner1.bindKnex(knex);
        const Bound2 = Owner2.bindKnex(knex);

        expect(Bound2.modelClass).not.to.be(Bound1.modelClass);
        expect(Object.getPrototypeOf(Bound1.modelClass)).to.be(Owner1.modelClass);
        expect(Object.getPrototypeOf(Bound2.modelClass)).to.be(Owner2.modelClass);

        await Bound1.query().insert({ name: 'ab' });
        let error;
        await Bound2.query().insert({ name: 'ab' }).catch((err) => {
          error = err;
        });
        expect(error).to.be.a(ValidationError);
        expect(await Bound1.query().resultSize()).to.be(1);
      });

      it('relations of two registries over the same tables', () => {
        const makeRegistry = () => {
          const Owner = defineModel({ table: 'owners', columns: ownerColumns() });

          const Pet = defineModel({
            table: 'pets',
            columns: {
              id: column(z.number()).generated(),
              name: z.string(),
              ownerId: z.number(),
            },
          });

          return defineModels({ Owner, Pet }, [
            relations(Owner, r => ({ pets: r.hasMany(Pet, { from: 'id', to: 'ownerId' }) })),
          ]);
        };

        const db1 = makeRegistry();
        const db2 = makeRegistry();

        const Bound1 = db1.Owner.bindKnex(knex).modelClass;
        const Bound2 = db2.Owner.bindKnex(knex).modelClass;

        expect(Bound2).not.to.be(Bound1);
        const related1 = Bound1.getRelation('pets').relatedModelClass;
        const related2 = Bound2.getRelation('pets').relatedModelClass;
        expect(Object.getPrototypeOf(related1)).to.be(db1.Pet.modelClass);
        expect(Object.getPrototypeOf(related2)).to.be(db2.Pet.modelClass);
      });

      it('a subclass of a generated class', () => {
        const Owner = defineModel({ table: 'owners', columns: ownerColumns() });

        class SubOwner extends Owner.modelClass {}

        const Bound = Owner.modelClass.bindKnex(knex);
        const BoundSub = SubOwner.bindKnex(knex);

        expect(BoundSub).not.to.be(Bound);
        expect(Object.getPrototypeOf(BoundSub)).to.be(SubOwner);
        expect(SubOwner.uniqueTag()).not.to.be(Owner.modelClass.uniqueTag());
      });

      it('keeps objection\'s tag, and caches the bound class', () => {
        const Owner = defineModel({ table: 'owners', columns: ownerColumns() });

        // The format isn't API, but objection's own tag stays in it.
        expect(Owner.modelClass.uniqueTag().startsWith('owners_Owners_')).to.be(true);

        const Bound = Owner.bindKnex(knex).modelClass;
        expect(Owner.bindKnex(knex).modelClass).to.be(Bound);
        expect(Bound.bindKnex(knex)).to.be(Bound);
      });
    });
  });
});
