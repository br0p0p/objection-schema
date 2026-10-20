"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.defineModel = defineModel;
exports.isModelDefinition = isModelDefinition;
exports.isModelHandle = isModelHandle;
exports.classicModelHandle = classicModelHandle;
const column_1 = require("./column.js");
const objection_1 = require("./objection.js");
const StandardSchemaValidator_1 = require("./StandardSchemaValidator.js");
const HOOKS = {
    beforeInsert: fn => function $beforeInsert(ctx) {
        return fn(this, ctx);
    },
    afterInsert: fn => function $afterInsert(ctx) {
        return fn(this, ctx);
    },
    beforeUpdate: fn => function $beforeUpdate(opt, ctx) {
        return fn(this, opt, ctx);
    },
    afterUpdate: fn => function $afterUpdate(opt, ctx) {
        return fn(this, opt, ctx);
    },
    afterFind: fn => function $afterFind(ctx) {
        return fn(this, ctx);
    },
    beforeDelete: fn => function $beforeDelete(ctx) {
        return fn(this, ctx);
    },
    afterDelete: fn => function $afterDelete(ctx) {
        return fn(this, ctx);
    },
};
function defineModel(config) {
    const { name, table, columns, id = 'id', modifiers = null, hooks = {}, 
    // objection's `Model`, so that a global `Model.knex(knex)` binding is
    // inherited, like with classic models.
    base = objection_1.Model, validate = true, } = config || {};
    if (typeof table !== 'string') {
        throw new Error('defineModel: `table` must be a string');
    }
    if (!(0, objection_1.isModelClass)(base)) {
        throw new Error('defineModel: `base` must be an objection Model class');
    }
    const cols = (0, column_1.normalizeColumns)(columns);
    const colProps = new Set(cols.map(it => it.prop));
    const className = name || toClassName(table);
    for (const idProp of Array.isArray(id) ? id : [id]) {
        if (!colProps.has(idProp)) {
            throw new Error(`defineModel(${className}): id column "${idProp}" is not in \`columns\``);
        }
    }
    // Computed property name gives the class (and stack traces) a proper name.
    const modelClass = { [className]: class extends base {
        } }[className];
    modelClass.tableName = table;
    modelClass.idColumn = id;
    // SAFETY: objection passes modifiers its query builder, which typed modifiers see through
    // `Query`. It treats `null` like no modifiers.
    modelClass.modifiers = modifiers;
    modelClass.jsonAttributes = cols.filter(it => it.json).map(it => it.prop);
    modelClass.createValidator = validate
        ? () => new StandardSchemaValidator_1.StandardSchemaValidator({ columns: cols })
        : () => new StandardSchemaValidator_1.StandardSchemaValidator({ columns: [] });
    // SAFETY: the values are hook functions; names that aren't hooks throw below.
    const hookFns = hooks;
    for (const hookName of Object.keys(hookFns)) {
        if (!HOOKS[hookName]) {
            throw new Error(`defineModel(${className}): unknown hook "${hookName}"`);
        }
        Object.assign(modelClass.prototype, { [`$${hookName}`]: HOOKS[hookName](hookFns[hookName]) });
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
    // SAFETY: `isObjectionModelDefinition` was defined just above (non-enumerable, read-only).
    return Object.freeze(handle);
}
/** Whether a value is a `defineModel()` definition (or a handle from `defineModels()`). */
function isModelDefinition(value) {
    return isModelHandle(value);
}
// The same check, typed with the runtime shape.
function isModelHandle(value) {
    // SAFETY: only read, and compared to `true`.
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
