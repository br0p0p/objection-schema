'use strict';

// Column types of real applications (bigint ids, decimals, JSON, timestamps, arrays) and
// what each database returns for them. Runs against the database picked with `DB` (see
// db.js); the parts that only apply to some databases skip themselves on the others.

const expect = require('expect.js');
const { Model, ValidationError, snakeCaseMappers } = require('objection');
const { defineModel, defineModels, column, relations } = require('objection-schema');
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

// The setup the README recommends for Postgres: `bigint` (int8) as a JS number, on the
// connection, so that it doesn't leak to the other tests like a global parser would.
function pgBigintAsNumber() {
  const { types } = require('pg');

  return {
    connection: {
      types: {
        getTypeParser: (oid, format) => (oid === 20 ? Number : types.getTypeParser(oid, format)),
      },
    },
  };
}

async function createTables(knex) {
  await knex.schema
    .createTable('customers', (t) => {
      t.bigIncrements('id');
      t.string('name').notNullable();
      t.string('email');
      client === 'sqlite' ? t.text('prefs') : t.json('prefs');
      t.decimal('balance', 10, 2).notNullable().defaultTo(0);
      t.timestamp('createdAt').notNullable().defaultTo(knex.fn.now());

      if (client === 'pg')
        t.specificType('tags', 'text[]');
    })
    .createTable('orders', (t) => {
      t.bigIncrements('id');
      t.bigInteger('customerId').unsigned().notNullable().references('customers.id');
      t.string('sku').notNullable();
    })
    .createTable('products', (t) => {
      t.bigIncrements('id');
      t.string('sku').notNullable().unique();
    })
    .createTable('orders_products', (t) => {
      t.bigInteger('orderId').unsigned().notNullable().references('orders.id');
      t.bigInteger('productId').unsigned().notNullable().references('products.id');
      t.integer('quantity');
    });
}

function makeModels(id = () => z.number().int()) {
  const Customer = defineModel({
    table: 'customers',
    columns: {
      id: column(id()).generated(),
      name: z.string().trim().min(1),
      email: z.string().toLowerCase().nullable().optional(),
      prefs: column(
        z
          .object({ theme: z.enum(['dark', 'light']) })
          .nullable()
          .optional(),
      ).json(),
      // Decimals come back as strings from Postgres and MySQL (see the README).
      balance: column(z.union([z.number(), z.string()])).hasDefault(),
      createdAt: column(z.union([z.date(), z.string(), z.number()])).hasDefault(),
      ...(client === 'pg' && { tags: z.array(z.string()).optional() }),
    },
  });

  const Order = defineModel({
    table: 'orders',
    columns: {
      id: column(id()).generated(),
      customerId: column(id()).references('Customer', 'id', { inverse: 'orders' }),
      sku: z.string(),
    },
  });

  const Product = defineModel({
    table: 'products',
    columns: { id: column(id()).generated(), sku: z.string() },
  });

  return defineModels(
    { Customer, Order, Product },
    {
      Order: r => ({
        products: r.manyToMany('Product', {
          from: 'id',
          to: 'id',
          through: {
            table: 'orders_products',
            from: 'orderId',
            to: 'productId',
            extra: ['quantity'],
          },
        }),
      }),
    },
  );
}

