import type { RelationType } from 'objection';
import * as objection from 'objection';
/** A model class with the static methods objection's typings leave out. */
export type ModelClass = typeof objection.Model & {
    getTableName: () => string;
    getIdColumn: () => string | string[];
};
export declare const Model: typeof objection.Model & {
    getTableName: () => string;
    getIdColumn: () => string | string[];
}, ValidationError: typeof objection.ValidationError & {
    Type: {
        ModelValidation: "ModelValidation";
    };
}, BelongsToOneRelation: RelationType, HasManyRelation: RelationType, HasOneRelation: RelationType, HasOneThroughRelation: RelationType, ManyToManyRelation: RelationType;
export declare function isModelClass(value: unknown): value is ModelClass;
