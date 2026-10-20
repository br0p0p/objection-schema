// The ES module build has no default export, so its declarations mustn't allow a default import
// (they would if `import` resolved to the CommonJS declarations, as `module.exports`).

// @ts-expect-error no default export
import objectionSchema from 'objection-schema';

export const value: unknown = objectionSchema;
