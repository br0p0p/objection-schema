// objection-schema: schema-first, class-free models for objection 3.x.
//
// Everything here is a *type-level view* over objection's existing runtime: a typed
// query is a regular objection `QueryBuilder` at runtime, which is what keeps the two
// APIs interoperable. The types never mention classes; rows are plain object types
// inferred from Standard Schema compliant column schemas.
//
// The functions are declared next to their implementations, as overloads that carry these
// types. Their implementation signatures return `object`: the typed views have phantom
// members (`'~types'`, `'~spec'`, ...) that don't exist at runtime. `index.ts` re-exports the
// public types by name, so the helpers that are exported here only for lib/ stay internal.
export {};
