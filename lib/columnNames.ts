import type { ColumnNameMappers, Pojo, QueryBuilder } from 'objection';
import type { ModelClass } from './objection';
import { snakeCaseMappers } from 'objection';

/** Property name -> column name, for the columns whose name differs from the property. */
export type ColumnMap = Readonly<Record<string, string>>;

/** The casing rules `defineModel({ columnNames })` accepts. */
export type Casing = 'snake_case';

/** A column as `createColumnMap` reads it: its property and its `.name()`, if any. */
interface NamedColumn {
  readonly prop: string;
  readonly name: string | null;
}

/** What the mapped query builder methods read from the builder they're called on. */
interface Builder {
  modelClass: () => ModelClass;
  tableRef: () => string;
}

/**
 * An argument of a query builder method: a column reference, a value, an array, a `where`
 * object, a raw, a query builder or a callback. Only references are mapped.
 */
type QueryArgument = string | number | boolean | bigint | symbol | object | null | undefined;

/** A query builder method. Each one returns the builder. */
type Method = (this: Builder, ...args: QueryArgument[]) => object;

/**
 * The static that holds a definition's `ColumnMap` on its model class. Statics are
 * inherited, so `bindKnex()` subclasses have it too. Other classes don't.
 */
export const COLUMN_MAP = Symbol('objection-schema columnMap');

// The same conversion as `knexSnakeCaseMappers()`, with objection's default options.
const snakeCase = snakeCaseMappers();

/**
 * The property -> column map of a definition, or `null` when no column is renamed.
 * Throws when two properties map to the same column, or when a column is named like
 * another property: objection passes column names to the query builder methods, which
 * would map such a name a second time.
 */
export function createColumnMap(
  owner: string,
  columns: readonly NamedColumn[],
  casing: Casing | null,
): ColumnMap | null {
  const propOfColumn = new Map<string, string>();
  const map: Record<string, string> = {};
  let renamed = false;

  for (const { prop, name } of columns) {
    const column = name || (casing ? Object.keys(snakeCase.format({ [prop]: null }))[0] : prop);
    const other = propOfColumn.get(column);

    if (other !== undefined) {
      throw new Error(`${owner}: columns "${other}" and "${prop}" both map to column "${column}"`);
    }

    propOfColumn.set(column, prop);

    if (column !== prop) {
      map[prop] = column;
      renamed = true;
    }
  }

  const props = new Set(columns.map(it => it.prop));

  for (const prop of Object.keys(map)) {
    if (props.has(map[prop])) {
      throw new Error(
        `${owner}: column "${prop}" maps to "${map[prop]}", the name of another column in \`columns\``,
      );
    }
  }

  return renamed ? map : null;
}

/** The column of a property in a map; names it doesn't know are column names already. */
export function toColumn(map: ColumnMap | null, prop: string): string {
  return map && Object.hasOwn(map, prop) ? map[prop] : prop;
}

/** The column of a property of any model class (classic classes have no map). */
export function columnOf(modelClass: ModelClass, prop: string): string {
  // SAFETY: only read. `COLUMN_MAP` is this module's own static: a map or `null` on
  // definitions, `undefined` on other classes.
  const map = (modelClass as { [COLUMN_MAP]?: ColumnMap | null })[COLUMN_MAP];

  return toColumn(map || null, prop);
}

/**
 * objection's per-model row conversion. Keys the map doesn't know (joined or aliased
 * columns) pass through unchanged.
 */
export function createColumnNameMappers(map: ColumnMap): ColumnNameMappers {
  const props: Record<string, string> = {};

  for (const prop of Object.keys(map)) {
    props[map[prop]] = prop;
  }

  return {
    parse: json => rename(json, props),
    format: json => rename(json, map),
  };
}

function rename(json: Pojo, names: ColumnMap): Pojo {
  const out: Pojo = {};

  for (const key of Object.keys(json)) {
    out[toColumn(names, key)] = json[key];
  }

  return out;
}

