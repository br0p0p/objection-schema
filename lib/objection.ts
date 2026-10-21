// objection exports and uses these at runtime (in its lib/objection.js and lib/model/Model.js),
// but its typings don't declare them.
import type { RelationType } from 'objection';
import * as objection from 'objection';

/** A model class with the static methods objection's typings leave out. */
export type ModelClass = typeof objection.Model & {
  getTableName: () => string;
  getIdColumn: () => string | string[];
};

interface Undeclared {
  Model: ModelClass;
  ValidationError: { Type: { ModelValidation: 'ModelValidation' } };
  BelongsToOneRelation: RelationType;
  HasManyRelation: RelationType;
  HasOneRelation: RelationType;
  HasOneThroughRelation: RelationType;
  ManyToManyRelation: RelationType;
}

// SAFETY: every member of `Undeclared` exists at runtime in objection 3.x.
const undeclared = objection as typeof objection & Undeclared;

export const {
  Model,
  ValidationError,
  BelongsToOneRelation,
  HasManyRelation,
  HasOneRelation,
  HasOneThroughRelation,
  ManyToManyRelation,
} = undeclared;

export function isModelClass(value: unknown): value is ModelClass {
  // SAFETY: only read. `isObjectionModelClass` is objection's own (undeclared) brand of model classes.
  return !!value && !!(value as { isObjectionModelClass?: boolean }).isObjectionModelClass;
}

/**
 * Whether a value written to the database is a query value: `raw()`, `ref()`, `fn()`, `val()`, a
 * knex raw or query builder, or an objection query builder, which objection turns into SQL. It's
 * objection's `isQueryProp` (lib/model/modelQueryProps.js), which isn't exported. Only for
 * non-null values.
 */
export function isQueryValue(value: {}): boolean {
  // SAFETY: only read. Each kind of query value has one of these, and app values don't.
  const candidate = value as {
    toKnexRaw?: unknown;
    toSQL?: unknown;
    isObjectionQueryBuilderBase?: unknown;
  };

  return (
    typeof candidate.toKnexRaw === 'function'
    || typeof candidate.toSQL === 'function'
    || candidate.isObjectionQueryBuilderBase === true
  );
}
