// ES module entry point. It re-exports the CommonJS implementation instead of being a
// second copy of it, so code that both `import`s and `require`s objection-schema shares
// one instance (no dual package hazard). objection 3.x is CommonJS either way.
import objectionSchema from './index.js';

export const {
  defineModel,
  defineModels,
  relations,
  column,
  defineModelNames,
  unchecked,
  toQueryBuilder,
  isModelDefinition,
  StandardSchemaValidator,
} = objectionSchema;
