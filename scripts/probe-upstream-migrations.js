'use strict';

// Optional, networked smoke test against actual pinned upstream classes. Downloads
// stay in node_modules/.cache, never the package or git. See tests/migrations/README.md.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const process = require('node:process');
const Knex = require('knex');
const { Model } = require('objection');
const { column, defineModel, defineModels } = require('objection-schema');
const { z } = require('zod');

const sources = [
  {
    name: 'WikiGroup',
    url: 'https://raw.githubusercontent.com/requarks/wiki/1161ddc6e6f4388a15d90278d55b099248ce6e79/server/models/groups.js',
  },
  {
    name: 'ConduitFavorite',
    url: 'https://raw.githubusercontent.com/paulogdm/micro-objection-realworld-example-app/146e9c5dfff69f70dce769fcb7a6cd2dfe6e37cb/src/models/Favorite.js',
  },
];

async function main() {
  const cache = path.resolve(__dirname, '../node_modules/.cache');
  await fs.mkdir(cache, { recursive: true });
  // Beneath node_modules so the upstream modules resolve this app's Objection 3.
  const dir = await fs.mkdtemp(path.join(cache, 'upstream-migrations-'));
  const classes = {};

  for (const { name, url } of sources) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });

    if (!response.ok)
      throw new Error(`Download failed (${response.status}): ${url}`);
    const file = path.join(dir, `${name}.cjs`);
    await fs.writeFile(file, await response.text());
    classes[name] = require(file);
    console.log(`Loaded ${url}`);
  }

  const knex = Knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });

  try {
    await knex.schema
      .createTable('groups', (t) => {
        t.increments('id');
        t.string('name');
        t.text('permissions');
        t.text('pageRules');
        t.string('createdAt');
        t.string('updatedAt');
      })
      .createTable('users', (t) => {
        t.increments('id');
        t.string('email');
      })
      .createTable('userGroups', (t) => {
        t.integer('groupId');
        t.integer('userId');
      })
      .createTable('favorites', (t) => {
        t.integer('userId');
        t.integer('articleId');
        t.primary(['userId', 'articleId']);
      });

    const Group = defineModel({
      base: classes.WikiGroup,
      table: 'groups',
      columns: {
        id: column(z.number()).generated(),
        name: z.string(),
        permissions: column(z.array(z.string())).json(),
        pageRules: column(z.array(z.json())).json(),
        createdAt: z.string().optional(),
        updatedAt: z.string().optional(),
      },
    });

    const User = defineModel({
      table: 'users',
      columns: { id: column(z.number()).generated(), email: z.string() },
    });

    const Favorite = defineModel({
      base: classes.ConduitFavorite,
      table: 'favorites',
      id: ['userId', 'articleId'],
      columns: { userId: z.number(), articleId: z.number() },
    });

    const db = defineModels({ Group, User, Favorite }, {
      Group: r => ({
        users: r.manyToMany('User', {
          from: 'id',
          to: 'id',
          through: { table: 'userGroups', from: 'groupId', to: 'userId' },
        }),
      }),
    });

    const group = await db.Group.query(knex).insertGraph({
      name: 'Editors',
      permissions: ['read:pages'],
      pageRules: [],
      users: [{ email: 'editor@example.org' }],
    });

    assert.ok(group instanceof classes.WikiGroup);
    assert.ok(!Number.isNaN(Date.parse(group.createdAt)));
    assert.ok(!Number.isNaN(Date.parse(group.updatedAt)));
    const fetched = await db.Group.query(knex).findById(group.id).withGraphFetched('users');
    assert.deepEqual(fetched.permissions, ['read:pages']);
    assert.equal(fetched.users[0].email, 'editor@example.org');
    assert.equal(Object.getOwnPropertyDescriptor(classes.WikiGroup, 'relationMappings').set, undefined);
    console.log('PASS Wiki.js: unmodified upstream Group base, JSON, real timestamp hooks, replaced getter relation, graph insert/fetch');

    const favorite = await db.Favorite.query(knex).insert({ userId: 1, articleId: 2 });
    assert.ok(favorite instanceof classes.ConduitFavorite);
    assert.deepEqual((await db.Favorite.query(knex).findById([1, 2])).toJSON(), { userId: 1, articleId: 2 });
    await db.Favorite.query(knex).deleteById([1, 2]);
    assert.equal(await db.Favorite.query(knex).findById([1, 2]), undefined);
    console.log('PASS Conduit: unmodified upstream Favorite base, composite getter ID, insert/find/delete');
    assert.equal(classes.WikiGroup.tableName, 'groups');
    assert.deepEqual(classes.ConduitFavorite.idColumn, ['userId', 'articleId']);
    assert.ok(group instanceof Model);
    console.log(`Downloaded source retained locally at ${dir}`);
  }
  finally {
    await knex.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
