# Working on objection-schema

Schema-first, class-free models for objection.js 3.x. Users declare columns as Standard Schema
validators (zod, valibot, …), and `defineModel` / `defineModels` generate ordinary objection
`Model` subclasses at runtime, while hand-written type-level code infers row, insert, patch,
relation and query types from the same schemas. It's written in TypeScript and built with `tsc`. The README is the user-facing spec. This file covers how to
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
| `pnpm run check`                                 | lint (incl. formatting) + all tests. **Run before calling it done** | ~40 s  |
| `pnpm run build`                                 | `tsc`: lib/ → dist/ (JS + declarations); the tests run on dist/     | ~3 s   |
| `pnpm exec mocha tests/runtime/features.test.js` | one runtime test file, on the last build (add `-g "<pattern>"`)     | ~2 s   |
| `pnpm run test:runtime`                          | build, then all runtime tests (CJS + ESM, in-memory sqlite)         | ~6 s   |
| `pnpm run test:pg` / `pnpm run test:mysql`       | the runtime tests on a running Postgres / MySQL (see `db.js`)       | ~5 s   |
| `pnpm run test:pack`                             | the packed package installed with npm in a fresh app, CJS/ESM/TS    | ~20 s  |
| `pnpm run test:types`                            | build, then type tests, node10 + nodenext configs (incremental)     | 8–19 s |
| `pnpm run lint` / `pnpm run lint:fix`            | eslint, which is also the formatter; warnings fail too              | ~5 s   |
| `pnpm run test:mutations -- --mutate lib/x.ts`   | Stryker on one file (add `--incremental` to reuse results)          | <1 min |
| `pnpm run test:mutations`                        | Stryker on all of `lib/`, must stay at 100%                         | ~2 min |
| `pnpm run test:mutations:types`                  | curated mutants of the typings, all must be caught                  | ~2 min |
| `pnpm run test:objection-versions [3.0.0 3.5.0]` | runtime + types against several objection 3.x releases              | ~1 min |
| `FC_NUM_RUNS=1000 pnpm run test:properties`      | property tests with more runs                                       | varies |

`pnpm test` builds once, then runs runtime + types + package exports (attw). `test:runtime`,
`test:types` and `test:package` each build first too, so none of them tests a stale `dist/`; the
`…:built` variants and a bare `pnpm exec mocha` don't, so run `pnpm run build` after editing `lib/`.

CI (`.github/workflows/`) runs lint, `pnpm test` on Node 18/20/22/24, the runtime tests on
Postgres and MySQL, `test:pack`, objection versions, and both mutation suites on pull requests.

Releases: push a `v<version>` tag matching `package.json`; `release.yml` runs the checks and
attaches the packed package to a GitHub release, which is how it's installed (the git repo has no
`dist/`).

## Layout

```
lib/                       the source (TypeScript), built into dist/ (gitignored, published)
  index.ts                 public exports: the values, and the public types by name
  index.mts                ESM entry: re-exports index.js (one instance, no dual package hazard)
  types.ts                 the type-level API (≈1.4k lines, sectioned by `// ---`); no runtime code
  defineModel.ts           config -> generated Model subclass + frozen handle; hooks; classic handles
  defineModels.ts          registry, the three relation sources, merge rules, relationMappings
  column.ts                column() builder + metadata, references(), defineModelNames(),
                           required/default/optional probe
  StandardSchemaValidator.ts  objection Validator: per-column validation, Ajv-style error keys
  standardSchema.ts        Standard Schema helpers, sync-only guard, unchecked()
  objection.ts             what objection exports at runtime but its typings don't declare
tests/runtime/             mocha + expect.js. Files import 'objection-schema' (self-reference
                           through package exports), not relative paths, and connect through
                           db.js: in-memory sqlite, or DB=pg|mysql (it empties the database).
  defineModel.test.js      main walkthrough       features.test.js  every option and error path
  properties.test.js       fast-check vs oracles  esm.test.mjs      ESM entry point
  exports.test.js          the declarations declare exactly the runtime exports
  interop.test.js          objection APIs (instance queries, upserts, mappers, …), vs classic
  databases.test.js        real column types (bigint ids, decimals, JSON, timestamps, arrays)
tests/types/               compiled, never run. typed.ts (main), cjs.cts / esm.mts (entry points)
scripts/                   objection version matrix, type mutation runner, test-pack.js
bench/                     benchmarks (not part of the checks)
```

## Invariants

Breaking one of these breaks users or CI. Most are enforced mechanically, and the check that
catches each one is named here.

1. **Runtime and types describe the same behaviour.** A behaviour change in `lib/` needs the
   matching change in `lib/types.ts` (or a function's overloads), a runtime test and a type test. Examples: whether an
   insert field is required (runtime probes the schema with `undefined`, types use
   `undefined extends Input`); relation rules are both compile errors on `defineModels(...)` and
   runtime throws.
2. **The public surface is declared in two places**: `lib/index.ts` (values, and the public types
   by name) and `lib/index.mts`, and documented in the README. `exports.test.js` and `esm.test.mjs`
   fail if they drift. A type exported from `types.ts` isn't public until `index.ts` lists it.
3. **Public functions are overloads over an internal implementation.** The overload carries the
   public type from `types.ts`; the implementation signature takes `unknown` or a runtime type
   (`RuntimeConfig`, `RuntimeHandle`, …) and returns `object`, because the public types have
   phantom members (`'~types'`, `'~spec'`) that don't exist at runtime. Internal callers can't call
   an implementation signature, so shared logic lives in a separate function (`createColumn`,
   `isModelHandle`). Each type assertion has a `// SAFETY:` comment with the invariant it relies on
   (`pnpm run lint:anti-slop` checks), and objection's undeclared runtime exports come from
   `lib/objection.ts`.
