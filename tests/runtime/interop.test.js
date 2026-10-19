'use strict';

// objection APIs that applications use and that go through the generated model classes:
// instance queries, fetch variants, upserts, relating, serialization and knex's
// identifier mappers. Where objection has a rule of its own (model instances skip
// validation), the test checks a definition against an equivalent classic model.

const expect = require('expect.js');
const { Model, ValidationError, knexSnakeCaseMappers } = require('objection');
const { defineModel, defineModels, column } = require('objection-schema');
const { z } = require('zod');
const { connect } = require('./db');

describe('objection interop', () => {
  let knex;

  const makeModels = () => {
    const Person = defineModel({
      table: 'people',
      columns: {
        id: column(z.number().int()).generated(),
        firstName: z.string().trim().min(1),
        email: z.string().toLowerCase().nullable().optional(),
        meta: column(z.object({ level: z.number() }).nullable().optional()).json(),
        bossId: column(z.number().nullable().optional()).references('Person', 'id', {
          as: 'boss',
          inverse: 'reports',
        }),
      },
    });

    return defineModels({ Person });
  };

  // The same model, classic style, validated by objection's Ajv validator.
  class ClassicPerson extends Model {
    static tableName = 'people';
    static jsonAttributes = ['meta'];
    static jsonSchema = {
      type: 'object',
      required: ['firstName'],
      properties: {
        id: { type: 'integer' },
        firstName: { type: 'string', minLength: 1 },
        email: { type: ['string', 'null'] },
        meta: { type: ['object', 'null'] },
        bossId: { type: ['integer', 'null'] },
      },
    };
  }

  const createTables = knex =>
    knex.schema.createTable('people', (t) => {
      t.increments('id');
      t.string('firstName').notNullable();
      t.string('email');
      t.text('meta');
      t.integer('bossId');
    });

  let db;

  before(async () => {
    knex = await connect();
    await createTables(knex);
    db = makeModels();
    Model.knex(knex);
  });

  after(() => knex.destroy());

  beforeEach(() => knex('people').delete());

  describe('instance queries', () => {
    it('$query().patch() validates and transforms, and updates the instance', async () => {
      const person = await db.Person.query().insert({ firstName: 'Ann' });
      await person.$query().patch({ email: 'ANN@X.COM' });

      expect(person.email).to.equal('ann@x.com');
      expect((await db.Person.query().findById(person.id)).email).to.equal('ann@x.com');

      const error = await person
        .$query()
        .patch({ firstName: ' ' })
        .catch(err => err);

      expect(error).to.be.a(ValidationError);
      expect(Object.keys(error.data)).to.eql(['firstName']);
    });

    it('$query().update() writes the changed instance', async () => {
      const person = await db.Person.query().insert({ firstName: 'Ann' });
      person.firstName = 'Anna';
      await person.$query().update();

      expect((await db.Person.query().findById(person.id)).firstName).to.equal('Anna');
    });

    it('update() of plain data validates the whole row', async () => {
      const person = await db.Person.query().insert({ firstName: 'Ann' });

      const error = await db.Person.query()
        .findById(person.id)
        .update({ email: 'x@y.z' })
        .catch(err => err);

      expect(error).to.be.a(ValidationError);
      expect(Object.keys(error.data)).to.eql(['firstName']);
    });

    it('model instances skip validation on insert, as with classic models', async () => {
      const invalid = { firstName: '' };
      const results = {};

      for (const [label, modelClass] of [
        ['definition', db.Person.modelClass],
        ['classic', ClassicPerson],
      ]) {
        const instance = modelClass.fromJson(invalid, { skipValidation: true });
        const inserted = await modelClass.query().insert(instance);

        const plain = await modelClass
          .query()
          .insert(invalid)
          .catch(err => err);

        results[label] = [inserted.firstName, plain instanceof ValidationError];
      }

      expect(results.definition).to.eql(['', true]);
      expect(results.definition).to.eql(results.classic);
    });
  });

  describe('fetching variants', () => {
    it('patchAndFetchById, updateAndFetchById and throwIfNotFound', async () => {
      const person = await db.Person.query().insert({ firstName: 'Ann' });

      const patched = await db.Person.query().patchAndFetchById(person.id, { email: 'A@X.COM' });
      expect(patched).to.be.a(db.Person.modelClass);
      expect(patched.email).to.equal('a@x.com');

      const updated = await db.Person.query().updateAndFetchById(person.id, {
        firstName: ' Anna ',
      });

      expect(updated.firstName).to.equal('Anna');

      const error = await db.Person.query()
        .findById(person.id + 1000)
        .throwIfNotFound()
        .catch(err => err);

      expect(error.name).to.equal('NotFoundError');
    });

    it('onConflict().merge() upserts validated rows', async () => {
      const person = await db.Person.query().insert({ firstName: 'Ann' });
      await db.Person.query()
        .insert({ id: person.id, firstName: ' Anna ' })
        .onConflict('id')
        .merge();

      const rows = await db.Person.query();
      expect(rows.map(it => it.firstName)).to.eql(['Anna']);
    });
  });

  describe('graphs', () => {
    it('upsertGraph relates and unrelates existing rows through a references() inverse', async () => {
      const boss = await db.Person.query().insert({ firstName: 'Boss' });

      const [a, b] = [
        await db.Person.query().insert({ firstName: 'A' }),
        await db.Person.query().insert({ firstName: 'B' }),
      ];

      await db.Person.query().upsertGraph(
        { id: boss.id, reports: [{ id: a.id }, { id: b.id }] },
        { relate: true, noDelete: true },
      );
      await db.Person.query().upsertGraph(
        { id: boss.id, reports: [{ id: b.id }] },
        { unrelate: true },
      );

      const fetched = await db.Person.query().findById(boss.id).withGraphFetched('reports.boss');
      expect(fetched.reports.map(it => it.firstName)).to.eql(['B']);
      expect(fetched.reports[0].boss.id).to.equal(boss.id);
      expect((await db.Person.query().findById(a.id)).bossId).to.be(null);
    });

    it('inserting through a relation validates the related model', async () => {
      const boss = await db.Person.query().insert({ firstName: 'Boss' });

      const error = await boss
        .$relatedQuery('reports')
        .insert({ firstName: '' })
        .catch(err => err);

      expect(error).to.be.a(ValidationError);

      const report = await boss.$relatedQuery('reports').insert({ firstName: ' R ' });
      expect(report.firstName).to.equal('R');
      expect(report.bossId).to.equal(boss.id);
    });
  });

  describe('serialization', () => {
    it('toJSON gives the parsed row and $toDatabaseJson the stored one', async () => {
      const person = await db.Person.query().insert({ firstName: 'Ann', meta: { level: 2 } });
      const read = await db.Person.query().findById(person.id);

      expect(read.toJSON()).to.eql({
        id: person.id,
        firstName: 'Ann',
        email: null,
        meta: { level: 2 },
        bossId: null,
      });
      expect(JSON.parse(read.$toDatabaseJson().meta)).to.eql({ level: 2 });
      expect(read.$clone()).to.eql(read);
    });
  });

  describe('knexSnakeCaseMappers', () => {
    let snakeKnex;

    // Runs after the other tests, as it replaces their tables with snake_case ones.
    before(async () => {
      snakeKnex = await connect(knexSnakeCaseMappers());
      await createTables(snakeKnex);
    });

    after(() => snakeKnex.destroy());

    it('maps camelCase columns to snake_case in the database', async () => {
      const { Person } = makeModels();

      const boss = await Person.query(snakeKnex).insertGraph({
        firstName: ' Boss ',
        reports: [{ firstName: 'R', meta: { level: 1 } }],
      });

      // Selecting the snake_case names fails unless they are the real ones. The mappers
      // still camelCase the result.
      const rows = await snakeKnex('people').select('first_name', 'boss_id').orderBy('id');
      expect(rows.map(it => [it.firstName, it.bossId])).to.eql([
        ['Boss', null],
        ['R', boss.id],
      ]);

      const fetched = await Person.query(snakeKnex).findById(boss.id).withGraphFetched('reports');
      expect(fetched.reports[0].meta).to.eql({ level: 1 });
    });
  });
});
