'use strict';

// Helpers for working with Standard Schema (https://standardschema.dev) compliant
// validators such as zod, valibot, arktype and effect schema.

function isStandardSchema(value) {
  return (
    value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof value['~standard'] === 'object'
    && value['~standard'] !== null
    && typeof value['~standard'].validate === 'function'
  );
}

function validateSync(schema, value, prop) {
  const result = schema['~standard'].validate(value);

  // Objection's validation pipeline (`$validate`, `fromJson`, graph inserts...) is
  // synchronous, so async schemas (async refinements etc.) can't be supported here.
  if (result && typeof result.then === 'function') {
    throw new Error(
      `the schema of column "${prop}" (${schema['~standard'].vendor}) validates asynchronously. `
      + 'Only synchronous Standard Schema validation is supported.',
    );
  }

  return result;
}

// A schema that only carries a type. It accepts everything at runtime.
const UNCHECKED = Object.freeze({
  '~standard': Object.freeze({
    version: 1,
    vendor: 'objection',
    validate: value => ({ value }),
  }),
});

function unchecked() {
  return UNCHECKED;
}

module.exports = {
  isStandardSchema,
  validateSync,
  unchecked,
  UNCHECKED,
};
