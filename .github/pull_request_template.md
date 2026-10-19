## What and why

<!-- What changes for users of objection-schema, and why. -->

## Checklist

- [ ] `pnpm run check` passes (format, lint, runtime + type + package tests)
- [ ] Behaviour changes are reflected in both `lib/` and `typings/index.d.ts`, with runtime and type tests
- [ ] `lib/` changes: mutation score still 100% (`pnpm run test:mutations`); any disabled mutant has a reason
- [ ] Typings changes: `pnpm run test:mutations:types` passes; new type guarantees have a mutant
- [ ] README updated if anything user-facing changed