// The typed query methods (`Query` in types.ts) that take column references. The first
// argument of each is a reference, a composite (an array) or a `where` object.
const FIRST_ARGUMENT = [
  'where',
  'andWhere',
  'orWhere',
  'whereNot',
  'orWhereNot',
  'whereIn',
  'orWhereIn',
  'whereNotIn',
  'orWhereNotIn',
  'whereNull',
  'orWhereNull',
  'whereNotNull',
  'orWhereNotNull',
  'whereBetween',
  'whereNotBetween',
  'orderBy',
];

// Every argument of these is a reference (or an array of them).
const EVERY_ARGUMENT = ['select', 'groupBy', 'returning'];

/**
 * A query builder class whose typed methods take property names. It resolves `prop`,
 * `table.prop`, `relation.prop` and `relation:nested.prop` (joined tables), with an
 * optional `as alias`, to column names. Raw SQL, `ref()`, query builders and anything
 * else pass through, and so do names that aren't properties (objection's own calls
 * use column names).
 */
export function createQueryBuilder(Base: typeof QueryBuilder): typeof QueryBuilder {
  const ColumnNameQueryBuilder = class extends Base<any, any> {};
  const methods: Record<string, Method> = {};

  // SAFETY: the names below are methods of every objection query builder, and each returns
  // the builder. The prototype's own type only declares them as overloads.
  const base: Readonly<Record<string, Method>> = Base.prototype as never;

  for (const name of FIRST_ARGUMENT) {
    methods[name] = function (...args) {
      return base[name].apply(this, args.map((arg, i) => (i === 0 ? mapFirst(this, arg) : arg)));
    };
  }

  for (const name of EVERY_ARGUMENT) {
    methods[name] = function (...args) {
      return base[name].apply(this, args.map(arg => mapRefs(this, arg, true)));
    };
  }

  Object.assign(ColumnNameQueryBuilder.prototype, methods);

  return ColumnNameQueryBuilder;
}

function mapFirst(builder: Builder, arg: QueryArgument): QueryArgument {
  if (isPlainObject(arg)) {
    const out: Pojo = {};

    for (const key of Object.keys(arg)) {
      out[resolve(builder, key, false)] = arg[key];
    }

    return out;
  }

  return mapRefs(builder, arg, false);
}

function mapRefs(builder: Builder, arg: QueryArgument, select: boolean): QueryArgument {
  return Array.isArray(arg) ? arg.map(it => mapRef(builder, it, select)) : mapRef(builder, arg, select);
}

function mapRef(builder: Builder, ref: QueryArgument, select: boolean): QueryArgument {
  return typeof ref === 'string' ? resolve(builder, ref, select) : ref;
}

function resolve(builder: Builder, ref: string, select: boolean): string {
  // Where knex splits off an alias.
  const as = ref.toLowerCase().indexOf(' as ');

  if (as !== -1) {
    return resolve(builder, ref.slice(0, as), false) + ref.slice(as);
  }

  const dot = ref.lastIndexOf('.');

  if (dot === -1) {
    return columnOf(builder.modelClass(), ref);
  }

  const table = ref.slice(0, dot);
  const prop = ref.slice(dot + 1);
  const own = table === builder.tableRef();
  const modelClass = own ? builder.modelClass() : joinedModel(builder.modelClass(), table);
  const column = modelClass ? columnOf(modelClass, prop) : prop;

  // The query's model converts the result rows, and it only knows its own columns: a
  // renamed joined column is selected under its property name.
  return select && !own && column !== prop ? `${table}.${column} as ${prop}` : `${table}.${column}`;
}

// The model of a joined table alias (`pets`, `parent:pets`), as joinRelated / withGraphJoined name them.
function joinedModel(root: ModelClass, alias: string): ModelClass | null {
  let modelClass = root;

  for (const name of alias.split(':')) {
    const relations = modelClass.getRelations();

    if (!Object.hasOwn(relations, name)) {
      return null;
    }

    // SAFETY: objection's relations point to model classes, which have the statics `ModelClass` adds.
    modelClass = relations[name].relatedModelClass as ModelClass;
  }

  return modelClass;
}

function isPlainObject(value: QueryArgument): value is Pojo {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}
