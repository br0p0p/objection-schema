// Helpers for working with Standard Schema (https://standardschema.dev) compliant
// validators such as zod, valibot, arktype and effect schema.

import type { StandardSchemaV1 } from './types';

export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  // SAFETY: only read, and every property is checked before it's relied on.
  const candidate = value as { '~standard'?: { validate?: unknown } | null } | null;

  return (
    candidate !== null
    && (typeof candidate === 'object' || typeof candidate === 'function')
    && typeof candidate['~standard'] === 'object'
    && candidate['~standard'] !== null
    && typeof candidate['~standard'].validate === 'function'
  );
}

export function validateSync(
  schema: StandardSchemaV1,
  value: unknown,
  prop: string,
): StandardSchemaV1.Result<unknown> {
  const result = schema['~standard'].validate(value);

  // Objection's validation pipeline (`$validate`, `fromJson`, graph inserts...) is
  // synchronous, so async schemas (async refinements etc.) can't be supported here.
  // SAFETY: `then` is only read to tell a promise from a result.
  if (result && typeof (result as Partial<PromiseLike<unknown>>).then === 'function') {
    throw new Error(
      `the schema of column "${prop}" (${schema['~standard'].vendor}) validates asynchronously. `
      + 'Only synchronous Standard Schema validation is supported.',
    );
  }

  // SAFETY: the check above throws for anything thenable, which includes every promise.
  return result as StandardSchemaV1.Result<unknown>;
}

// A schema that only carries a type. It accepts everything at runtime.
export const UNCHECKED: StandardSchemaV1 = Object.freeze({
  '~standard': Object.freeze({
    version: 1,
    vendor: 'objection',
    validate: (value: unknown) => ({ value }),
  }),
});

/** A column that only carries a type. Nothing is validated at runtime. */
export function unchecked<T>(): StandardSchemaV1<T, T>;
export function unchecked(): StandardSchemaV1 {
  return UNCHECKED;
}
