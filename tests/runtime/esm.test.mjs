// The ES module entry point: same exports and the same instances as `require()`,
// working against objection 3.x (which is CommonJS) from ESM code.
import { createRequire } from 'node:module';
import expect from 'expect.js';
import { Model } from 'objection';
import * as esm from 'objection-schema';
import { column, defineModel, defineModels } from 'objection-schema';
import { z } from 'zod';
import db from './db.js';

const require = createRequire(import.meta.url);
const cjs = require('objection-schema');

const { connect } = db;

describe('ES module entry point', () => {
  it('exports exactly what the CommonJS entry point exports, as the same instances', () => {
    expect(Object.keys(esm).sort()).to.eql(Object.keys(cjs).sort());

    for (const name of Object.keys(cjs)) {
      expect(esm[name]).to.be(cjs[name]);
    }
  });

  it('defines and queries models from ESM code', async () => {
    const knex = await connect();

    try {
      await knex.schema.createTable('items', (t) => {
        t.increments('id');
        t.string('name');
      });

      const Item = defineModel({
        table: 'items',
        columns: { id: column(z.number()).generated(), name: z.string().trim().min(1) },
      });
      const db = defineModels({ Item });

      const item = await db.Item.query(knex).insert({ name: '  ok  ' });
      expect(item.name).to.equal('ok');
      expect(item).to.be.a(Model);
      expect(await db.Item.query(knex).resultSize()).to.equal(1);
    }
    finally {
      await knex.destroy();
    }
  });
});
