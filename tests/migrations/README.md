# Real application migration probes

These are small, independently written model/query slices based on public apps, not
vendored applications or claims that their entire servers have been migrated. Sources
are pinned so the experiments can be reproduced without chasing moving branches.
The tests run offline against this package and Objection 3, using the normal runtime
suite's database configuration (sqlite by default).

## Sources inspected

| App | Pinned revision | Original ORM | Why it is useful |
| --- | --- | --- | --- |
| [Wiki.js](https://github.com/requarks/wiki/tree/1161ddc6e6f4388a15d90278d55b099248ce6e79), release v2.5.315 | `1161ddc6e6f4388a15d90278d55b099248ce6e79` | Objection `2.2.18` | A deployed knowledge-base app: string setting keys, JSON values outside `jsonSchema`, timestamp hooks, groups/users many-to-many. |
| [Micro/Objection RealWorld (Conduit)](https://github.com/paulogdm/micro-objection-realworld-example-app/tree/146e9c5dfff69f70dce769fcb7a6cd2dfe6e37cb) | `146e9c5dfff69f70dce769fcb7a6cd2dfe6e37cb` | Objection `^1.2.2` | A reference application, not evidence of production usage: article feed, author/tag graphs, composite favorite keys, correlated counts and custom response serialization. |

Wiki.js model sources:
[settings.js](https://github.com/requarks/wiki/blob/1161ddc6e6f4388a15d90278d55b099248ce6e79/server/models/settings.js),
[groups.js](https://github.com/requarks/wiki/blob/1161ddc6e6f4388a15d90278d55b099248ce6e79/server/models/groups.js),
[users.js](https://github.com/requarks/wiki/blob/1161ddc6e6f4388a15d90278d55b099248ce6e79/server/models/users.js),
[package.json](https://github.com/requarks/wiki/blob/1161ddc6e6f4388a15d90278d55b099248ce6e79/package.json).

Conduit model sources:
[Article.js](https://github.com/paulogdm/micro-objection-realworld-example-app/blob/146e9c5dfff69f70dce769fcb7a6cd2dfe6e37cb/src/models/Article.js),
[User.js](https://github.com/paulogdm/micro-objection-realworld-example-app/blob/146e9c5dfff69f70dce769fcb7a6cd2dfe6e37cb/src/models/User.js),
[Tag.js](https://github.com/paulogdm/micro-objection-realworld-example-app/blob/146e9c5dfff69f70dce769fcb7a6cd2dfe6e37cb/src/models/Tag.js),
[Favorite.js](https://github.com/paulogdm/micro-objection-realworld-example-app/blob/146e9c5dfff69f70dce769fcb7a6cd2dfe6e37cb/src/models/Favorite.js),
[package.json](https://github.com/paulogdm/micro-objection-realworld-example-app/blob/146e9c5dfff69f70dce769fcb7a6cd2dfe6e37cb/package.json).

Upstream licenses: Wiki.js AGPL-3.0; Conduit MIT. No upstream source files are
vendored here. Test fixtures describe a deliberately reduced behavior contract.

## Migration attempted

`tests/runtime/app-migrations.test.js` implements five vertical slices:

1. **Wiki settings:** preserve a getter-based class via `base`, declare `id: 'key'`,
   declare the JSON value explicitly, then insert/fetch/patch nested and scalar JSON.
2. **Wiki groups:** replace the base's getter-based relation mapping with a typed
   many-to-many declaration, keep classic users and inherited timestamp hooks, insert
   a graph, compare its fetched JSON with a classic read, unrelate and bind knex.
3. **Conduit feed:** migrate article/user/tag/favorite definitions, insert an article
   graph, add/delete a favorite by composite ID, query correlated count/favorite state,
   and serialize tags as strings while excluding the stored password hash.
4. **Conduit edits:** exercise nullable values, schema defaults, partial updates,
   inherited update timestamps and invalid slug rejection without changing the row.
5. **Conduit publishing:** roll back a user and article when a nested tag is invalid.

`tests/types/typed.ts` also checks getter-based bases, string/composite IDs, required
insert fields, nullable author graphs, favorite collections and the aggregate escape hatch.

Adaptations are intentional:

- Upgrade to Objection 3 first; these apps' original ORM releases are not supported peers.
- Conduit's Objection 1 `namedFilters` become `modifiers` / explicit subqueries.
- Aggregates and expression selections use `toQueryBuilder`; they aren't a new typed API.
- JSON attributes omitted from a legacy `jsonSchema` still need explicit schema columns.
- Fixtures use minimal portable tables, deterministic timestamps and no web/auth services.
  Wiki users stay classic to demonstrate incremental adoption; no password hashing is simulated.
- Existing instance hooks and `$formatJson` stay on the base class. This is an incremental
  migration, not a claim that all existing class behavior can become configuration.
- Redeclaring relations replaces the inherited mapping; it does not merge legacy mappings.

## Bugs reproduced and fixed

### 1. Getter-only model statics block incremental adoption

Both apps declare `static get tableName()`. Wiki settings also use getter-only
`idColumn` / `jsonAttributes`; Conduit favorites use getter-only composite `idColumn`.

Before the fix, `defineModel({ base: ExistingModel, ... })` threw:

```text
TypeError: Cannot set property tableName ... which has only a getter
```

The generated subclass assigned static properties after construction. Assignment
cannot shadow an inherited getter-only property. Generated static class fields now
define own properties, preserving the original class, hooks and serializers. A focused
feature test covers `modifiers` and `createValidator` accessors as well.

### 2. Getter-only relation mappings block registry creation

After fixing model creation, Wiki group migration still threw the same kind of error
for `relationMappings` during `defineModels`. Registry mappings now get an own data
property on the generated subclass, keeping normal static-field descriptors and leaving
the original class's relations untouched.

Observed progression: all five slices failed before fixes; after the first fix,
Wiki registration exposed the second failure; all five pass after both fixes and the
feed query's explicit join-column qualification.

The feed qualification (`favorites.userId`) is a query adaptation, not a library bug:
Objection aliases the related users table as `favoritedBy` in a correlated subquery.

## Reproduce

```bash
pnpm run build
pnpm exec mocha tests/runtime/app-migrations.test.js
pnpm run test:types
pnpm run check
```

For a separate networked smoke test against **unmodified upstream source files**:

```bash
pnpm run build
node scripts/probe-upstream-migrations.js
```

This downloads the pinned Wiki.js `Group` and Conduit `Favorite` classes to
`node_modules/.cache`, then uses them directly as bases on Objection 3. It asserts
Wiki group JSON, real timestamp hooks and graph insert/fetch with a replacement
relation mapping; and Conduit composite-key insert/find/delete. Both passed on sqlite.
It doesn't install or boot either application's server. Network access and trust in the
two pinned source files are required; the ordinary test suite does not download code.

Validation: `pnpm run check` passed (lint, 104 runtime tests on sqlite, both type
configurations and package exports; five existing database-specific skips).
Targeted mutation testing of `defineModel.ts` / `defineModels.ts` scored 100% with
no surviving mutants; all 22 curated type mutants were caught. The separate
`lint:anti-slop` check passed too. Two pre-existing Claude workflow formatting
findings (quoting/trailing blank lines only) were normalized to unblock lint.

These probes do **not** establish end-to-end application compatibility, HTTP response
schema typing, password/auth correctness, concurrency behavior or production migration
safety. The initial run used in-memory sqlite; Postgres/MySQL support is exercised by
running the same suite with the project's existing `DB` configuration, not inferred
from a sqlite pass.

Good next slices: Wiki user password hooks and page history/revisions; Conduit self-join
followers, comment deletion authorization and custom join-model lifecycle behavior.
The latter needs special care: the new relation builder accepts a join table, not a
custom `through.modelClass`.
