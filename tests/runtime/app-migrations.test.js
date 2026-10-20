'use strict';

// Independently written migration slices, not vendored applications. Pinned sources,
// adaptations and intentionally untested app features: tests/migrations/README.md.
const expect = require('expect.js');
const { Model, ValidationError } = require('objection');
const { column, defineModel, defineModels, toQueryBuilder } = require('objection-schema');
const { z } = require('zod');
const { connect } = require('./db');

const timestamp = '2025-01-02T03:04:05.000Z';

function wikiModels() {
  // Wiki.js settings use a string key, a JSON value not declared in jsonSchema,
  // and a timestamp hook. Keep class behavior while replacing validation.
  class Setting extends Model {
    static get tableName() { return 'settings'; }
    static get idColumn() { return 'key'; }
    static get jsonAttributes() { return ['value']; }
    $beforeInsert() { this.updatedAt = timestamp; }
    $beforeUpdate() { this.updatedAt = timestamp; }
  }

  class User extends Model {
    static get tableName() { return 'users'; }
    static get jsonSchema() {
      return {
        type: 'object',
        required: ['email'],
        properties: { id: { type: 'integer' }, email: { type: 'string' } },
      };
    }
  }

  class Group extends Model {
    static get tableName() { return 'groups'; }
    static get jsonAttributes() { return ['permissions', 'pageRules']; }
    static get relationMappings() {
      return {
        users: {
          relation: Model.ManyToManyRelation,
          modelClass: User,
          join: {
            from: 'groups.id',
            through: { from: 'userGroups.groupId', to: 'userGroups.userId' },
            to: 'users.id',
          },
        },
      };
    }

    $beforeInsert() { this.createdAt = this.updatedAt = timestamp; }
    $beforeUpdate() { this.updatedAt = timestamp; }
  }

  const Settings = defineModel({
    base: Setting,
    table: 'settings',
    id: 'key',
    columns: {
      key: z.string(),
      value: column(z.json()).json(),
      updatedAt: z.string().optional(),
    },
  });

  const Groups = defineModel({
    base: Group,
    table: 'groups',
    columns: {
      id: column(z.number().int()).generated(),
      name: z.string(),
      permissions: column(z.array(z.string())).json(),
      pageRules: column(z.array(z.object({ path: z.string(), roles: z.array(z.string()) }))).json(),
      createdAt: z.string().optional(),
      updatedAt: z.string().optional(),
    },
  });

  const db = defineModels({ Setting: Settings, Group: Groups, User }, {
    Group: r => ({
      users: r.manyToMany('User', {
        from: 'id',
        to: 'id',
        through: { table: 'userGroups', from: 'groupId', to: 'userId' },
      }),
    }),
  });

  return { db, Setting, Group };
}

function conduitModels() {
  // Retain the app's response serialization, but move its namedFilters (Objection 1)
  // to modifiers (Objection 3), and use an explicit composite-key favorite model.
  class User extends Model {
    static get tableName() { return 'users'; }
    $formatJson(json) {
      const result = super.$formatJson(json);
      delete result.hashed_password;

      return result;
    }
  }

  class Article extends Model {
    static get tableName() { return 'articles'; }
    $beforeUpdate() { this.updatedAt = timestamp; }
    $formatJson(json) {
      return { ...super.$formatJson(json), favorited: !!json.favorited };
    }
  }

  class Favorite extends Model {
    static get tableName() { return 'favorites'; }
    static get idColumn() { return ['userId', 'articleId']; }
  }

  class Tag extends Model {
    static get tableName() { return 'tags'; }
    $formatJson(json) { return json.tag; }
  }

  const Users = defineModel({
    base: User,
    table: 'users',
    columns: {
      id: column(z.number().int()).generated(),
      username: z.string().min(1).max(20),
      email: z.string().max(255),
      hashed_password: z.string().min(1).max(255),
      bio: z.string().max(255).nullable().default(''),
    },
  });

  const Articles = defineModel({
    base: Article,
    table: 'articles',
    columns: {
      id: column(z.number().int()).generated(),
      userId: column(z.number().int()).references('User', 'id', { as: 'author' }),
      slug: z.string().min(1).max(255),
      title: z.string().max(255).nullable().optional(),
      description: z.string().max(255).nullable().default(''),
      body: z.string().nullable().optional(),
      updatedAt: z.string().optional(),
    },
    modifiers: { allFields: q => q.select('articles.*') },
  });

  const Favorites = defineModel({
    base: Favorite,
    table: 'favorites',
    id: ['userId', 'articleId'],
    columns: { userId: z.number().int(), articleId: z.number().int() },
  });

  const Tags = defineModel({
    base: Tag,
    table: 'tags',
    columns: { id: column(z.number().int()).generated(), tag: z.string().min(1).max(20) },
  });

  return defineModels({ User: Users, Article: Articles, Favorite: Favorites, Tag: Tags }, {
    Article: r => ({
      tags: r.manyToMany('Tag', {
        from: 'id',
        to: 'id',
        through: { table: 'articles_tags', from: 'articleId', to: 'tagId' },
      }),
      favoritedBy: r.manyToMany('User', {
        from: 'id',
        to: 'id',
        through: { table: 'favorites', from: 'articleId', to: 'userId' },
      }),
    }),
  });
}

