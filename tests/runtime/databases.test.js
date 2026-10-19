'use strict';

// Column types of real applications (bigint ids, decimals, JSON, timestamps, arrays) and
// what each database returns for them. Runs against the database picked with `DB` (see
// db.js); the parts that only apply to some databases skip themselves on the others.

const expect = require('expect.js');
const { Model, ValidationError } = require('objection');
const { defineModel, defineModels, column } = require('objection-schema');
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
      .withGraphFetched('orders(orderById).products')
      .modifiers({ orderById: q => q.orderBy('id') });
    expect(fetched.orders.map(it => it.sku)).to.eql(['a', 'b']);
    expect(fetched.orders[0].products[0]).to.have.property('quantity', 2);

    // What an API handler does: change the fetched graph and write it back.
    fetched.orders[0].sku = 'a2';
    fetched.orders.pop();
    fetched.orders.push({ sku: 'c' });
    await db.Customer.query().upsertGraph(fetched);

    const after = await db.Customer.query()
      .findById(inserted.id)
      .withGraphFetched('orders(orderById).products')
      .modifiers({ orderById: q => q.orderBy('id') });
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
