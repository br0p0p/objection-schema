# Working on objection-schema

Schema-first, class-free models for objection.js 3.x. Users declare columns as Standard Schema
validators (zod, valibot, …), and `defineModel` / `defineModels` generate ordinary objection
`Model` subclasses at runtime, while hand-written typings infer row, insert, patch, relation and
query types from the same schemas. The README is the user-facing spec. This file covers how to
change the code without breaking it.

## Setup

```bash
mise install   # Node and pnpm, versions pinned in mise.toml
pnpm install
```

To try another Node version without editing `mise.toml`:
`MISE_NODE_VERSION=18 mise exec -- pnpm test` (CI's Node matrix works the same way).

## Commands

| Command                                          | What it does                                                        | Time   |
| ------------------------------------------------ | ------------------------------------------------------------------- | ------ |
| `pnpm run check`                                 | lint (incl. formatting) + all tests. **Run before calling it done** | ~30 s  |
| `pnpm exec mocha tests/runtime/features.test.js` | one runtime test file (add `-g "<pattern>"` to filter)              | ~2 s   |
| `pnpm run test:runtime`                          | all runtime tests (CJS + ESM, in-memory sqlite)                     | ~3 s   |
| `pnpm run test:types`                            | type tests, node10 + nodenext configs (incremental)                 | 5–16 s |
| `pnpm run lint` / `pnpm run lint:fix`            | eslint, which is also the formatter; warnings fail too              | ~5 s   |
| `pnpm run test:mutations -- --mutate lib/x.js`   | Stryker on one file (add `--incremental` to reuse results)          | <1 min |
| `pnpm run test:mutations`                        | Stryker on all of `lib/`, must stay at 100%                         | ~2 min |
| `pnpm run test:mutations:types`                  | curated mutants of the typings, all must be caught                  | ~2 min |
| `pnpm run test:objection-versions [3.0.0 3.5.0]` | runtime + types against several objection 3.x releases              | ~1 min |
| `FC_NUM_RUNS=1000 pnpm run test:properties`      | property tests with more runs                                       | varies |

`pnpm test` is runtime + types + package exports (attw). CI (`.github/workflows/`) runs lint,
`pnpm test` on Node 18/20/22, objection versions, and both mutation suites on pull requests.

## Layout

```
lib/                       the published runtime (CommonJS, plain JS, no build step)
  index.js                 public exports
  index.mjs                ESM entry: re-exports index.js (one instance, no dual package hazard)
  defineModel.js           config -> generated Model subclass + frozen handle; hooks; classic handles
  defineModels.js          registry, the three relation sources, merge rules, relationMappings
  column.js                column() builder + metadata, references(), defineModelNames(),
                           required/default/optional probe
  StandardSchemaValidator.js  objection Validator: per-column validation, Ajv-style error keys
  standardSchema.js        Standard Schema helpers, sync-only guard, unchecked()
typings/index.d.ts         hand-written types for everything (≈1.4k lines, sectioned by `// ---`)
typings/index.d.mts        ESM types: `export * from './index.js'`
tests/runtime/             mocha + expect.js, in-memory sqlite. Files import 'objection-schema'
                           (self-reference through package exports), not relative paths.
  defineModel.test.js      main walkthrough       features.test.js  every option and error path
  properties.test.js       fast-check vs oracles  esm.test.mjs      ESM entry point
  exports.test.js          typings declare exactly the runtime exports
tests/types/               compiled, never run. typed.ts (main), cjs.cts / esm.mts (entry points)
scripts/                   objection version matrix, type mutation runner
bench/                     benchmarks (not part of the checks)
```

## Invariants

Breaking one of these breaks users or CI. Most are enforced mechanically, and the check that
catches each one is named here.

1. **Runtime and types describe the same behaviour.** A behaviour change in `lib/` needs the
   matching change in `typings/index.d.ts`, a runtime test and a type test. Examples: whether an
   insert field is required (runtime probes the schema with `undefined`, types use
   `undefined extends Input`); relation rules are both compile errors on `defineModels(...)` and
   runtime throws.
2. **The public surface is declared in three places**: `lib/index.js`, `lib/index.mjs` and
   `typings/index.d.ts`, and documented in the README. `exports.test.js` and `esm.test.mjs` fail if
   they drift.
3. **`lib/` runtime constraints** (enforced by `eslint.config.mjs`):
   - It runs on Node ≥ 14, because `engines` follows objection 3. CI only runs 18–22, so the lint is
     the only guard: no `Object.hasOwn`, `Array.prototype.at`, `??=`, `structuredClone`, … .
   - It may only `require('objection')` (the peer dependency) and its own files. Schema libraries
     come from users, so never require zod or valibot in `lib/`.
   - CommonJS with `'use strict'`. `index.mjs` only re-exports `./index.js`.
   - It uses only objection's public API, and validation is synchronous (objection's pipeline is).
4. **Mutation score is 100%** (Stryker `break: 100`). New `lib/` code needs tests that kill every
   mutant. Only a truly behaviour-equivalent mutant (e.g. a performance-only difference) may be
   disabled, in place and with a reason:
   `// Stryker disable next-line ConditionalExpression: <why it can't change behaviour>`.
   See the existing ones (`grep -rn "Stryker disable" lib`). Never disable a mutant to avoid
   writing a test.
5. **Type promises are mutation-tested too.** `scripts/mutate-types.js` holds find/replace mutants
   of the typings. A pattern that no longer matches is a failure, so when you refactor the
   typings, update the affected patterns. When you add an important type-level guarantee, add a
   mutant for it.
6. **Error messages are API.** Runtime errors start with the function name (`defineModels: …`,
   `references(): …`), name the definition sites, and are pinned by tests. Relation type errors
   are pinned through the exported `RelationErrors` type. Change them on purpose only, and update
   the tests.
7. **Rows read from the database are not validated.** This is by design (see README, "Known
   limitations"), so don't "fix" it.

## Making a change

1. Read the relevant `lib/` file and the matching `typings/index.d.ts` section.
2. Write the failing test first:
   - runtime: `tests/runtime/features.test.js` (or `defineModel.test.js` for core flows);
   - types: `tests/types/typed.ts`, with `expectType<Equal<A, B>>()` for exact types and
     `// @ts-expect-error <reason>` for expected errors;
   - for a rule with many input combinations, a property in `properties.test.js` against an
     independent oracle.
3. Implement, then run `pnpm run check`.
4. If `lib/` changed: `pnpm run test:mutations -- --mutate lib/<file>.js --incremental`.
   If the typings changed: `pnpm run test:mutations:types`.
5. If anything user-facing changed, update `README.md`.

## Gotchas

- **Don't run these two in parallel with anything else, and don't interrupt them.**
  `test:mutations:types` rewrites `typings/index.d.ts` in place, and `test:objection-versions`
  installs other objection versions (rewriting `package.json` and `pnpm-lock.yaml` while it runs).
  Both restore on exit, but after a crash check `git diff` and run
  `pnpm install --frozen-lockfile`. Stryker works in a sandbox (`.stryker-tmp/`) and is safe to
  run in parallel.
- `test:types` is incremental (`node_modules/.cache/tsc/`). If results look stale, delete that
  directory.
- The node10 type config resolves `objection-schema` through `paths` and checks library
  declarations (`skipLibCheck: false`, the slow one). The nodenext config resolves through
  package `exports`. objection 3.0.x needs `--skipLibCheck` (handled by the versions script).
- **ESLint is the linter and the formatter** (`@antfu/eslint-config`, stylistic rules on; there's
  no Prettier): single quotes, semicolons, 2-space indent, keys quoted only when needed.
  `pnpm run lint:fix` formats. It also lints and formats JSON (key order in `package.json` and
  tsconfigs), YAML and the code blocks in Markdown (mark an intentional fragment with
  `<!-- eslint-skip -->`); Markdown prose isn't reformatted. The overrides in `eslint.config.mjs`
  each say why they exist. They protect the invariants above, so don't flip one back to antfu's
  default to silence a finding. For example, `e18e/prefer-object-has-own` is off in `lib/`
  because `Object.hasOwn` needs Node 16.9, and the type-semantics rules are off for the typings.
  Scripts import `process` from `node:process`.
- **Reformatting the typings breaks type mutants.** `scripts/mutate-types.js` matches exact text of
  `typings/index.d.ts`. After a formatting change there, run `pnpm run test:mutations:types` and
  update the patterns it reports as `MISSING`.
- **pnpm only.** `devEngines` makes npm refuse to run in this repo (consumers installing the
  package with npm are unaffected). pnpm doesn't hoist, so every package a file `require`s must be
  in `package.json` itself, even if a dependency already pulls it in. Dependency build scripts
  only run for packages listed under `allowBuilds` in `pnpm-workspace.yaml` (just `sqlite3`); a
  new dependency that needs one fails the install until it's added there.
- If `sqlite3` fails to build (old node-gyp vs Python ≥ 3.12): `pnpm install --ignore-scripts`,
  then `cd node_modules/sqlite3 && pnpm dlx node-gyp@latest rebuild`.
- Stryker reports land in `reports/mutation/index.html` (gitignored). Survivors are listed in the
  clear-text output too.