describe('real app migration slices', () => {
  let knex;

  before(async () => {
    knex = await connect();
    Model.knex(knex);
    await knex.schema
      .createTable('settings', (t) => {
        t.string('key').primary();
        t.text('value');
        t.string('updatedAt');
      })
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
        t.string('username');
        t.string('hashed_password');
        t.string('bio');
      })
      .createTable('userGroups', (t) => {
        t.integer('groupId');
        t.integer('userId');
        t.primary(['groupId', 'userId']);
      })
      .createTable('articles', (t) => {
        t.increments('id');
        t.integer('userId');
        t.string('slug');
        t.string('title');
        t.string('description');
        t.text('body');
        t.string('updatedAt');
      })
      .createTable('tags', (t) => {
        t.increments('id');
        t.string('tag');
      })
      .createTable('articles_tags', (t) => {
        t.integer('articleId');
        t.integer('tagId');
        t.primary(['articleId', 'tagId']);
      })
      .createTable('favorites', (t) => {
        t.integer('userId');
        t.integer('articleId');
        t.primary(['userId', 'articleId']);
      });
  });
  after(() => knex.destroy());
  beforeEach(async () => {
    for (const table of ['favorites', 'articles_tags', 'tags', 'articles', 'userGroups', 'users', 'groups', 'settings']) {
      await knex(table).delete();
    }
  });

  it('wiki settings: getter-based base class, string IDs and nested JSON round trip', async () => {
    const { db, Setting } = wikiModels();
    const value = { v: { title: 'Knowledge base', enabled: true, languages: ['en', 'fr'] } };
    const inserted = await db.Setting.query().insert({ key: 'site', value });
    expect(inserted).to.be.a(Setting);
    const fetched = await db.Setting.query().findById('site');
    expect(fetched.value).to.eql(value);
    expect(fetched.updatedAt).to.equal(timestamp);
    expect(await db.Setting.query().findById('missing')).to.be(undefined);
    await db.Setting.query().findById('site').patch({ value: { v: false } });
    expect((await db.Setting.query().findById('site')).value).to.eql({ v: false });
    // Generation must not mutate the original app class.
    expect(Setting.tableName).to.equal('settings');
    expect(Setting.idColumn).to.equal('key');
    expect(Setting.jsonAttributes).to.eql(['value']);
  });

  it('wiki groups: replace inherited getter relations, retain hooks and classic users', async () => {
    const { db, Group } = wikiModels();

    const input = {
      name: 'Editors',
      permissions: ['read:pages', 'write:pages'],
      pageRules: [{ path: '/docs', roles: ['editor'] }],
      users: [{ email: 'editor@example.org' }],
    };

    const group = await db.Group.query().insertGraph(input);
    const classic = await Group.query().findById(group.id).withGraphFetched('users');
    const fetched = await db.Group.query().findById(group.id).withGraphFetched('users');
    expect(fetched.toJSON()).to.eql(classic.toJSON());
    expect(fetched.permissions).to.eql(input.permissions);
    expect(fetched.pageRules).to.eql(input.pageRules);
    expect(fetched.createdAt).to.equal(timestamp);
    expect(fetched.users[0].email).to.equal('editor@example.org');
    await fetched.$relatedQuery('users').unrelate();
    expect((await db.Group.query().findById(group.id).withGraphFetched('users')).users).to.eql([]);
    // Registration also works through a bound handle, without changing the base mapping.
    const bound = db.Group.bindKnex(knex);
    expect((await bound.query().findById(group.id)).name).to.equal('Editors');
    expect(Group.relationMappings.users.modelClass.tableName).to.equal('users');
    // Preserve the normal static-field descriptor for plugins inspecting/replacing mappings.
    expect(Object.getOwnPropertyDescriptor(db.Group.modelClass, 'relationMappings')).to.eql({
      value: db.Group.modelClass.relationMappings,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  });

  it('conduit feed: graph insert, tags, favorites, correlated count and response serialization', async () => {
    const db = conduitModels();
    const user = await db.User.query().insert({ username: 'ann', email: 'ann@example.org', hashed_password: 'secret' });

    const article = await db.Article.query().insertGraph({
      userId: user.id,
      slug: 'migration-notes',
      title: 'Migration notes',
      tags: [{ tag: 'orm' }],
    });

    await db.Favorite.query().insert({ userId: user.id, articleId: article.id });

    const feed = await toQueryBuilder(db.Article.query().modify('allFields'))
      .select(toQueryBuilder(db.Article.relatedQuery('favoritedBy')).count().as('favoritesCount'))
      .select(toQueryBuilder(db.Article.relatedQuery('favoritedBy')).select('favorites.articleId').where('favorites.userId', user.id).as('favorited'))
      .withGraphFetched('[author, tags]');

    expect(feed.length).to.equal(1);
    const response = feed[0].toJSON();
    expect(response.tags).to.eql(['orm']);
    expect(response.author.username).to.equal('ann');
    expect(response.author).not.to.have.key('hashed_password');
    expect(response.author.bio).to.equal('');
    expect(response.description).to.equal('');
    expect(response.favorited).to.equal(true);
    expect(Number(response.favoritesCount)).to.equal(1);
    expect((await db.User.query().findById(user.id)).hashed_password).to.equal('secret');
    await db.Favorite.query().deleteById([user.id, article.id]);
    expect(await db.Favorite.query().findById([user.id, article.id])).to.be(undefined);
  });

  it('conduit edits: patch preserves omitted fields, accepts null and runs the inherited hook', async () => {
    const db = conduitModels();
    const article = await db.Article.query().insert({ userId: 1, slug: 'notes', title: 'Original' });
    await db.Article.query().findById(article.id).patch({ body: 'Changed', description: null });
    const edited = await db.Article.query().findById(article.id);
    expect(edited.title).to.equal('Original');
    expect(edited.description).to.be(null);
    expect(edited.updatedAt).to.equal(timestamp);
    const error = await db.Article.query().findById(article.id).patch({ slug: '' }).catch(err => err);
    expect(error).to.be.a(ValidationError);
    expect(Object.keys(error.data)).to.eql(['slug']);
    expect((await db.Article.query().findById(article.id)).slug).to.equal('notes');
  });

  it('conduit publishing: a transaction rolls back an invalid nested tag', async () => {
    const db = conduitModels();

    const error = await knex.transaction(async (trx) => {
      const user = await db.User.query(trx).insert({ username: 'ann', email: 'ann@example.org', hashed_password: 'secret' });
      await db.Article.query(trx).insertGraph({ userId: user.id, slug: 'notes', tags: [{ tag: '' }] });
    }).catch(err => err);

    expect(error).to.be.a(ValidationError);
    expect(await db.User.query()).to.eql([]);
    expect(await db.Article.query()).to.eql([]);
    expect(await db.Tag.query()).to.eql([]);
  });
});