4. **`lib/` runtime constraints** (enforced by `eslint.config.mjs` and `tsconfig.json`):
   - It runs on Node ≥ 18 (`engines`), and CI tests 18–24. The lint flags built-ins newer than
     that (eslint-plugin-n reads `engines`), and `tsc` targets es2022 (what Node 18 runs as is),
     with `lib: ["es2022"]`.
   - It may only import `objection` (the peer dependency) and its own files; type-only imports
     (`knex` types) are erased. Schema libraries come from users, so never import zod or valibot
     in `lib/`.
   - It's built as CommonJS. `index.mts` only re-exports `./index.js`.
   - It uses only objection's public API, and validation is synchronous (objection's pipeline is).
5. **Mutation score is 100%** (Stryker `break: 100`). New `lib/` code needs tests that kill every
   mutant. Only a truly behaviour-equivalent mutant (e.g. a performance-only difference) may be
   disabled, in place and with a reason:
   `// Stryker disable next-line ConditionalExpression: <why it can't change behaviour>`.
   See the existing ones (`grep -rn "Stryker disable" lib`). Never disable a mutant to avoid
   writing a test.
6. **Type promises are mutation-tested too.** `scripts/mutate-types.js` holds find/replace mutants
   of the typings, and builds each one before running the type tests. A pattern that no longer
   matches is a failure, so when you refactor the typings, update the affected patterns. When you
   add an important type-level guarantee, add a mutant for it.
7. **Error messages are API.** Runtime errors start with the function name (`defineModels: …`,
   `references(): …`), name the definition sites, and are pinned by tests. Relation type errors
   are pinned through the exported `RelationErrors` type. Change them on purpose only, and update
   the tests.
8. **Rows read from the database are not validated.** This is by design (see README, "Known
   limitations"), so don't "fix" it.

## Making a change

1. Read the relevant `lib/` file and the matching `lib/types.ts` section.
2. Write the failing test first:
   - runtime: `tests/runtime/features.test.js` (or `defineModel.test.js` for core flows);
   - types: `tests/types/typed.ts`, with `expectType<Equal<A, B>>()` for exact types and
     `// @ts-expect-error <reason>` for expected errors;
   - for a rule with many input combinations, a property in `properties.test.js` against an
     independent oracle.
3. Implement, then run `pnpm run check`.
4. If `lib/` changed: `pnpm run test:mutations -- --mutate lib/<file>.ts --incremental`.
   If the typings changed: `pnpm run test:mutations:types`.
5. If anything user-facing changed, update `README.md`.

## Gotchas

- **Don't run these two in parallel with anything else, and don't interrupt them.**
  `test:mutations:types` rewrites `lib/types.ts` (and `dist/`) in place, and `test:objection-versions`
  installs other objection versions (rewriting `package.json` and `pnpm-lock.yaml` while it runs).
  Both restore on exit, but after a crash check `git diff`, run
  `pnpm install --frozen-lockfile` and rebuild. Stryker works in a sandbox (`.stryker-tmp/`) and is safe to
  run in parallel.
- `test:types` is incremental (`node_modules/.cache/tsc/`). If results look stale, delete that
  directory.
- The type tests check the built declarations in `dist/`, which is what users get. The node10
  config resolves `objection-schema` through `paths` (to `dist/index.d.ts`) and checks library
  declarations (`skipLibCheck: false`, the slow one). The nodenext config resolves through
  package `exports`. objection 3.0.x needs `--skipLibCheck` (handled by the versions script).
- **ESLint is the linter and the formatter** (`@antfu/eslint-config`, stylistic rules on; there's
  no Prettier): single quotes, semicolons, 2-space indent, keys quoted only when needed.
  `pnpm run lint:fix` formats. It also lints and formats JSON (key order in `package.json` and
  tsconfigs), YAML and the code blocks in Markdown (mark an intentional fragment with
  `<!-- eslint-skip -->`); Markdown prose isn't reformatted. The overrides in `eslint.config.mjs`
  each say why they exist. They protect the invariants above, so don't flip one back to antfu's
  default to silence a finding. For example, the type-semantics rules (`method-signature-style`,
  …) are off for the TypeScript in `lib/`.
  Scripts import `process` from `node:process`.
- **Reformatting the typings breaks type mutants.** `scripts/mutate-types.js` matches exact text of
  `lib/types.ts`. After a formatting change there, run `pnpm run test:mutations:types` and
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
