import type { Pojo, ValidatorArgs } from 'objection';
import type { StandardSchemaV1 } from "./types.mjs";
import { Validator } from 'objection';
/** A column as the validator sees it (see `normalizeColumns`). */
export interface ValidatedColumn {
    readonly prop: string;
    readonly schema: StandardSchemaV1;
    readonly generated: boolean;
    readonly hasDefault: boolean;
    readonly undefinedMode: 'required' | 'optional' | 'default';
}
export declare class StandardSchemaValidator extends Validator {
    private readonly columns;
    constructor({ columns }: {
        columns: readonly ValidatedColumn[];
    });
    validate({ model, json, options }: ValidatorArgs): Pojo;
}
