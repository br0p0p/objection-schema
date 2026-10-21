'use strict';

const { execSync } = require('node:child_process');

// Mutation testing for the type declarations, which Stryker can't mutate. Each mutant
// breaks one promise of the types; the type tests must fail for every one of them.
// A mutant whose pattern no longer matches the source is an error, not a skip, so the
// list can't silently rot. Run: pnpm run test:mutations:types
const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');

const root = path.resolve(__dirname, '..');

// The type tests check the built declarations, so each mutant is built first. A mutant that
// breaks the build of lib/ still emits declarations; it only counts as caught if the type
// tests fail on them.
const BUILD = 'pnpm exec tsc -p tsconfig.json';
const TYPES = `${BUILD}; pnpm exec tsc -p tests/types/tsconfig.json && pnpm exec tsc -p tests/types/tsconfig.nodenext.json`;

const D = 'lib/types.ts';

const mutants = [
  [
    D,
    `    : FlagsOf<C[K]>['generated'] extends true\n      ? K`,
    `    : FlagsOf<C[K]>['generated'] extends true\n      ? never`,
    'Insert: generated columns become required',
  ],
  [
    D,
    `type WrapRelation<Kind, T> = Kind extends 'many' ? T[] : T | null;`,
    `type WrapRelation<Kind, T> = Kind extends 'many' ? T[] : T;`,
    'to-one relations are not nullable',
  ],
  [
    D,
    `type ColumnValue<S extends QueryState, P>\n  =`,
    `type ColumnValue<S extends QueryState, P> = any;\ntype ColumnValueUnused<S extends QueryState, P>\n  =`,
    'where() values are untyped',
  ],
  [
    D,
    `type CheckExpression<R extends Registry, K, X> = string extends X`,
    `type CheckExpression<R extends Registry, K, X> = unknown;\ntype CheckExpressionUnused<R extends Registry, K, X> = string extends X`,
    'relation expressions are unchecked',
  ],
  [
    D,
    `  All extends string = U,\n> = U extends`,
    `  All extends string = U,\n> = never extends U ? never : U extends`,
    'duplicate relations are not reported',
  ],
  [
    D,
    '  : P extends `${infer N}_id`',
    '  : P extends `${infer N}_iid`',
    'derived relation names keep `_id`',
  ],
  [
    D,
    `S['container'] extends 'maybe' ? 'single' : S['container']`,
    `S['container']`,
    'throwIfNotFound() keeps undefined',
  ],
  [D, `(S['selected'] extends true ? S['row'] : {}) &`, `{} &`, 'select() calls do not accumulate'],
  [D, `IdKeys<Id> | SchemaDefaultKeys<C>`, `IdKeys<Id>`, 'insert() result drops schema defaults'],
  [
    D,
    `type OptionalKeys<T, F> = [F] extends [never]`,
    `type OptionalKeys<T, F> = T;\ntype OptionalKeysUnused<T, F> = [F] extends [never]`,
    'graph inputs require child foreign keys',
  ],
  [
    D,
    `? { -readonly [I in keyof Id]: Row[Id[I] & keyof Row] }`,
    `? any`,
    'composite ids are untyped',
  ],
  [
    D,
    `type Modifiers<S extends QueryState> = E_<S>['modifiers'];`,
    `type Modifiers<S extends QueryState> = string;`,
    'modifier names are unchecked',
  ],
  [
    D,
    `references<const T extends Names,`,
    `references<const T extends string,`,
    'defineModelNames() targets are unchecked',
  ],
  [
    D,
    `  [K in keyof C]?: ColIn<C[K]> | ValueExpression;\n}>;`,
    `  [K in keyof C]-?: ColIn<C[K]> | ValueExpression;\n}>;`,
    'Patch requires every column',
  ],
  [D, `      & ExtraOfRelation<R, K, Rel>\n`, ``, 'graph results drop join-table extras'],
  [
    D,
    `(R['column'] extends ColumnsOfInput<M[R['target']]>`,
    `(true`,
    'references() to an unknown column is allowed',
  ],
  [
    D,
    '`${EntryOf<R, K>[\'table\']}.${keyof RowOf<R, K> & string}`;',
    '`${string}.${string}`;',
    'table-qualified columns are unchecked',
  ],
  [
    D,
    `    ? \`relation "\${K}.\${N}" has the same name as a column\``,
    `      ? never`,
    'relations named like columns are allowed',
  ],
  [
    D,
    `  : \`\${Site}.references(): unknown model "\${R['target']}"\``,
    `  : never`,
    'references() to an unknown model is allowed',
  ],
  [
    D,
    `  ? StrKeys<Sp['columns']>\n  : X extends ClassicModelClass`,
    `  ? string\n  : X extends ClassicModelClass`,
    'relation join columns are unchecked',
  ],
  [
    D,
    `findById(id: IdValue<R_<S>, K_<S>>): Query<ContainerState<S, 'maybe'>>;`,
    `findById(id: IdValue<R_<S>, K_<S>>): Query<ContainerState<S, 'single'>>;`,
    'findById() result is never undefined',
  ],
  [
    D,
    `      ? DbOf<R_<S>, K_<S>>[C & keyof DbOf<R_<S>, K_<S>>]\n      : DbOf<R_<S>, K_<S>>[P & keyof DbOf<R_<S>, K_<S>>];`,
    `      ? RowOf<R_<S>, K_<S>>[C & keyof RowOf<R_<S>, K_<S>>]\n      : RowOf<R_<S>, K_<S>>[P & keyof RowOf<R_<S>, K_<S>>];`,
    'where() takes app values for codec columns',
  ],
  [D, `  ? Db | Extract<ColOut<C>, null | undefined>`, `  ? Db`, 'nullable codec columns can\'t be queried with null'],
  [
    D,
    `]: DbOf<\n          R,\n          TargetOf<R, K, P>\n        >[C & keyof DbOf<R, TargetOf<R, K, P>>];`,
    `]: RowOf<\n          R,\n          TargetOf<R, K, P>\n        >[C & keyof RowOf<R, TargetOf<R, K, P>>];`,
    'joined codec columns are typed as decoded',
  ],
  [
    D,
    `A extends OutputName<Trim<Ref>> ? SelectedValue<S, Trim<Ref>> : ColumnValue<S, Trim<Ref>>`,
    `A extends OutputName<Trim<Ref>> ? SelectedValue<S, Trim<Ref>> : SelectedValue<S, Trim<Ref>>`,
    'aliased codec columns are typed as decoded',
  ],
  [
    D,
    `      ? ColumnCodec<NonNullable<StandardSchemaV1.InferOutput<S>>, Db>\n      : ColumnError`,
    `      ? ColumnCodec<any, Db>\n      : ColumnError`,
    'codecs are unchecked against the schema',
  ],
  [
    D,
    `      ? ColumnCodec<NonNullable<StandardSchemaV1.InferOutput<S>>, Db>\n      : ColumnError`,
    `      ? ColumnCodec<StandardSchemaV1.InferOutput<S>, Db>\n      : ColumnError`,
    'codecs are typed to get null and undefined',
  ],
  [
    D,
    `  readonly toDatabase: (value: Out) => Db;`,
    `  toDatabase(value: Out): Db;`,
    'toDatabase is a bivariant method',
  ],
  [
    D,
    `type OutputValue<S extends QueryState, A, Value> = A extends E_<S>['codecs']`,
    `type OutputValue<S extends QueryState, A, Value> = A extends never`,
    'values selected under a codec column\'s name are typed as not decoded',
  ],
  [D, `    codec: R extends null\n`, `    codec: null extends null\n`, 'codec() on a references() column is allowed'],
  [D, `    target: X extends null\n`, `    target: null extends null\n`, 'references() on a codec column is allowed'],
  [
    D,
    `  = IsNever<IdKeys<Id> & CodecKeys<C>> extends true\n`,
    `  = true extends true\n`,
    'codecs on id columns are allowed',
  ],
  ['lib/index.mts', `export type * from './index.js';`, ``, 'ESM entry exports no types'],
];

