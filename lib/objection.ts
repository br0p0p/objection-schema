// objection exports and uses these at runtime (in its lib/objection.js and lib/model/Model.js),
// but its typings don't declare them.
import type { RelationType } from 'objection';
import * as objection from 'objection';

/** A model class with the static methods objection's typings leave out. */
export type ModelClass = typeof objection.Model & {
  getTableName: () => string;
  getIdColumn: () => string | string[];
  uniqueTag: () => string;
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
 * Whether objection has read (and cached) this class's own relations. objection's `cachedGet`
 * (lib/model/Model.js) stores `getRelationMappings()` as an own `$$relationMappings` the first time
 * it's called, and every relation lookup goes through it (`getRelationNames()` included), so a
 * `relationMappings` set afterwards is never read. If objection renames the property, this
 * returns false and the check that uses it stops firing, but nothing else changes.
 */
export function haveRelationsBeenRead(modelClass: ModelClass): boolean {
  return Object.hasOwn(modelClass, '$$relationMappings');
}
