'use strict';

const expect = require('expect.js');
const { Model, ValidationError, transaction, mixin } = require('objection');
const {
  defineModel,
  defineModels,
  relations,
  column,
  defineModelNames,
  unchecked,
} = require('objection-schema');
const v = require('valibot');
const { z } = require('zod');
const { connect } = require('./db');

describe('objection-schema', () => {
  let knex;

  // A classic class-based model, to prove interop in both directions.
  class Movie extends Model {
    static tableName = 'movies';
    static relationMappings = () => ({
      // Classic model pointing to a definition, through the class it generated.
      actors: {
        relation: Model.ManyToManyRelation,
        modelClass: () => db.Person.modelClass,
        join: {
          from: 'movies.id',
          through: { from: 'persons_movies.movieId', to: 'persons_movies.personId' },
          to: 'persons.id',
        },
      },
    });
  }

  const Address = z.object({ street: z.string(), city: z.string() });

  const Person = defineModel({
    table: 'persons',
    columns: {
      id: column(z.number().int()).generated(),
      firstName: z.string().trim().min(1),
      lastName: z.string(),
      age: z.number().int().nonnegative().nullable().optional(),
      address: column(Address.nullable().optional()).json(),
      parentId: z.number().int().nullable().optional(),
      status: z.enum(['active', 'inactive']).default('active'),
    },
    modifiers: {
      adults: q => q.where('age', '>=', 18),
      orderByName: q => q.orderBy('firstName'),
    },
  });

  // valibot instead of zod, to prove the API is schema library agnostic.
  const Animal = defineModel({
    name: 'Animal',
    table: 'animals',
    columns: {
      id: column(v.number()).generated(),
      name: v.pipe(v.string(), v.minLength(1)),
      species: v.picklist(['dog', 'cat', 'bird']),
      ownerId: v.nullish(v.number()),
    },
  });

  const db = defineModels(
    { Person, Animal, Movie },
    {
      Person: r => ({
        pets: r.hasMany('Animal', { from: 'id', to: 'ownerId' }),
        parent: r.belongsToOne('Person', { from: 'parentId', to: 'id' }),
        children: r.hasMany('Person', { from: 'id', to: 'parentId' }),
        movies: r.manyToMany('Movie', {
          from: 'id',
          through: { table: 'persons_movies', from: 'personId', to: 'movieId', extra: ['role'] },
          to: 'id',
        }),
      }),
      Animal: r => ({
        owner: r.belongsToOne('Person', { from: 'ownerId', to: 'id' }),
      }),
    },
  );

  before(async () => {
    knex = await connect();
    Model.knex(knex);

    await knex.schema
      .createTable('persons', (t) => {
        t.increments('id');
        t.string('firstName');
        t.string('lastName');
        t.integer('age');
        t.text('address');
        t.integer('parentId');
        t.string('status');
      })
      .createTable('animals', (t) => {
        t.increments('id');
        t.string('name');
        t.string('species');
        t.integer('ownerId');
      })
      .createTable('movies', (t) => {
        t.increments('id');
        t.string('title');
      })
      .createTable('persons_movies', (t) => {
        t.integer('personId');
        t.integer('movieId');
        t.string('role');
      });
  });

  after(() => knex.destroy());

  beforeEach(async () => {
    for (const table of ['persons', 'animals', 'movies', 'persons_movies']) {
      await knex(table).delete();
    }
  });

  describe('validation', () => {
    it('applies schema output (transforms and defaults) on insert', async () => {
      const person = await Person.query().insert({ firstName: '  Jennifer ', lastName: 'Aniston' });

      expect(person.firstName).to.equal('Jennifer');
      expect(person.status).to.equal('active');
      expect(person.id).to.be.a('number');
      expect(person).to.be.a(Person.modelClass);
    });

    it('reports missing required columns and issues as a ValidationError', async () => {
      try {
        await Person.query().insert({ firstName: '', age: -1 });
        expect().fail('should have thrown');
      }
      catch (err) {
        expect(err).to.be.a(ValidationError);
        expect(err.type).to.equal('ModelValidation');
        expect(err.statusCode).to.equal(400);
        expect(Object.keys(err.data).sort()).to.eql(['age', 'firstName', 'lastName']);
        expect(err.data.lastName[0].keyword).to.equal('required');
        expect(err.data.lastName[0].message).to.equal('is required');
        expect(err.data.lastName[0].params).to.eql({ missingProperty: 'lastName' });
        expect(err.data.firstName[0].keyword).to.equal('zod');
      }
    });

    it('reports nested issue paths like the Ajv validator', () => {
      try {
        Person.validate({ firstName: 'a', lastName: 'b', address: { street: 1 } });
        expect().fail('should have thrown');
      }
      catch (err) {
        expect(Object.keys(err.data).sort()).to.eql(['address.city', 'address.street']);
      }
    });

    it('validates only the given columns on patch', async () => {
      const { id } = await Person.query().insert({ firstName: 'A', lastName: 'B' });

      const numUpdated = await Person.query().findById(id).patch({ age: 30 });
      expect(numUpdated).to.equal(1);

      try {
        await Person.query().findById(id).patch({ age: -5 });
        expect().fail('should have thrown');
      }
      catch (err) {
        expect(Object.keys(err.data)).to.eql(['age']);
      }
    });

    it('works with valibot schemas', async () => {
      const cat = await Animal.query().insert({ name: 'Tom', species: 'cat' });
      expect(cat.id).to.be.a('number');

      try {
        await Animal.query().insert({ name: '', species: 'cow' });
        expect().fail('should have thrown');
      }
      catch (err) {
        expect(Object.keys(err.data).sort()).to.eql(['name', 'species']);
        expect(err.data.species[0].keyword).to.equal('valibot');
      }
    });

    it('validates without the database using `validate`', () => {
      expect(Person.validate({ firstName: ' x ', lastName: 'y' })).to.eql({
        firstName: 'x',
        lastName: 'y',
        status: 'active',
      });
      expect(Person.validate({ age: 3 }, { patch: true })).to.eql({ age: 3 });
    });

    it('rejects async schemas with a clear error', () => {
      const Async = defineModel({
        table: 'x',
        columns: { id: z.number(), name: z.string().refine(async () => true) },
      });

      expect(() => Async.validate({ id: 1, name: 'a' })).to.throwError(
        /"name" \(zod\) validates asynchronously\. Only synchronous Standard Schema validation is supported\./,
      );
    });

    it('`unchecked` columns carry only a type', () => {
      const Raw = defineModel({ table: 'raw', columns: { id: unchecked(), payload: unchecked() } });
      expect(unchecked()['~standard'].vendor).to.equal('objection');
      expect(Raw.validate({ payload: { anything: true } })).to.eql({ payload: { anything: true } });
    });
  });

  describe('reading', () => {
    it('parses JSON columns and supports modifiers', async () => {
      await Person.query().insert({
        firstName: 'B',
        lastName: 'X',
        age: 20,
        address: { street: 'Main', city: 'Helsinki' },
      });
      await Person.query().insert({ firstName: 'A', lastName: 'Y', age: 10 });

      const adults = await Person.query().modify(['adults', 'orderByName']);
      expect(adults).to.have.length(1);
      expect(adults[0].address).to.eql({ street: 'Main', city: 'Helsinki' });
    });
  });

  describe('relations and graphs', () => {
    async function seed() {
      return db.Person.query().insertGraph(
        {
          firstName: 'Parent',
          lastName: 'P',
          children: [
            {
              firstName: 'Child',
              lastName: 'C',
              pets: [{ name: 'Rex', species: 'dog' }],
              movies: [{ title: 'Up', role: 'Lead' }],
            },
          ],
        },
        { allowRefs: true },
      );
    }

    it('insertGraph across definition and classic models', async () => {
      const parent = await seed();
      const child = parent.children[0];

      expect(child.parentId).to.equal(parent.id);
      expect(child.pets[0].ownerId).to.equal(child.id);
      expect(child.movies[0]).to.be.a(Movie);
    });

    it('withGraphFetched with object and string expressions', async () => {
      await seed();

      const [fromObject] = await db.Person.query()
        .where('firstName', 'Child')
        .withGraphFetched({ parent: true, pets: { owner: true }, movies: true });

      const [fromString] = await db.Person.query()
        .where('firstName', 'Child')
        .withGraphFetched('[parent, pets.owner, movies]');

      for (const child of [fromObject, fromString]) {
        expect(child.parent.firstName).to.equal('Parent');
        expect(child.pets[0].owner.firstName).to.equal('Child');
        expect(child.movies[0].title).to.equal('Up');
        expect(child.movies[0].role).to.equal('Lead');
      }
    });

    it('withGraphJoined and joinRelated', async () => {
      await seed();

      const people = await db.Person.query().withGraphJoined('pets').where('pets.species', 'dog');
      expect(people.map(it => it.firstName)).to.eql(['Child']);

      const names = await db.Person.query()
        .joinRelated('pets')
        .select('persons.firstName', 'pets.name as petName');
      expect(names).to.eql(
        [{ firstName: 'Child', petName: 'Rex' }].map(it =>
          Object.assign(new Person.modelClass(), it),
        ),
      );
    });

    it('relatedQuery and instance methods keep working on results', async () => {
      const parent = await seed();

      const pets = await db.Person.relatedQuery('pets').for(parent.children[0].id);
      expect(pets.map(it => it.name)).to.eql(['Rex']);

      // Results are real model instances, so classic instance APIs are available.
      const [child] = await db.Person.query().where('firstName', 'Child');
      const [owner] = await child.$relatedQuery('pets').withGraphFetched('owner');
      expect(owner.owner.id).to.equal(child.id);
    });

    it('classic model relation pointing to a definition', async () => {
      await seed();

      const [movie] = await Movie.query().withGraphFetched('actors.pets');
      expect(movie.actors[0]).to.be.a(Person.modelClass);
      expect(movie.actors[0].pets[0].name).to.equal('Rex');
    });

    it('upsertGraph', async () => {
      const parent = await seed();
      const child = parent.children[0];

      await db.Person.query().upsertGraph({
        id: child.id,
        firstName: 'Renamed',
        pets: [
          { id: child.pets[0].id, name: 'Rex II' },
          { name: 'Tweety', species: 'bird' },
        ],
      });

      const result = await db.Person.query().findById(child.id).withGraphFetched('pets');
      expect(result.firstName).to.equal('Renamed');
      expect(result.pets.map(it => it.name).sort()).to.eql(['Rex II', 'Tweety']);
    });
  });

  describe('relation styles', () => {
    // Fresh definitions over the same tables: a definition's relations belong to
    // the registry it was last passed to.
    const makeModels = () => ({
      Owner: defineModel({
        name: 'Owner',
        table: 'persons',
        columns: {
          id: column(z.number()).generated(),
          firstName: z.string(),
          lastName: z.string(),
          parentId: z.number().nullable().optional(),
        },
      }),
      Pet: defineModel({
        name: 'Pet',
        table: 'animals',
        columns: {
          id: column(z.number()).generated(),
          name: z.string(),
          species: z.string(),
          ownerId: column(z.number().nullable()).references('Owner', 'id', { inverse: 'pets' }),
        },
      }),
    });

    async function seed(models) {
      return models.Owner.query().insertGraph({
        firstName: 'Parent',
        lastName: 'P',
        children: [{ firstName: 'Child', lastName: 'C', pets: [{ name: 'Rex', species: 'dog' }] }],
      });
    }

    it('combines references(), relations() and the keyed object', async () => {
      const { Owner, Pet } = makeModels();

      const ownerRelations = relations(Owner, r => ({
        children: r.hasMany(Owner, { from: 'id', to: 'parentId' }),
      }));

      const db = defineModels({ Owner, Pet }, [ownerRelations], {
        Owner: r => ({ parent: r.belongsToOne('Owner', { from: 'parentId', to: 'id' }) }),
      });

      expect(Object.keys(Owner.modelClass.getRelations()).sort()).to.eql([
        'children',
        'parent',
        'pets',
      ]);
      expect(Object.keys(Pet.modelClass.getRelations())).to.eql(['owner']);

      await seed(db);

      const [child] = await db.Owner.query()
        .where('firstName', 'Child')
        .withGraphFetched('[parent, pets.owner.parent]');

      expect(child.parent.firstName).to.equal('Parent');
      expect(child.pets[0].name).to.equal('Rex');
      expect(child.pets[0].owner.firstName).to.equal('Child');
      expect(child.pets[0].owner.parent.firstName).to.equal('Parent');
    });

    it('derives the forward name from the column and honors `as` and inverse kind', () => {
      const Owner = defineModel({
        table: 'persons',
        columns: { id: z.number(), parent_id: column(z.number()).references('Owner', 'id') },
      });
      const Pet = defineModel({
        table: 'animals',
        columns: {
          id: z.number(),
          ownerId: column(z.number()).references('Owner', 'id', {
            as: 'human',
            inverse: { name: 'favoritePet', kind: 'one' },
          }),
        },
      });

      defineModels({ Owner, Pet });

      const ownerRelations = Owner.modelClass.getRelations();
      expect(ownerRelations.parent).to.be.a(Model.BelongsToOneRelation);
      expect(ownerRelations.favoritePet).to.be.a(Model.HasOneRelation);
      expect(Pet.modelClass.getRelations().human).to.be.a(Model.BelongsToOneRelation);

      // An inverse given as an object without `kind` is a hasMany. (A fresh owner: objection
      // caches relations on first use, so a definition belongs to one registry.)
      const Clinic = defineModel({ table: 'clinics', columns: { id: z.number() } });
      const Vet = defineModel({
        table: 'vets',
        columns: {
          id: z.number(),
          clinicId: column(z.number()).references('Clinic', 'id', { inverse: { name: 'vets' } }),
        },
      });
      defineModels({ Clinic, Vet });
      expect(Clinic.modelClass.getRelations().vets).to.be.a(Model.HasManyRelation);
    });

    it('relations() declarations can target classic models', async () => {
      const { Owner, Pet } = makeModels();
      const ownerRelations = relations(Owner, r => ({
        movies: r.manyToMany(Movie, {
          from: 'id',
          through: { table: 'persons_movies', from: 'personId', to: 'movieId' },
          to: 'id',
        }),
      }));

      const db = defineModels({ Owner, Pet, Movie }, [ownerRelations]);
      const owner = await db.Owner.query().insertGraph({
        firstName: 'A',
        lastName: 'B',
        movies: [{ title: 'Up' }],
      });

      const [fetched] = await db.Owner.query().findByIds([owner.id]).withGraphFetched('movies');
      expect(fetched.movies[0]).to.be.a(Movie);
    });

    it('defineModelNames() checks reference targets when the column is created', async () => {
      const { column: col, names } = defineModelNames('Owner', 'Pet');
      expect(names).to.eql(['Owner', 'Pet']);

      expect(() => col(z.number()).generated().references('Ownr', 'id')).to.throwError(
        /unknown model "Ownr". Expected one of: Owner, Pet/,
      );

      const Owner = defineModel({
        table: 'persons',
        columns: { id: col(z.number()).generated(), firstName: z.string(), lastName: z.string() },
      });
      const Pet = defineModel({
        table: 'animals',
        columns: {
          id: col(z.number()).generated(),
          name: z.string(),
          species: z.string(),
          ownerId: col(z.number()).references('Owner', 'id', { inverse: 'pets' }),
        },
      });

      const db = defineModels({ Owner, Pet });
      await db.Owner.query().insertGraph({
        firstName: 'A',
        lastName: 'B',
        pets: [{ name: 'Rex', species: 'dog' }],
      });

      const [pet] = await db.Pet.query().withGraphFetched('owner.pets');
      expect(pet.owner.pets[0].name).to.equal('Rex');
    });

    describe('errors', () => {
      const throws = (fn, pattern) => expect(fn).to.throwError(pattern);

      it('same relation name from two sources', () => {
        const { Owner, Pet } = makeModels();
        const ownerRelations = relations(Owner, r => ({
          pets: r.hasMany(Pet, { from: 'id', to: 'ownerId' }),
        }));

        throws(
          () => defineModels({ Owner, Pet }, [ownerRelations]),
          /relation "Owner.pets" is defined more than once: Pet.ownerId.references\(\) inverse and relations\(Owner\)/,
        );
      });

      it('same relation name in relations() and the keyed object', () => {
        const { Owner, Pet } = makeModels();
        const ownerRelations = relations(Owner, r => ({
          parent: r.belongsToOne(Owner, { from: 'parentId', to: 'id' }),
        }));

        throws(
          () =>
            defineModels({ Owner, Pet }, [ownerRelations], {
              Owner: r => ({ parent: r.belongsToOne('Owner', { from: 'parentId', to: 'id' }) }),
            }),
          /relation "Owner.parent" is defined more than once: relations\(Owner\) and defineModels relations for Owner/,
        );
      });

      it('relation named like a column', () => {
        const { Owner, Pet } = makeModels();
        throws(
          () =>
            defineModels(
              { Owner, Pet },
              {
                Owner: r => ({ firstName: r.hasMany('Pet', { from: 'id', to: 'ownerId' }) }),
              },
            ),
          /relation "Owner.firstName" .* same name as a column/,
        );
      });

      it('invalid references()', () => {
        const columns = ref => ({ id: z.number(), ownerId: ref });
        const Owner = defineModel({ table: 'persons', columns: { id: z.number() } });

        const unknownModel = defineModel({
          table: 'animals',
          columns: columns(column(z.number()).references('Ownr', 'id')),
        });
        throws(() => defineModels({ Owner, Pet: unknownModel }), /points to unknown model "Ownr"/);

        const unknownColumn = defineModel({
          table: 'animals',
          columns: columns(column(z.number()).references('Owner', 'uuid')),
        });
        throws(() => defineModels({ Owner, Pet: unknownColumn }), /unknown column "Owner.uuid"/);

        const noName = defineModel({
          table: 'animals',
          columns: { id: z.number(), owner: column(z.number()).references('Owner', 'id') },
        });
        throws(() => defineModels({ Owner, Pet: noName }), /needs an `as` relation name/);

        const inverseOnClassic = defineModel({
          table: 'persons_movies',
          columns: columns(column(z.number()).references('Movie', 'id', { inverse: 'links' })),
        });
        throws(
          () => defineModels({ Movie, Link: inverseOnClassic }),
          /"Movie" is a classic model class/,
        );
      });

      it('relations() for models outside the registry', () => {
        const { Owner, Pet } = makeModels();
        const Stranger = defineModel({ table: 'x', columns: { id: z.number() } });

        throws(
          () => defineModels({ Owner, Pet }, [relations(Stranger, () => ({}))]),
          /isn't part of this registry/,
        );
        throws(
          () =>
            defineModels({ Owner, Pet }, [
              relations(Owner, r => ({ x: r.hasMany(Stranger, { from: 'id', to: 'id' }) })),
            ]),
          /points to a model that isn't part of this registry/,
        );
      });

      it('a definition in a second registry, or twice in one', () => {
        const { Owner, Pet } = makeModels();
        const first = defineModels(
          { Owner, Pet },
          { Owner: r => ({ parent: r.belongsToOne('Owner', { from: 'parentId', to: 'id' }) }) },
        );

        // It would replace the first registry's relations, which live on the model class.
        throws(
          () => defineModels({ Owner }),
          /"Owner" \(Owner\) is already part of another registry/,
        );
        throws(() => defineModels({ Boss: Owner }), /"Boss" \(Owner\) is already part of/);
        expect(Object.keys(first.Owner.modelClass.getRelations()).sort()).to.eql([
          'parent',
          'pets',
        ]);

        const Fresh = makeModels().Owner;
        throws(
          () => defineModels({ Owner: Fresh, Boss: Fresh }),
          /"Boss" is the same definition as "Owner"/,
        );
        // Classic models aren't changed by a registry, so they can be in several.
        expect(() => defineModels({ Movie })).not.to.throwError();
      });

      it('a registry that failed leaves its definitions free for the next one', () => {
        const { Owner, Pet } = makeModels();
        throws(() => defineModels({ Owner, Pet }, { Nope: () => ({}) }), /unknown model "Nope"/);

        const db = defineModels({ Owner, Pet });
        expect(db.Owner).to.be(Owner);
      });
    });
  });

  describe('interop', () => {
    it('transactions', async () => {
      try {
        await transaction(knex, async (trx) => {
          await db.Person.query(trx).insert({ firstName: 'T', lastName: 'X' });
          throw new Error('rollback');
        });
      }
      catch (err) {
        expect(err.message).to.equal('rollback');
      }

      expect(await db.Person.query().resultSize()).to.equal(0);
    });

    it('bindKnex', async () => {
      const Bound = db.Person.bindKnex(knex);
      await Bound.query().insert({ firstName: 'B', lastName: 'K' });
      expect(await Bound.query().resultSize()).to.equal(1);
    });

    it('plugins via a custom base model', async () => {
      const timestamps = Base =>
        class extends Base {
          $beforeInsert(ctx) {
            this.lastName = `${this.lastName} (stamped)`;
            return super.$beforeInsert(ctx);
          }
        };

      const Stamped = defineModel({
        table: 'persons',
        base: mixin(Model, [timestamps]),
        columns: {
          id: column(z.number()).generated(),
          firstName: z.string(),
          lastName: z.string(),
        },
      });

      const it = await Stamped.query().insert({ firstName: 'P', lastName: 'L' });
      expect(it.lastName).to.equal('L (stamped)');
    });

    it('function hooks', async () => {
      const calls = [];
      const Hooked = defineModel({
        table: 'animals',
        columns: { id: column(z.number()).generated(), name: z.string(), species: z.string() },
        hooks: {
          beforeInsert(row) {
            calls.push(['beforeInsert', row.name]);
          },
          afterFind(row) {
            calls.push(['afterFind', row.name]);
          },
        },
      });

      await Hooked.query().insert({ name: 'H', species: 'cat' });
      await Hooked.query();
      expect(calls).to.eql([
        ['beforeInsert', 'H'],
        ['afterFind', 'H'],
      ]);
    });
  });
});
