// The ES module entry point: the same exports as `require()`, working against objection 3.x
// (which is CommonJS) from ESM code. It's a second build of lib/, so an app that both `import`s
// and `require`s the package loads two copies; they have to work together.
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
  it('exports exactly what the CommonJS entry point exports, from its own build', () => {
    expect(Object.keys(esm).sort()).to.eql(Object.keys(cjs).sort());
    expect(esm.defineModel).not.to.be(cjs.defineModel);
  });

  it('works together with the CommonJS build', () => {
    const Owner = esm.defineModel({
      table: 'owners',
      columns: { id: esm.column(z.number()).generated() },
    });

    const Pet = cjs.defineModel({
      table: 'pets',
      columns: {
        id: cjs.column(z.number()).generated(),
        ownerId: esm.column(z.number()).references('Owner', 'id', { inverse: 'pets' }),
      },
    });

    expect(cjs.isModelDefinition(Owner)).to.be(true);
    expect(esm.isModelDefinition(Pet)).to.be(true);

    const db = cjs.defineModels({ Owner, Pet }, [esm.relations(Owner, () => ({}))]);
    expect(Object.keys(db.Owner.modelClass.relationMappings())).to.eql(['pets']);
    expect(Object.keys(db.Pet.modelClass.relationMappings())).to.eql(['owner']);

    // Both builds know which definitions are in a registry already.
    expect(() => esm.defineModels({ Owner })).to.throwError(
      /"Owner" \(Owners\) is already part of another registry/,
    );
  });

  it('shares the registered definitions with other copies through a global symbol', () => {
    const Item = esm.defineModel({ table: 'items', columns: { id: z.number() } });
    esm.defineModels({ Item });

    expect(globalThis[Symbol.for('objection-schema.registered')].has(Item.modelClass)).to.be(true);
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
