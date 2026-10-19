'use strict';
// The database the runtime tests run against, picked with the `DB` environment variable:
// `sqlite` (default, in memory), `pg` or `mysql`. Connection settings for the real
// databases come from `PG*` / `MYSQL_*` variables, with defaults matching CI.
const process = require('node:process');
const Knex = require('knex');

const client = process.env.DB || 'sqlite';

const configs = {
  sqlite: () => ({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  }),
  pg: () => ({
    client: 'pg',
    connection: {
      host: process.env.PGHOST || '127.0.0.1',
      port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD || 'postgres',
      database: process.env.PGDATABASE || 'objection_schema_test',
    },
  }),
  mysql: () => ({
    client: 'mysql2',
    connection: {
      host: process.env.MYSQL_HOST || '127.0.0.1',
      port: Number(process.env.MYSQL_PORT || 3306),
      user: process.env.MYSQL_USER || 'test',
      password: process.env.MYSQL_PASSWORD || 'test',
      database: process.env.MYSQL_DATABASE || 'objection_schema_test',
    },
  }),
};

if (!configs[client]) {
  throw new Error(`DB must be one of ${Object.keys(configs).join(', ')}, got "${client}"`);
}

// A connection to an empty database: the test files share table names, and a real
// database keeps them between files.
async function connect(overrides = {}) {
  const config = configs[client]();
  const knex = Knex(
    Object.assign({}, config, overrides, {
      connection: Object.assign({}, config.connection, overrides.connection),
    }),
  );

  if (client === 'pg') {
    await knex.raw('drop schema public cascade; create schema public');
  }
  else if (client === 'mysql') {
    const [tables] = await knex.raw('show tables');

    if (tables.length) {
      const names = tables.map(row => Object.values(row)[0]);
      // One connection, as `foreign_key_checks` is per session.
      await knex.transaction(async (trx) => {
        await trx.raw('set foreign_key_checks = 0');
        await trx.raw(`drop table ${names.map(() => '??').join(', ')}`, names);
        await trx.raw('set foreign_key_checks = 1');
      });
    }
  }

  return knex;
}

module.exports = { client, connect };
