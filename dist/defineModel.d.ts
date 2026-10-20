import type { ModelOptions, Pojo, QueryBuilder, ReferenceBuilder, TransactionOrKnex } from 'objection';
import type { ColumnMeta } from "./column.js";
import type { ModelClass } from "./objection.js";
import type { AnyModelHandle, Columns, ModelConfig, ModelDefinition, StrKeys } from "./types.js";
type ModelInstance = InstanceType<ModelClass>;
interface HandleMeta {
    readonly name: string;
    readonly table: string;
    readonly idColumn: ModelClass['idColumn'];
    readonly columns: Readonly<Record<string, {
        readonly '~column'?: ColumnMeta;
    }>> | null;
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
export declare function defineModel<const T extends string, C extends Columns, const Id extends StrKeys<C> | readonly StrKeys<C>[] = 'id' & StrKeys<C>, M extends string = never>(config: ModelConfig<T, C, Id, M>): ModelDefinition<{
    table: T;
    columns: C;
    id: Id;
    modifiers: M;
}>;
/** Whether a value is a `defineModel()` definition (or a handle from `defineModels()`). */
export declare function isModelDefinition(value: unknown): value is AnyModelHandle;
export declare function isModelHandle(value: unknown): value is RuntimeHandle;
export declare function classicModelHandle(modelClass: ModelClass): RuntimeHandle;
export {};