function passes() {
  try {
    execSync(TYPES, { cwd: root, stdio: 'pipe' });

    return true;
  }
  catch (err) {
    // Ctrl-C kills the type check too. Stop instead of counting the mutant as caught; the
    // `finally` blocks below restore the sources and dist/.
    if (err.signal)
      throw err;

    return false;
  }
}

if (!passes()) {
  console.error('The type tests must pass before mutating.');
  process.exit(1);
}

// Ctrl-C goes to the whole process group. Keep this process alive: the type check it kills
// throws in `passes()`, and the `finally` blocks restore the sources and dist/.
process.on('SIGINT', () => {});

let caught = 0;
const problems = [];

try {
  for (const [file, find, replace, description] of mutants) {
    const filePath = path.join(root, file);
    const original = fs.readFileSync(filePath, 'utf8');

    if (!original.includes(find)) {
      problems.push(`pattern not found: ${description}`);
      console.log(`  MISSING   ${description}`);
      continue;
    }

    fs.writeFileSync(filePath, original.replace(find, replace));
    let survived;

    try {
      survived = passes();
    }
    finally {
      fs.writeFileSync(filePath, original);
    }

    console.log(`  ${survived ? 'SURVIVED' : 'caught  '}  ${description}`);

    if (survived)
      problems.push(`survived: ${description}`);
    else caught += 1;
  }
}
finally {
  // Leave dist/ built from the restored sources, not from the last mutant.
  try {
    execSync('pnpm run build', { cwd: root, stdio: 'pipe' });
  }
  catch (err) {
    problems.push(`rebuilding dist/ failed, run \`pnpm run build\`: ${err.stderr || err}`);
  }
}

console.log(`\n${caught}/${mutants.length} type mutants caught`);

if (problems.length) {
  console.log(problems.map(it => `- ${it}`).join('\n'));
  process.exitCode = 1;
}
