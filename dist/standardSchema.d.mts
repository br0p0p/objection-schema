import type { StandardSchemaV1 } from "./types.mjs";
export declare function isStandardSchema(value: unknown): value is StandardSchemaV1;
export declare function validateSync(schema: StandardSchemaV1, value: unknown, prop: string): StandardSchemaV1.Result<unknown>;
export declare const UNCHECKED: StandardSchemaV1;
/** A column that only carries a type. Nothing is validated at runtime. */
export declare function unchecked<T>(): StandardSchemaV1<T, T>;
