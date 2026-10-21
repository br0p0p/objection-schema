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
    `> = CheckExpression<HandleInfo<H>['r'], HandleInfo<H>['k'], X> extends { '~error': infer E }`,
    `> = unknown extends { '~error': infer E }`,
    'RowWithGraph drops unknown relations',
  ],
  [
    D,
    `type InvalidExpressionPaths<R extends Registry, K, X> = X extends unknown`,
    `type InvalidExpressionPaths<R extends Registry, K, X> = [X] extends [unknown]`,
    'union expressions are not checked member by member',
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
    `[K in keyof M as string extends K ? never : number extends K`,
    `[K in keyof M as number extends K`,
    'classic models keep string index signatures',
  ],
  [
    D,
    `[K in keyof KnownKeys<M>]-?: IsAny<ClassicElement<KnownKeys<M>[K]>> extends true`,
    `[K in keyof KnownKeys<M>]-?: false extends true`,
    'classic fields typed `any` count as relations',
  ],
  [
    D,
    `[K in keyof KnownKeys<M>]-?: IsAny<ClassicElement<KnownKeys<M>[K]>> extends true`,
    `[K in keyof KnownKeys<M>]-?: IsAny<KnownKeys<M>[K]> extends true`,
    'classic fields typed `any[]` count as relations',
  ],
  [
    D,
    `findById(id: IdValue<R_<S>, K_<S>>): Query<ContainerState<S, 'maybe'>>;`,
    `findById(id: IdValue<R_<S>, K_<S>>): Query<ContainerState<S, 'single'>>;`,
    'findById() result is never undefined',
  ],
  ['lib/index.mts', `export type * from './index.js';`, ``, 'ESM entry exports no types'],
  [
    D,
    `  readonly modelClass: EntryOf<R, K>['modelClass'];`,
    `  readonly modelClass: ModelClass<Model>;`,
    'modelClass ignores `base` and the row',
  ],
  [
    'lib/defineModel.ts',
    `modifiers: M; base: B }>;`,
    `modifiers: M }>;`,
    'the spec drops `base`',
  ],
  [
    D,
    `= Omit<B, keyof typeof Model>\n  & ModelClassFor<ModelInstanceOf<B, Row>>;`,
    `= B\n  & ModelClassFor<ModelInstanceOf<B, Row>>;`,
    'modelClass is `B & ModelClass<…>`: query() returns the base\'s instances',
  ],
  [
    D,
    `= Omit<B, keyof typeof Model>\n  & ModelClassFor<ModelInstanceOf<B, Row>>;`,
    `= ModelClassFor<ModelInstanceOf<B, Row>>\n  & B;`,
    'modelClass is `ModelClass<…> & B`: InstanceType drops the row',
  ],
  [
    D,
    `  : Omit<InstanceType<B>, ClashingKeys<InstanceType<B>, Row>>)`,
    `  : InstanceType<B>)`,
    'a base field clashing with a column becomes never',
  ],
  [
    D,
    `  ? InstanceType<B>\n  : Omit<`,
    `  ? Omit<InstanceType<B>, keyof Row>\n  : Omit<`,
    'modelClass instances bind `this` (query builders) to the base',
  ],
  [D, `  modelClass: ModelClass<M>;\n}`, `  modelClass: ModelClass<Model>;\n}`, 'classic modelClass drops the instance type'],
  [
    D,
    `hooks?: Hooks<RowOfColumns<C>, HookInstance<B, RowOfColumns<C>>>;`,
    `hooks?: Hooks<RowOfColumns<C>>;`,
    'hooks don\'t see the base\'s members',
  ],
  [
    D,
    `Row> = Omit<InstanceType<B>, keyof Row>;`,
    `Row> = InstanceType<B>;`,
    'update hooks get base-declared columns as required',
  ],
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
