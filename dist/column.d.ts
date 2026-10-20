import type { ValidatedColumn } from "./StandardSchemaValidator.js";
import type { Column, DefaultFlags, ReferenceOptions, StandardSchemaV1 } from "./types.js";
/** The metadata of a `column()` at runtime. */
export interface ColumnMeta {
    readonly generated: boolean;
    readonly hasDefault: boolean;
    readonly json: boolean;
    readonly references: Reference | null;
}
/** A `references()` foreign key at runtime. */
export interface Reference {
    readonly target: string;
    readonly column: string;
    readonly as: string | null;
    readonly inverse: string | null;
    readonly inverseKind: 'many' | 'one';
}
/** A `column()` at runtime. `Column` is its typed view. */
export interface RuntimeColumn {
    readonly '~column': ColumnMeta;
    readonly schema: StandardSchemaV1;
    generated: () => RuntimeColumn;
    hasDefault: () => RuntimeColumn;
    json: () => RuntimeColumn;
    references: (target: string, column: string, options?: ReferenceOptions) => RuntimeColumn;
}
export interface NormalizedColumn extends ValidatedColumn {
    readonly json: boolean;
}
export declare function column<S extends StandardSchemaV1>(schema: S): Column<S>;
/**
 * Declares the registry's model names up front, so `references()` targets are checked
 * (and autocompleted) where they're written. They can't be derived from the registry:
 * its type depends on the columns, which would make TypeScript type the models as `any`.
 *
 * ```ts
 * export const { column } = defineModelNames('Person', 'Animal');
 * ```
 */
export declare function defineModelNames<const N extends readonly [string, ...string[]]>(...names: N): {
    readonly names: N;
    column<S extends StandardSchemaV1>(schema: S): Column<S, DefaultFlags, null, N[number]>;
};
export declare function isColumn(value: unknown): value is RuntimeColumn;
export declare function normalizeColumns(columns: unknown): NormalizedColumn[];
