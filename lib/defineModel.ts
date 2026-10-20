import type {
  ModelOptions,
  Modifiers,
  Pojo,
  QueryBuilder,
  ReferenceBuilder,
  TransactionOrKnex,
} from 'objection';
import type { ColumnMeta } from './column';
import type { ModelClass } from './objection';
import type { AnyModelHandle, Columns, ModelConfig, ModelDefinition, StrKeys } from './types';
import { normalizeColumns } from './column';
import { isModelClass, Model } from './objection';
import { StandardSchemaValidator } from './StandardSchemaValidator';

type ModelInstance = InstanceType<ModelClass>;

/** A hook from the config: the row, then the arguments objection passes to `$hook`. */
type Hook = (row: ModelInstance, ...args: any[]) => void | Promise<void>;

/** Wraps a hook into the `$hook` method objection calls on model instances. */
interface HookFactories {
  readonly [hookName: string]: (fn: Hook) => (this: ModelInstance, ...args: any[]) => void | Promise<void>;
}

const HOOKS: HookFactories = {
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

/** The configuration as `defineModel` reads it at runtime (`ModelConfig` is the typed one). */
interface RuntimeConfig {
  name?: string;
  table?: unknown;
  columns?: unknown;
  id?: string | readonly string[];
  modifiers?: object | null;
  hooks?: object;
  base?: unknown;
  validate?: boolean;
}

interface HandleMeta {
  readonly name: string;
  readonly table: string;
  readonly idColumn: ModelClass['idColumn'];
  readonly columns: Readonly<Record<string, { readonly '~column'?: ColumnMeta }>> | null;
}

/** A model definition (or a handle to a classic model) at runtime. */
export interface RuntimeHandle extends HandleMeta {
  readonly modelClass: ModelClass;
  readonly isObjectionModelDefinition: true;
  query: (trx?: TransactionOrKnex) => QueryBuilder<ModelInstance>;
  relatedQuery: (relationName: string, trx?: TransactionOrKnex) => QueryBuilder<ModelInstance>;
  validate: (json: object, options?: ModelOptions) => Pojo;
  fromJson: (json: object, options?: ModelOptions) => ModelInstance;
  ref: (prop: string) => ReferenceBuilder;
  bindKnex: (knex: TransactionOrKnex) => RuntimeHandle;
}

// Creates a model definition from a plain configuration object. Under the hood
// an ordinary objection model class is generated, which is what makes the
// definition fully interoperable with classic models, query builders, plugins,
// relations and transactions. The class never has to be touched by users.
export function defineModel<
  const T extends string,
  C extends Columns,
  const Id extends StrKeys<C> | readonly StrKeys<C>[] = 'id' & StrKeys<C>,
  M extends string = never,
>(
  config: ModelConfig<T, C, Id, M>,
): ModelDefinition<{ table: T; columns: C; id: Id; modifiers: M }>;
export function defineModel(config: RuntimeConfig): object {
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

  if (!isModelClass(base)) {
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

  const tableName = table;

  // Computed property name gives the class (and stack traces) a proper name.
  // Class fields define own properties: assignments would invoke inherited setters
  // or throw on the getter-only statics commonly used by classic models/plugins.
  const modelClass: ModelClass = { [className]: class extends base {
    static tableName = tableName;
    static idColumn = id;
    // SAFETY: objection passes modifiers its query builder, which typed modifiers see through
    // `Query`. It treats `null` like no modifiers.
    static modifiers = modifiers as Modifiers;
    static jsonAttributes = cols.filter(it => it.json).map(it => it.prop);
    static createValidator = validate
      ? () => new StandardSchemaValidator({ columns: cols })
      : () => new StandardSchemaValidator({ columns: [] });
  } }[className];

  // SAFETY: the values are hook functions; names that aren't hooks throw below.
  const hookFns = hooks as Record<string, Hook>;

  for (const hookName of Object.keys(hookFns)) {
    if (!Object.hasOwn(HOOKS, hookName)) {
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

function createModelHandle(modelClass: ModelClass, meta: HandleMeta): RuntimeHandle {
  const handle = {
    name: meta.name,
    table: meta.table,
    idColumn: meta.idColumn,
    columns: meta.columns,
    modelClass,

    query(trx?: TransactionOrKnex) {
      return modelClass.query(trx);
    },

    relatedQuery(relationName: string, trx?: TransactionOrKnex) {
      return modelClass.relatedQuery(relationName, trx);
    },

    // Validates input exactly like an insert (or a patch with `{ patch: true }`)
    // would, without touching the database. Returns the parsed output.
    validate(json: object, options?: ModelOptions) {
      return new modelClass().$validate(Object.assign({}, json), options);
    },

    fromJson(json: object, options?: ModelOptions) {
      return modelClass.fromJson(json, options);
    },

    ref(prop: string) {
      return modelClass.ref(prop);
    },

    bindKnex(knex: TransactionOrKnex): RuntimeHandle {
      return createModelHandle(modelClass.bindKnex(knex), meta);
    },
  };

  Object.defineProperty(handle, 'isObjectionModelDefinition', { value: true });

  // SAFETY: `isObjectionModelDefinition` was defined just above (non-enumerable, read-only).
  return Object.freeze(handle) as RuntimeHandle;
}

/** Whether a value is a `defineModel()` definition (or a handle from `defineModels()`). */
export function isModelDefinition(value: unknown): value is AnyModelHandle {
  return isModelHandle(value);
}

// The same check, typed with the runtime shape.
export function isModelHandle(value: unknown): value is RuntimeHandle {
  // SAFETY: only read, and compared to `true`.
  return !!value && (value as { isObjectionModelDefinition?: unknown }).isObjectionModelDefinition === true;
}

// Typed handle around an existing (classic) model class.
export function classicModelHandle(modelClass: ModelClass): RuntimeHandle {
  return createModelHandle(modelClass, {
    name: modelClass.name,
    table: modelClass.getTableName(),
    idColumn: modelClass.getIdColumn(),
    columns: null,
  });
}

// Stryker disable Regex: splitting on single separators leaves empty parts, which are filtered out.
function toClassName(table: string): string {
  return table
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map(it => it[0].toUpperCase() + it.slice(1))
    .join('');
}
// Stryker restore Regex
