import * as objection from 'objection';
// SAFETY: every member of `Undeclared` exists at runtime in objection 3.x.
const undeclared = objection;
export const { Model, ValidationError, BelongsToOneRelation, HasManyRelation, HasOneRelation, HasOneThroughRelation, ManyToManyRelation, } = undeclared;
export function isModelClass(value) {
    // SAFETY: only read. `isObjectionModelClass` is objection's own (undeclared) brand of model classes.
    return !!value && !!value.isObjectionModelClass;
}