describe(`databases (${client})`, () => {
  let knex;
  let db;

  before(async () => {
    knex = await connect(client === 'pg' ? pgBigintAsNumber() : {});
    await createTables(knex);
    db = makeModels();
    Model.knex(knex);
  });

  after(() => knex.destroy());

  beforeEach(async () => {
    for (const table of ['orders_products', 'products', 'orders', 'customers']) {
      await knex(table).delete();
    }
  });

  it('reads bigint ids as numbers (with the README setup on Postgres)', async () => {
    const inserted = await db.Customer.query().insert({ name: 'Ann' });
    const read = await db.Customer.query().findById(inserted.id);

    expect(inserted.id).to.be.a('number');
    expect(read.id).to.be.a('number');
  });

  it('insertGraph, fetch, then upsertGraph the fetched graph back', async () => {
    const inserted = await db.Customer.query().insertGraph({
      name: ' Ann ',
      orders: [{ sku: 'a', products: [{ sku: 'p1', quantity: 2 }] }, { sku: 'b' }],
    });

    expect(inserted.name).to.equal('Ann');
    expect(inserted.orders[0].customerId).to.equal(inserted.id);

    const fetched = await db.Customer.query()
      .findById(inserted.id)
      .withGraphFetched('orders(bySku).products')
      .modifiers({ bySku: q => q.orderBy('sku') });

    expect(fetched.orders.map(it => it.sku)).to.eql(['a', 'b']);
    expect(fetched.orders[0].products[0]).to.have.property('quantity', 2);

    // What an API handler does: change the fetched graph and write it back.
    fetched.orders[0].sku = 'a2';
    fetched.orders.pop();
    fetched.orders.push({ sku: 'c' });
    await db.Customer.query().upsertGraph(fetched);

    const after = await db.Customer.query()
      .findById(inserted.id)
      .withGraphFetched('orders(bySku).products')
      .modifiers({ bySku: q => q.orderBy('sku') });

    expect(after.orders.map(it => it.sku)).to.eql(['a2', 'c']);
    expect(after.orders[0].products.map(it => it.sku)).to.eql(['p1']);
  });

  it('relate and unrelate many-to-many rows with extra columns', async () => {
    const customer = await db.Customer.query().insert({ name: 'Ann' });
    const order = await db.Order.query().insert({ customerId: customer.id, sku: 'o' });
    const product = await db.Product.query().insert({ sku: 'p' });

    await order.$relatedQuery('products').relate({ id: product.id, quantity: 3 });
    expect(await order.$relatedQuery('products')).to.eql([
      Object.assign(new db.Product.modelClass(), { id: product.id, sku: 'p', quantity: 3 }),
    ]);

    await order.$relatedQuery('products').unrelate().where('products.id', product.id);
    expect(await order.$relatedQuery('products')).to.eql([]);
  });

  it('rolls back a graph insert that fails validation partway', async () => {
    const error = await Model.transaction(trx =>
      db.Customer.query(trx).insertGraph({ name: 'Ann', orders: [{ sku: 'ok' }, { sku: 5 }] }),
    ).catch(err => err);

    expect(error).to.be.a(ValidationError);
    expect(Object.keys(error.data)).to.eql(['orders[1].sku']);
    expect(await db.Customer.query().resultSize()).to.equal(0);
    expect(await db.Order.query().resultSize()).to.equal(0);
  });

  it('a database constraint error is the driver error, not a ValidationError', async () => {
    await db.Product.query().insert({ sku: 'dup' });

    const error = await db.Product.query()
      .insert({ sku: 'dup' })
      .catch(err => err);

    expect(error).not.to.be.a(ValidationError);
    expect(error.message).to.match(/unique|duplicate/i);
  });

  it('patchAndFetchById applies schema transforms and reads the row back', async () => {
    const customer = await db.Customer.query().insert({ name: 'Ann' });

    const patched = await db.Customer.query().patchAndFetchById(customer.id, {
      email: 'ANN@EXAMPLE.COM',
    });

    expect(patched.email).to.equal('ann@example.com');
    expect(patched.name).to.equal('Ann');
  });

  it('round-trips JSON columns', async () => {
    const { id } = await db.Customer.query().insert({ name: 'Ann', prefs: { theme: 'dark' } });
    expect((await db.Customer.query().findById(id)).prefs).to.eql({ theme: 'dark' });

    await db.Customer.query().patchAndFetchById(id, { prefs: null });
    expect((await db.Customer.query().findById(id)).prefs).to.be(null);
  });

  only('pg', 'mysql')('reads decimals as strings and timestamps as Dates', async () => {
    const { id } = await db.Customer.query().insert({ name: 'Ann', balance: 1.5 });
    const read = await db.Customer.query().findById(id);

    expect(read.balance).to.equal('1.50');
    expect(read.createdAt).to.be.a(Date);
  });

  only('pg')('round-trips text[] arrays', async () => {
    const { id } = await db.Customer.query().insert({ name: 'Ann', tags: ['a', 'b'] });
    expect((await db.Customer.query().findById(id)).tags).to.eql(['a', 'b']);
  });

  only('pg')('batch inserts return the generated ids', async () => {
    const customer = await db.Customer.query().insert({ name: 'Ann' });

    const orders = await db.Order.query().insert([
      { customerId: customer.id, sku: 'a' },
      { customerId: customer.id, sku: 'b' },
    ]);

    expect(orders.map(it => typeof it.id)).to.eql(['number', 'number']);
  });

  // A snake_case table (`columnNames`), a camelCase one, and a classic model with
  // objection's `snakeCaseMappers()`, related in both directions.
  describe('column names', () => {
    let names;

    before(async () => {
      await knex.schema
        .createTable('members', (t) => {
          t.increments('member_id');
          t.string('full_name').notNullable();
          t.integer('login_count').notNullable().defaultTo(0);
          client === 'sqlite' ? t.text('settings_json') : t.json('settings_json');
          t.integer('team_id');
        })
        .createTable('teams', (t) => {
          t.increments('teamId');
          t.string('teamName').notNullable();
          t.integer('leadMemberId');
        })
        .createTable('badges', (t) => {
          t.increments('id');
          t.string('badge_label').notNullable();
          t.integer('member_id');
        });

      names = makeNamedModels();
    });

    beforeEach(async () => {
      for (const table of ['badges', 'members', 'teams']) {
        await knex(table).delete();
      }
    });

    function makeNamedModels() {
      const Member = defineModel({
        table: 'members',
        id: 'memberId',
        columnNames: 'snake_case',
        columns: {
          memberId: column(z.number().int()).generated(),
          fullName: z.string(),
          loginCount: column(z.number().int()).hasDefault(),
          settings: column(z.object({ theme: z.string() }).nullable().optional())
            .json()
            .name('settings_json'),
          teamId: column(z.number().int().nullable().optional()).references('Team', 'teamId', {
            inverse: 'members',
          }),
        },
      });

      const Team = defineModel({
        table: 'teams',
        id: 'teamId',
        columns: {
          teamId: column(z.number().int()).generated(),
          teamName: z.string(),
          leadMemberId: column(z.number().int().nullable().optional()).references(
            'Member',
            'memberId',
            { as: 'lead', inverse: 'leads' },
          ),
        },
      });

      let models;

      class Badge extends Model {
        static tableName = 'badges';
        static columnNameMappers = snakeCaseMappers();

        // A classic model's own relations name columns, as they always have.
        static get relationMappings() {
          return {
            member: {
              relation: Model.BelongsToOneRelation,
              modelClass: models.Member.modelClass,
              join: { from: 'badges.member_id', to: 'members.member_id' },
            },
          };
        }
      }

      models = defineModels({ Member, Team, Badge }, [
        relations(Member, r => ({
          // Property names on both sides: each side maps them with its own mappers.
          badges: r.hasMany(Badge, { from: 'memberId', to: 'memberId' }),
        })),
      ]);

      return models;
    }

    it('reads and writes through property names', async () => {
      const ann = await names.Member.query().insert({ fullName: 'Ann', settings: { theme: 'dark' } });

      expect(await knex('members').select('member_id', 'full_name', 'login_count', 'team_id')).to.eql([
        { member_id: ann.memberId, full_name: 'Ann', login_count: 0, team_id: null },
      ]);

      const read = await names.Member.query().findById(ann.memberId);
      expect(read.toJSON()).to.eql({
        memberId: ann.memberId,
        fullName: 'Ann',
        loginCount: 0,
        settings: { theme: 'dark' },
        teamId: null,
      });

      expect(await names.Member.query().patch({ fullName: 'Anne' }).findById(ann.memberId)).to.be(1);
      await names.Member.query().findById(ann.memberId).increment('loginCount', 3);

      const patched = await names.Member.query().patchAndFetchById(ann.memberId, {
        settings: { theme: 'light' },
      });

      expect(patched.fullName).to.be('Anne');
      expect(patched.loginCount).to.be(3);
      expect(patched.settings).to.eql({ theme: 'light' });

      const found = await names.Member.query()
        .select('memberId', 'fullName as name')
        .where('loginCount', '>', 2)
        .whereNotNull('settings')
        .orderBy('fullName');

      expect(found.map(it => it.toJSON())).to.eql([{ memberId: ann.memberId, name: 'Anne' }]);
    });

    only('pg')('maps returning()', async () => {
      const ann = await names.Member.query().insert({ fullName: 'Ann' }).returning('memberId', 'fullName');
      expect(ann.toJSON()).to.eql({ memberId: ann.memberId, fullName: 'Ann' });
      expect(ann.memberId).to.be.a('number');

      const [bob] = await names.Member.query()
        .insert([{ fullName: 'Bob' }])
        .returning('members.memberId', 'members.fullName');

      expect(bob.toJSON()).to.eql({ memberId: bob.memberId, fullName: 'Bob' });
    });

    only('sqlite', 'pg')('never aliases in returning() or groupBy()', () => {
      const query = names.Team.query()
        .joinRelated('members')
        .groupBy('members.fullName', 'teams.teamName')
        .toKnexQuery()
        .toQuery()
        .replace(/[`"]/g, '');

      expect(query).to.contain('group by members.full_name, teams.teamName');

      const patch = names.Team.query()
        .patch({ teamName: 'x' })
        .returning('teams.teamId', 'members.fullName')
        .toKnexQuery()
        .toQuery()
        .replace(/[`"]/g, '');

      expect(patch).to.contain('returning teams.teamId, members.full_name');
    });

    async function insertTeam() {
      const team = await names.Team.query().insertGraph({
        teamName: 'Red',
        members: [
          { fullName: 'Ann', badges: [{ badgeLabel: 'first' }, { badgeLabel: 'second' }] },
          { fullName: 'Bob' },
        ],
      });

      const [ann, bob] = team.members;
      await names.Team.query().patch({ leadMemberId: ann.memberId }).findById(team.teamId);

      return { team, ann, bob };
    }

    it('fetches graphs across both tables and the classic model', async () => {
      const { team, ann, bob } = await insertTeam();

      expect(await knex('badges').select('badge_label', 'member_id').orderBy('badge_label')).to.eql([
        { badge_label: 'first', member_id: ann.memberId },
        { badge_label: 'second', member_id: ann.memberId },
      ]);

      const fetched = await names.Team.query()
        .findById(team.teamId)
        .withGraphFetched('[members(byName).badges, lead]')
        .modifiers({ byName: q => q.orderBy('fullName') });

      expect(fetched.lead.fullName).to.be('Ann');
      expect(fetched.members.map(it => it.fullName)).to.eql(['Ann', 'Bob']);
      expect(fetched.members[0].badges.map(it => it.badgeLabel).sort()).to.eql(['first', 'second']);

      const member = await names.Member.query()
        .findById(ann.memberId)
        .withGraphFetched('[team.lead.badges, leads]');

      expect(member.team.teamName).to.be('Red');
      expect(member.team.lead.badges).to.have.length(2);
      expect(member.leads.map(it => it.teamName)).to.eql(['Red']);

      const bobs = await names.Member.query().findById(bob.memberId).withGraphFetched('team');
      expect(bobs.team.teamId).to.be(team.teamId);

      const badge = await names.Badge.modelClass.query().where('badge_label', 'first').first();

      const classic = await names.Badge.modelClass
        .query()
        .findById(badge.id)
        .withGraphFetched('member.team');

      expect(classic.member.fullName).to.be('Ann');
      expect(classic.member.team.teamName).to.be('Red');
    });

    it('joins across both tables with withGraphJoined', async () => {
      const { ann } = await insertTeam();

      const [member] = await names.Member.query()
        .withGraphJoined('[team.lead, badges]')
        .where('members.memberId', ann.memberId);

      expect(member.team.teamName).to.be('Red');
      expect(member.team.lead.memberId).to.be(ann.memberId);
      expect(member.badges.map(it => it.badgeLabel).sort()).to.eql(['first', 'second']);

      const [team] = await names.Team.query()
        .withGraphJoined('members')
        .where('members.fullName', 'Bob');

      expect(team.members.map(it => it.fullName)).to.eql(['Bob']);
    });

    it('selects joined columns by property name with joinRelated', async () => {
      const { ann, bob } = await insertTeam();

      const rows = await names.Team.query()
        .joinRelated('members')
        .select('teams.teamName', 'members.memberId', 'members.fullName', 'members.loginCount')
        .where('members.fullName', '!=', 'Nobody')
        .orderBy('members.fullName');

      expect(rows.map(it => it.toJSON())).to.eql([
        { teamName: 'Red', memberId: ann.memberId, fullName: 'Ann', loginCount: 0 },
        { teamName: 'Red', memberId: bob.memberId, fullName: 'Bob', loginCount: 0 },
      ]);

      const bobs = await names.Team.query()
        .joinRelated('members')
        .select('members.fullName')
        .where({ 'members.fullName': 'Bob' });

      expect(bobs.map(it => it.toJSON())).to.eql([{ fullName: 'Bob' }]);

      // Joined columns that are renamed are selected under their property name.
      const selection = names.Team.query()
        .joinRelated('members')
        .select('teams.teamName', 'members.teamId', 'members.fullName', 'members.*', 'teamName');

      expect(selection.toKnexQuery().toQuery().replace(/[`"]/g, '')).to.contain(
        'select teams.teamName, members.team_id as teamId, members.full_name as fullName, members.*, teamName from',
      );

      // Only `select` aliases a renamed joined column; GROUP BY and RETURNING can't.
      const grouped = await names.Team.query()
        .joinRelated('members')
        .select('members.fullName')
        .groupBy('members.fullName')
        .orderBy('members.fullName');

      expect(grouped.map(it => it.toJSON())).to.eql([{ fullName: 'Ann' }, { fullName: 'Bob' }]);

      const classic = await names.Member.query()
        .joinRelated('badges.member')
        .select('badges:member.fullName as holder')
        .where('badges:member.memberId', ann.memberId)
        .orderBy('badges.id');

      expect(classic.map(it => it.toJSON())).to.eql([{ holder: 'Ann' }, { holder: 'Ann' }]);

      const leads = await names.Member.query()
        .joinRelated('team.lead')
        .select('members.fullName', 'team.teamName', 'team:lead.fullName as leadName')
        .where('team:lead.memberId', ann.memberId)
        .orderBy('members.fullName');

      expect(leads.map(it => it.toJSON())).to.eql([
        { fullName: 'Ann', teamName: 'Red', leadName: 'Ann' },
        { fullName: 'Bob', teamName: 'Red', leadName: 'Ann' },
      ]);
    });

    it('relates, queries related rows and upserts graphs', async () => {
      const { team, ann, bob } = await insertTeam();

      const cara = await names.Member.query().insert({ fullName: 'Cara' });
      await team.$relatedQuery('members').relate(cara.memberId);

      const related = await names.Team.relatedQuery('members')
        .for(team.teamId)
        .where('fullName', '!=', 'Bob')
        .orderBy('fullName');

      expect(related.map(it => it.fullName)).to.eql(['Ann', 'Cara']);
      expect((await ann.$relatedQuery('badges')).map(it => it.badgeLabel).sort()).to.eql([
        'first',
        'second',
      ]);

      const fetched = await names.Team.query()
        .findById(team.teamId)
        .withGraphFetched('members(byName).badges')
        .modifiers({ byName: q => q.orderBy('fullName') });

      fetched.teamName = 'Blue';
      fetched.members = fetched.members.filter(it => it.memberId !== bob.memberId);
      fetched.members[0].fullName = 'Annie';
      fetched.members[0].badges.push({ badgeLabel: 'third' });

      await names.Team.query().upsertGraph(fetched);

      const after = await names.Team.query()
        .findById(team.teamId)
        .withGraphFetched('members(byName).badges')
        .modifiers({ byName: q => q.orderBy('fullName') });

      expect(after.teamName).to.be('Blue');
      expect(after.members.map(it => it.fullName)).to.eql(['Annie', 'Cara']);
      expect(after.members[0].badges.map(it => it.badgeLabel).sort()).to.eql(['first', 'second', 'third']);
      // Removed from the graph, so upsertGraph deleted it.
      expect(await knex('members').where('member_id', bob.memberId)).to.eql([]);
    });
  });

  describe('postgres bigint without a type parser', () => {
    let rawKnex;

    before(async function () {
      if (client !== 'pg')
        this.skip();
      // A fresh database (dropping the outer tests' tables, which have run by now).
      rawKnex = await connect();
      await createTables(rawKnex);
    });

    after(() => rawKnex && rawKnex.destroy());

    // Pins the limitation the README documents: ids come back as strings, and graph
    // writes then fail because objection copies them into `z.number()` foreign keys.
    it('fails graph writes with z.number() ids', async () => {
      const models = makeModels();

      const error = await models.Customer.query(rawKnex)
        .insertGraph({ name: 'Ann', orders: [{ sku: 'a' }] })
        .catch(err => err);

      expect(error).to.be.a(ValidationError);
      expect(error.message).to.match(/orders\[0\]\.customerId: .*expected number, received string/);
    });

    it('works with z.coerce.number() ids, the other documented fix', async () => {
      const models = makeModels(() => z.coerce.number().int());

      const customer = await models.Customer.query(rawKnex).insertGraph({
        name: 'Ann',
        orders: [{ sku: 'a' }],
      });

      expect(customer.id).to.be.a('string');
      expect(customer.orders[0].customerId).to.be.a('number');
    });
  });
});
