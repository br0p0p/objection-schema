# Vendored anti-slop

- Source: <https://github.com/dmmulroy/anti-slop>
- Revision: `13909c9e07590f5a85d93c62712259fe14a883f7`
- Copied from: `skills/install-anti-slop/assets/anti-slop/` at that revision, using its
  `scripts/install.mjs`. These assets match the production source under `src/` (without tests).
- Installed at: `tools/oxlint/anti-slop/`, including the generic and optional Effect entry points,
  shared helpers, and `vendor/eslint-stylistic/` with its original license and provenance.
- Dependencies: `oxlint` and `@oxlint/plugins`, both pinned to `1.89.0`.

## Local additions and configuration

The copied source is unchanged. Added this provenance file, the upstream root MIT `LICENSE`,
and a private `package.json` with `type: module` so Node loads the TypeScript plugin as ESM
without changing this repository's CommonJS runtime.

`.oxlintrc.json` enables 14 generic anti-slop rules and the native
`oxc/no-accumulating-spread` companion at error severity. The `no-runtime-typeof` rule is
intentionally off by project policy: runtime type checks are legitimate in this validation
library and its tests. At the user's request, `no-object-parameters`, `no-unknown-parameters`,
and `no-unsafe-dictionary-type` are also off for now, preserving broad public type contracts.
Revisit those three rules only with an explicit policy/API review. All other generic rules
remain enabled. Effect rules are not enabled because this repository has no direct Effect
dependency. Default Oxlint correctness rules are off:
ESLint continues to own the existing lint rules and formatting. Agent assets, generated outputs,
and this vendor directory are excluded; ESLint also excludes the vendor directory to preserve
its original source for future updates.

Run `pnpm run lint:anti-slop`. This remains separate from `lint`, `check`, and CI.
The four disabled anti-slop rules are documented above. Installation and subsequent safe cleanup
preserve runtime behavior and public type contracts.

Initial scan: 291 errors across 28 scanned files (259 spacing, 18 runtime `typeof`, 7 symbol
names containing `shape`, 4 object parameters, and one each for conditional empty-object spread,
unknown parameters, and unsafe dictionary types). This is an installation baseline, not an
allowlist: the command exits nonzero until findings are resolved or policy is deliberately
adapted. Some policies conflict with this library's boundary validation and public type APIs;
review those before attempting a migration. Spacing changes to the typings also require updating
the exact-text mutation patterns in `scripts/mutate-types.js`.

## Cleanup and verification

Applied the spacing autofix, renamed the property-test column contract registry, and replaced
its conditional empty-object spread with explicit accumulation of locally owned relation
mappings. ESLint remains the formatter. This resolves 267 findings and leaves 24 errors:
18 runtime `typeof` uses in boundary validation and tests, 4 broad object parameters, 1 unknown
parameter required by Standard Schema, and 1 unknown-valued relation-extra dictionary. These
remaining contracts are intentional compatibility/boundary concerns, not safe mechanical fixes.
No rules were disabled during that cleanup and no runtime/API behavior was changed.

Following explicit policy review, disabled `no-runtime-typeof` instead of rewriting legitimate
runtime checks. That left 6 errors: 4 broad object parameters, 1 unknown parameter,
and 1 unknown-valued relation-extra dictionary. Subsequently, the user requested disabling the
three rules responsible for those remaining findings for now. The configured audit now passes
with zero warnings and errors. The plugin source and all other rule severities remain unchanged.

The full `pnpm run check` passes; all 22 curated type mutants are caught, and the runtime
mutation score remains 100%. Exact-text type mutation patterns still match after formatting.

## Updates

Stage the desired upstream revision separately and compare it against this exact source revision
before merging. Preserve local configuration and additions; do not overwrite this directory or
enable new rules without reviewing their policy. Keep both Oxlint dependency versions in sync.
