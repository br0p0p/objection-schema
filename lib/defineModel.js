'use strict';

const { Model } = require('objection');
const { normalizeColumns } = require('./column');
const { StandardSchemaValidator } = require('./StandardSchemaValidator');

const HOOKS = {
  beforeInsert: fn =>
    function $beforeInsert(ctx) {
      return fn(this, ctx);
    },
  afterInsert: fn =>
    function $afterInsert(ctx) {
      return fn(this, ctx);
    },
  beforeUpdate: fn =>
    function $beforeUpdate(opt, ctx) {
      return fn(this, opt, ctx);
    },
  afterUpdate: fn =>
    function $afterUpdate(opt, ctx) {
      return fn(this, opt, ctx);
    },
  afterFind: fn =>
    function $afterFind(ctx) {
      return fn(this, ctx);
    },
  beforeDelete: fn =>
    function $beforeDelete(ctx) {
      return fn(this, ctx);
    },
  afterDelete: fn =>
    function $afterDelete(ctx) {
      return fn(this, ctx);
    },
};

// Creates a model definition from a plain configuration object. Under the hood
// an ordinary objection model class is generated, which is what makes the
// definition fully interoperable with classic models, query builders, plugins,
// relations and transactions. The class never has to be touched by users.
function defineModel(config) {
  const {
    name,
    table,
    columns,
    id = 'id',
    modifiers = null,
    hooks = {},
    // objection's `Model`, so that a global `Model.knex(knex)` binding is
    // inherited, like with classic models.
    base = Model,
    validate = true,
  } = config || {};

  if (typeof table !== 'string') {
    throw new Error('defineModel: `table` must be a string');
  }

  if (!base || !base.isObjectionModelClass) {
    throw new Error('defineModel: `base` must be an objection Model class');
  }

  const cols = normalizeColumns(columns);
  const colProps = new Set(cols.map(it => it.prop));
  const className = name || toClassName(table);

  for (const idProp of Array.isArray(id) ? id : [id]) {
    if (!colProps.has(idProp)) {
      throw new Error(`defineModel(${className}): id column "${idProp}" is not in \`columns\``);
    }
  }

  // Computed property name gives the class (and stack traces) a proper name.
  const modelClass = { [className]: class extends base {} }[className];

  modelClass.tableName = table;
  modelClass.idColumn = id;
  modelClass.modifiers = modifiers;
  modelClass.jsonAttributes = cols.filter(it => it.json).map(it => it.prop);
  modelClass.createValidator = validate
    ? () => new StandardSchemaValidator({ columns: cols })
    : () => new StandardSchemaValidator({ columns: [] });

  for (const hookName of Object.keys(hooks)) {
    if (!HOOKS[hookName]) {
      throw new Error(`defineModel(${className}): unknown hook "${hookName}"`);
    }

    modelClass.prototype[`$${hookName}`] = HOOKS[hookName](hooks[hookName]);
  }

  const def = createModelHandle(modelClass, {
    name: className,
    table,
    idColumn: id,
    columns: Object.freeze(Object.assign({}, columns)),
  });

  return def;
}

function createModelHandle(modelClass, meta) {
  const handle = {
    name: meta.name,
    table: meta.table,
    idColumn: meta.idColumn,
    columns: meta.columns,
    modelClass,

    query(trx) {
      return modelClass.query(trx);
    },

    relatedQuery(relationName, trx) {
      return modelClass.relatedQuery(relationName, trx);
    },

    // Validates input exactly like an insert (or a patch with `{ patch: true }`)
    // would, without touching the database. Returns the parsed output.
    validate(json, options) {
      return new modelClass().$validate(Object.assign({}, json), options);
    },

    fromJson(json, options) {
      return modelClass.fromJson(json, options);
    },

    ref(prop) {
      return modelClass.ref(prop);
    },

    bindKnex(knex) {
      return createModelHandle(modelClass.bindKnex(knex), meta);
    },
  };

  Object.defineProperty(handle, 'isObjectionModelDefinition', { value: true });

  return Object.freeze(handle);
}

function isModelDefinition(value) {
  return !!value && value.isObjectionModelDefinition === true;
}

// Typed handle around an existing (classic) model class.
function classicModelHandle(modelClass) {
  return createModelHandle(modelClass, {
    name: modelClass.name,
    table: modelClass.getTableName(),
    idColumn: modelClass.getIdColumn(),
    columns: null,
  });
}

// Stryker disable Regex: splitting on single separators leaves empty parts, which are filtered out.
function toClassName(table) {
  return table
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map(it => it[0].toUpperCase() + it.slice(1))
    .join('');
}
// Stryker restore Regex

module.exports = {
  defineModel,
  isModelDefinition,
  classicModelHandle,
};
