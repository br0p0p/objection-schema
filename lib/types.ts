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

import type { Knex } from 'knex';
import type {
  FunctionBuilder,
  GraphOptions,
  InsertGraphOptions,
  Model,
  ModelClass,
  ModelConstructor,
  ModelObject,
  ModelOptions,
  QueryBuilder,
  QueryContext,
  RawBuilder,
  ReferenceBuilder,
  TransactionOrKnex,
  UpsertGraphOptions,
  ValueBuilder,
} from 'objection';

// ---------------------------------------------------------------------------
// Standard Schema (https://standardschema.dev). The spec is meant to be copied.
// ---------------------------------------------------------------------------

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}

export declare namespace StandardSchemaV1 {
  interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }

  type Result<Output> = SuccessResult<Output> | FailureResult;

  interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }

  interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }

  interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }

  interface PathSegment {
    readonly key: PropertyKey;
  }

  interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }

  type InferInput<S extends StandardSchemaV1> = NonNullable<S['~standard']['types']>['input'];

  type InferOutput<S extends StandardSchemaV1> = NonNullable<S['~standard']['types']>['output'];
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type UnionToIntersection<U> = (U extends any ? (x: U) => void : never) extends (x: infer I) => void
  ? I
  : never;

export type StrKeys<T> = keyof T & string;

type IsNever<T> = [T] extends [never] ? true : false;

/** Values that objection accepts in place of a literal value. */
export type ValueExpression
  = | RawBuilder
    | ReferenceBuilder
    | ValueBuilder
    | FunctionBuilder
    | Knex.Raw;

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export interface ColumnFlags {
  generated: boolean;
  hasDefault: boolean;
  json: boolean;
}

export type DefaultFlags = { generated: false; hasDefault: false; json: false };

type SetFlag<F extends ColumnFlags, K extends keyof ColumnFlags> = {
  [P in keyof ColumnFlags]: P extends K ? true : F[P];
};

/** Foreign key metadata of a column, from `column(schema).references(...)`. */
export interface ColumnReference {
  target: string;
  column: string;
  as: string | undefined;
  inverse: string | undefined;
  inverseKind: 'many' | 'one';
}

export interface ReferenceOptions {
  /** Name of the derived `belongsToOne` relation. Defaults to the column name without `Id` / `_id`. */
  as?: string;
  /** Also create the inverse relation on the target model (`hasMany`, or `hasOne` with `kind: 'one'`). */
  inverse?: string | InverseReferenceOptions;
  /**
   * Modifier name(s) or a function applied to every query of the `belongsToOne` relation.
   * Names resolve on the referenced model (`target`). Filter by table name
   * (`query.whereNull('persons.deletedAt')`), not by relation name.
   */
  modify?: RelationOptions['modify'];
  /** Called for models inserted through the `belongsToOne` relation. */
  beforeInsert?: RelationOptions['beforeInsert'];
}

/** The object form of `references()`'s `inverse` option. */
interface InverseReferenceOptions {
  /** Name of the inverse relation on the target model. */
  name: string;
  /** `'many'` (the default) for a `hasMany`, `'one'` for a `hasOne`. */
  kind?: 'many' | 'one';
  /**
   * Modifier name(s) or a function applied to every query of the inverse relation.
   * Names resolve on the model that declares the column. Filter by table name, not by relation name.
   */
  modify?: RelationOptions['modify'];
  /** Called for models inserted through the inverse relation. */
  beforeInsert?: RelationOptions['beforeInsert'];
}

// Unknown keys of `references()` options become `never`, at the top level and in the object
// form of `inverse`, so a typo (which would drop a filter) is an error on the typo itself. An
// inferred type parameter gets no excess property checks, and `NoInfer` needs TypeScript 5.4.
type ExactReferenceOptions<O> = {
  [K in keyof O]: K extends keyof ReferenceOptions
    ? K extends 'inverse'
      ? O[K] extends object
        ? { [P in keyof O[K]]: P extends keyof InverseReferenceOptions ? O[K][P] : never }
        : O[K]
      : O[K]
    : never;
};

type ReferenceOf<T extends string, C extends string, O extends ReferenceOptions> = {
  target: T;
  column: C;
  as: O extends { as: infer A extends string } ? A : undefined;
  inverse: O extends { inverse: infer I }
    ? I extends string
      ? I
      : I extends { name: infer N extends string }
        ? N
        : undefined
    : undefined;
  inverseKind: O extends { inverse: { kind: 'one' } } ? 'one' : 'many';
};

export interface Column<
  S extends StandardSchemaV1 = StandardSchemaV1,
  F extends ColumnFlags = DefaultFlags,
  R extends ColumnReference | null = null,
  /** Allowed `references()` targets: the names from `defineModelNames`, or any string. */
  Names extends string = string,
> {
  readonly '~column': F & { references: R };
  readonly schema: S;
  /** The database generates the value (serial / identity / uuid default). Optional on insert. */
  generated(): Column<S, SetFlag<F, 'generated'>, R, Names>;
  /** The database has a default for the column. Optional on insert. */
  hasDefault(): Column<S, SetFlag<F, 'hasDefault'>, R, Names>;
  /** The column is stored as JSON. */
  json(): Column<S, SetFlag<F, 'json'>, R, Names>;
  /**
   * A foreign key to `target.column`, where `target` is a key in the `defineModels` registry.
   * With a `column` from `defineModelNames(...)`, `target` must be one of the declared names.
   * Creates a `belongsToOne` relation, plus an inverse one on the target when `inverse` is given.
   * `modify` and `beforeInsert` work as in the relation builders, for the `belongsToOne`
   * relation, and in the object form of `inverse` for the inverse one. A modifier name resolves
   * on the relation's target: the referenced model for `modify`, and the model that declares
   * the column for `inverse.modify`.
   */
  references<const T extends Names, const C extends string, const O extends ReferenceOptions>(
    target: T,
    column: C,
    options?: O & ExactReferenceOptions<O>,
  ): Column<S, F, ReferenceOf<T, C, O>, Names>;
}

export type ColumnInput = StandardSchemaV1 | Column<any, any, any, any>;

export type Columns = Record<string, ColumnInput>;

type SchemaOf<C>
  = C extends Column<infer S, any, any, any> ? S : C extends StandardSchemaV1 ? C : never;

type FlagsOf<C> = C extends Column<any, infer F, any, any> ? F : DefaultFlags;

type ReferenceOfColumn<C> = C extends Column<any, any, infer R, any> ? R : null;

type ColOut<C> = StandardSchemaV1.InferOutput<SchemaOf<C>>;

type ColIn<C> = StandardSchemaV1.InferInput<SchemaOf<C>>;

type OptionalInsertKeys<C extends Columns> = {
  [K in keyof C]: undefined extends ColIn<C[K]>
    ? K
    : FlagsOf<C[K]>['generated'] extends true
      ? K
      : FlagsOf<C[K]>['hasDefault'] extends true
        ? K
        : never;
}[keyof C];

/** Columns whose schema turns a missing value into something (zod `.default()` etc). */
type SchemaDefaultKeys<C extends Columns> = {
  [K in keyof C]: undefined extends ColIn<C[K]>
    ? undefined extends ColOut<C[K]>
      ? never
      : K
    : never;
}[keyof C];

type RowOfColumns<C extends Columns> = Simplify<{ -readonly [K in keyof C]: ColOut<C[K]> }>;

type InsertOfColumns<C extends Columns> = Simplify<
  { [K in Exclude<keyof C, OptionalInsertKeys<C>>]: ColIn<C[K]> | ValueExpression } & {
    [K in OptionalInsertKeys<C>]?: ColIn<C[K]> | ValueExpression;
  }
>;

type PatchOfColumns<C extends Columns> = Simplify<{
  [K in keyof C]?: ColIn<C[K]> | ValueExpression;
}>;

/** What `insert` resolves to: the given columns, the id and schema defaults. */
type InsertResultOfColumns<C extends Columns, Id extends IdSpec> = Simplify<
  Pick<
    RowOfColumns<C>,
    Exclude<keyof C, OptionalInsertKeys<C>> | IdKeys<Id> | SchemaDefaultKeys<C>
  >
  & Partial<RowOfColumns<C>>
>;

// ---------------------------------------------------------------------------
// Registry entries: the normalized description of a model the query types use.
// ---------------------------------------------------------------------------

type IdSpec = string | readonly string[];

type IdKeys<Id extends IdSpec> = Id extends readonly string[] ? Id[number] : Id;

interface RelationDescriptor {
  kind: 'one' | 'many';
  /** A key in the registry, or a classic model instance type. */
  target: string | ClassicRef<any>;
  extra: object;
  /** Target columns objection fills in when inserting through the relation (`hasMany`/`hasOne` foreign keys). */
  filled: string;
}

interface ClassicRef<M> {
  '~classic': M;
}

interface Entry {
  row: object;
  insert: object;
  insertResult: object;
  patch: object;
  id: IdSpec;
  table: string;
  modifiers: string;
  relations: Record<string, RelationDescriptor>;
  /** The type of the handle's `modelClass`. */
  modelClass: object;
}

type Registry = Record<string, Entry>;

interface SpecEntry<Sp extends ModelSpec, Rels extends Record<string, RelationDescriptor>> {
  row: RowOfColumns<Sp['columns']>;
  insert: InsertOfColumns<Sp['columns']>;
  insertResult: InsertResultOfColumns<Sp['columns'], Sp['id']>;
  patch: PatchOfColumns<Sp['columns']>;
  id: Sp['id'];
  table: Sp['table'];
  modifiers: Sp['modifiers'];
  relations: Rels;
  modelClass: ModelClassOf<BaseOf<Sp>, RowOfColumns<Sp['columns']>>;
}

type ClassicRelationKeys<M> = {
  [K in keyof M]-?: NonNullable<M[K]> extends Model | readonly Model[] ? K : never;
}[keyof M];

type ClassicElement<T> = NonNullable<T> extends readonly (infer E)[] ? E : NonNullable<T>;

interface ClassicEntry<M extends Model> {
  row: Omit<ModelObject<M>, ClassicRelationKeys<M>>;
  insert: Partial<Omit<ModelObject<M>, ClassicRelationKeys<M>>>;
  insertResult: Partial<Omit<ModelObject<M>, ClassicRelationKeys<M>>>;
  patch: Partial<Omit<ModelObject<M>, ClassicRelationKeys<M>>>;
  id: string;
  table: string;
  modifiers: string;
  relations: {
    [K in ClassicRelationKeys<M> & string]: {
      kind: NonNullable<M[K]> extends readonly any[] ? 'many' : 'one';
      target: ClassicRef<ClassicElement<M[K]>>;
      extra: {};
      filled: never;
    };
  };
  modelClass: ModelClass<M>;
}

type EntryOf<R extends Registry, K> = K extends string
  ? R[K]
  : K extends ClassicRef<infer M extends Model>
    ? ClassicEntry<M>
    : never;

type RowOf<R extends Registry, K> = EntryOf<R, K>['row'];

type RelationsOf<R extends Registry, K> = EntryOf<R, K>['relations'];

type ColumnKeys<R extends Registry, K> = StrKeys<RowOf<R, K>>;

type RelationOf<R extends Registry, K, Rel> = RelationsOf<R, K>[Rel
  & keyof RelationsOf<R, K>] extends infer D extends RelationDescriptor
  ? D
  : never;

type TargetOf<R extends Registry, K, Rel> = RelationOf<R, K, Rel>['target'];

type KindOf<R extends Registry, K, Rel> = RelationOf<R, K, Rel>['kind'];

type ExtraOfRelation<R extends Registry, K, Rel> = RelationOf<R, K, Rel>['extra'];

type FilledOf<R extends Registry, K, Rel> = RelationOf<R, K, Rel>['filled'];

type IdValue<R extends Registry, K> = IdValueOf<EntryOf<R, K>['id'], RowOf<R, K>>;

type IdValueOf<Id, Row> = Id extends readonly string[]
  ? { -readonly [I in keyof Id]: Row[Id[I] & keyof Row] }
  : Row[Id & keyof Row];

// ---------------------------------------------------------------------------
// Relation expressions: object form and (parsed) string form.
// ---------------------------------------------------------------------------

/** `{ pets: true, children: { pets: { $modify: ['onlyDogs'] } } }` */
export type GraphExpression<R extends Registry, K> = {
  [Rel in StrKeys<RelationsOf<R, K>>]?:
    | true
    | (GraphExpression<R, TargetOf<R, K, Rel>> & {
      $modify?: readonly EntryOf<R, TargetOf<R, K, Rel>>['modifiers'][];
    });
};

type Whitespace = ' ' | '\n' | '\t' | '\r';

type Trim<S extends string> = S extends `${Whitespace}${infer R}`
  ? Trim<R>
  : S extends `${infer R}${Whitespace}`
    ? Trim<R>
    : S;

// Splits `S` at `Sep` characters that are not inside brackets or parentheses.
type SplitTop<
  S extends string,
  Sep extends string,
  Depth extends 0[] = [],
  Cur extends string = '',
  Acc extends string[] = [],
> = S extends `${infer C}${infer Rest}`
  ? C extends '[' | '('
    ? SplitTop<Rest, Sep, [...Depth, 0], `${Cur}${C}`, Acc>
    : C extends ']' | ')'
      ? SplitTop<Rest, Sep, Depth extends [0, ...infer D extends 0[]] ? D : [], `${Cur}${C}`, Acc>
      : C extends Sep
        ? Depth extends []
          ? SplitTop<Rest, Sep, Depth, '', [...Acc, Cur]>
          : SplitTop<Rest, Sep, Depth, `${Cur}${C}`, Acc>
        : SplitTop<Rest, Sep, Depth, `${Cur}${C}`, Acc>
  : [...Acc, Cur];

/** `pets(onlyDogs)` -> `pets` */
type RelationName<S extends string> = Trim<S> extends `${infer N}(${string})` ? Trim<N> : Trim<S>;

type ParseChain<Segs extends string[]> = Segs extends [
  infer H extends string,
  ...infer T extends string[],
]
  ? T extends []
    ? Trim<H> extends `[${infer Inner}]`
      ? ParseList<SplitTop<Inner, ','>>
      : { [N in RelationName<H>]: true }
    : { [N in RelationName<H>]: ParseChain<T> }
  : {};

type ParseList<Items extends string[], Acc = {}> = Items extends [
  infer H extends string,
  ...infer T extends string[],
]
  ? Trim<H> extends ''
    ? ParseList<T, Acc>
    : ParseList<T, MergeExpressions<Acc, ParseChain<SplitTop<Trim<H>, '.'>>>>
  : Acc;

type MergeExpressions<A, B> = {
  [K in keyof A | keyof B]: K extends keyof A
    ? K extends keyof B
      ? A[K] extends true
        ? B[K]
        : B[K] extends true
          ? A[K]
          : MergeExpressions<A[K], B[K]>
      : A[K]
    : K extends keyof B
      ? B[K]
      : never;
};

/** Parses `'[pets.owner, parent(selectName)]'` into `{ pets: { owner: true }, parent: true }`. */
export type ParseRelationExpression<S extends string> = ParseChain<SplitTop<Trim<S>, '.'>>;

type ToExpressionObject<X> = X extends string ? ParseRelationExpression<X> : X;

type InvalidRelationPaths<R extends Registry, K, E, Prefix extends string = ''> = {
  [P in StrKeys<E>]: P extends `$${string}`
    ? never
    : P extends StrKeys<RelationsOf<R, K>>
      ? E[P] extends true
        ? never
        : InvalidRelationPaths<R, TargetOf<R, K, P>, E[P], `${Prefix}${P}.`>
      : `${Prefix}${P}`;
}[StrKeys<E>];

type CheckExpression<R extends Registry, K, X> = string extends X
  ? unknown // Not a literal (e.g. the constraint itself while the editor computes completions).
  : InvalidRelationPaths<R, K, ToExpressionObject<X>> extends infer P
    ? IsNever<P> extends true
      ? unknown
      : { '~error': `unknown relation: ${P & string}` }
    : never;

/** Relation paths offered as autocompletion for string expressions (two levels deep). */
type RelationPathHints<R extends Registry, K> = {
  [Rel in StrKeys<RelationsOf<R, K>>]:
    | Rel
    | `${Rel}.${StrKeys<RelationsOf<R, TargetOf<R, K, Rel>>>}`;
}[StrKeys<RelationsOf<R, K>>];

type RelationExpressionInput<R extends Registry, K> = string | GraphExpression<R, K>;

type WrapRelation<Kind, T> = Kind extends 'many' ? T[] : T | null;

type GraphResult<R extends Registry, K, E> = {
  -readonly [Rel in StrKeys<E> & StrKeys<RelationsOf<R, K>>]: WrapRelation<
    KindOf<R, K, Rel>,
    Simplify<
      RowOf<R, TargetOf<R, K, Rel>>
      & ExtraOfRelation<R, K, Rel>
      & (E[Rel] extends true ? {} : GraphResult<R, TargetOf<R, K, Rel>, E[Rel]>)
    >
  >;
};

/** Dotted relation paths of an expression: `{ a: { b: true } }` -> `'a' | 'a.b'` */
type ExpressionPaths<E, Prefix extends string = ''> = E extends object
  ? ExpressionPathsOf<E, Prefix>
  : never;

type ExpressionPathsOf<E, Prefix extends string> = {
  [P in StrKeys<E>]: P extends `$${string}`
    ? never
    : `${Prefix}${P}` | (E[P] extends true ? never : ExpressionPaths<E[P], `${Prefix}${P}.`>);
}[StrKeys<E>];

type PathTarget<R extends Registry, K, P extends string> = P extends `${infer H}.${infer T}`
  ? PathTarget<R, TargetOf<R, K, H>, T>
  : TargetOf<R, K, P>;

/** Columns made available by joins: `pets.name`, `pets:owner.firstName`, ... */
type JoinedColumns<R extends Registry, K, E, Alias extends string = ''> = UnionToIntersection<
  {
    [P in StrKeys<E> & StrKeys<RelationsOf<R, K>>]:
      | {
        [C in ColumnKeys<R, TargetOf<R, K, P>> as `${Alias}${P}.${C}`]: RowOf<
          R,
          TargetOf<R, K, P>
        >[C];
      }
      | (E[P] extends true ? never : JoinedColumns<R, TargetOf<R, K, P>, E[P], `${Alias}${P}:`>);
  }[StrKeys<E> & StrKeys<RelationsOf<R, K>>]
>;

// ---------------------------------------------------------------------------
// Typed query
// ---------------------------------------------------------------------------

type Container = 'array' | 'maybe' | 'single' | 'number' | 'page';

interface QueryState {
  registry: Registry;
  model: unknown;
  container: Container;
  /** Row part of the result. */
  row: object;
  /** Whether `row` was narrowed by `select`. */
  selected: boolean;
  /** Relations added by `withGraph*`. */
  graph: object;
  /** The (merged) graph expression, for `modifyGraph` paths. */
  expression: object;
  /** Columns available through joins. */
  joined: object;
  /** Precomputed column references, so errors list the valid names instead of an alias. */
  refs: string;
}

type InitialState<R extends Registry, K> = {
  registry: R;
  model: K;
  container: 'array';
  row: RowOf<R, K>;
  selected: false;
  graph: {};
  expression: {};
  joined: {};
  // Written inline (not via an alias) so error messages list the actual column names.
  refs: (keyof RowOf<R, K> & string) | `${EntryOf<R, K>['table']}.${keyof RowOf<R, K> & string}`;
};

type QueryFor<R extends Registry, K>
  = InitialState<R, K> extends infer S extends QueryState ? Query<S> : never;

type With<S extends QueryState, P extends Partial<QueryState>> = Omit<S, keyof P> & P;

type Item<S extends QueryState> = Simplify<S['row'] & S['graph']>;

type Output<S extends QueryState> = {
  array: Item<S>[];
  maybe: Item<S> | undefined;
  single: Item<S>;
  number: number;
  page: { results: Item<S>[]; total: number };
}[S['container']];

type R_<S extends QueryState> = S['registry'];

type K_<S extends QueryState> = S['model'];

type E_<S extends QueryState> = EntryOf<R_<S>, K_<S>>;

/** Any column reference the query understands: `age`, `persons.age`, `pets.name`. */
export type ColumnRef<S extends QueryState> = S['refs'];

type ColumnValue<S extends QueryState, P>
  = P extends StrKeys<S['joined']>
    ? S['joined'][P]
    : P extends `${E_<S>['table']}.${infer C}`
      ? RowOf<R_<S>, K_<S>>[C & keyof RowOf<R_<S>, K_<S>>]
      : RowOf<R_<S>, K_<S>>[P & keyof RowOf<R_<S>, K_<S>>];

/** Output property name of a column reference: `pets.name` -> `name` */
type OutputName<P extends string> = P extends `${string}.${infer C}` ? C : P;

type Selection<S extends QueryState, P> = P extends `${infer Ref} as ${infer Alias}`
  ? { [A in Trim<Alias>]: ColumnValue<S, Trim<Ref>> }
  : P extends string
    ? { [A in OutputName<P>]: ColumnValue<S, P> }
    : never;

export type SelectArg<S extends QueryState> = S['refs'] | `${S['refs']} as ${string}`;

export type ComparisonOperator
  = | '='
    | '!='
    | '<>'
    | '<'
    | '<='
    | '>'
    | '>='
    | 'like'
    | 'not like'
    | 'ilike'
    | 'not ilike'
    | 'is'
    | 'is not';

/** Any typed query (structural brand, so concrete queries are assignable). */
export interface AnyQuery {
  readonly '~result': unknown;
  toKnexQuery(): Knex.QueryBuilder;
}

type Val<T> = T | ValueExpression | AnyQuery;

export type WhereObject<S extends QueryState> = {
  [P in S['refs']]?: Val<ColumnValue<S, P>>;
};

interface Where<S extends QueryState> {
  <P extends S['refs']>(column: P, value: Val<ColumnValue<S, P>>): Query<S>;
  <P extends S['refs']>(
    column: P,
    operator: ComparisonOperator,
    value: Val<NonNullable<ColumnValue<S, P>>> | null,
  ): Query<S>;
  (filter: WhereObject<S>): Query<S>;
  (group: (query: Query<S>) => void): Query<S>;
}

interface WhereIn<S extends QueryState> {
  <P extends S['refs']>(
    column: P,
    values: readonly ColumnValue<S, P>[] | AnyQuery | ValueExpression,
  ): Query<S>;
}

interface WhereColumn<S extends QueryState> {
  (column: S['refs']): Query<S>;
}

interface WhereBetween<S extends QueryState> {
  <P extends S['refs']>(
    column: P,
    range: readonly [Val<ColumnValue<S, P>>, Val<ColumnValue<S, P>>],
  ): Query<S>;
}

interface WhereExists<S extends QueryState> {
  (query: AnyQuery | ((query: Query<S>) => void)): Query<S>;
}

type Modifiers<S extends QueryState> = E_<S>['modifiers'];

type GraphPathOf<S> = S extends QueryState ? ExpressionPaths<S['expression']> : never;

// One non-generic overload per path (an intersection of function types is an
// overload set). A generic `path: P` combined with a context-sensitive callback
// made every `modifyGraph` call cost ~120k type instantiations.
type ModifyGraph<S extends QueryState> = UnionToIntersection<
  {
    [P in GraphPathOf<S>]: (
      path: P,
      modifier: (query: QueryFor<R_<S>, PathTarget<R_<S>, K_<S>, P>>) => void,
    ) => Query<S>;
  }[GraphPathOf<S>]
>;

type GraphState<S extends QueryState, X> = With<
  S,
  {
    graph: S['graph'] & GraphResult<R_<S>, K_<S>, ToExpressionObject<X>>;
    expression: MergeExpressions<S['expression'], ToExpressionObject<X>>;
  }
>;

type JoinState<S extends QueryState, X>
  = JoinedColumns<R_<S>, K_<S>, ToExpressionObject<X>> extends infer J
    ? With<S, { joined: S['joined'] & J; refs: S['refs'] | StrKeys<J> }>
    : never;

type SelectState<S extends QueryState, Cols extends readonly unknown[]> = With<
  S,
  {
    row: Simplify<
      (S['selected'] extends true ? S['row'] : {}) & UnionToIntersection<Selection<S, Cols[number]>>
    >;
    selected: true;
  }
>;

type ContainerState<S extends QueryState, C extends Container> = With<S, { container: C }>;

type MutationState<S extends QueryState, C extends Container, Row extends object> = With<
  S,
  { container: C; row: Row; selected: true; graph: {} }
>;

/** Makes the keys `F` optional (foreign keys that objection fills in for nested inserts). */
type OptionalKeys<T, F> = [F] extends [never]
  ? T
  : Omit<T, F & keyof T> & Partial<Pick<T, F & keyof T>>;

type InsertGraphInput<R extends Registry, K, Relate extends boolean, Filled = never> = OptionalKeys<
  EntryOf<R, K>['insert'],
  Filled
>
& GraphRefs & {
  [Rel in StrKeys<RelationsOf<R, K>>]?: WrapRelation<
    KindOf<R, K, Rel>,
      | (InsertGraphInput<R, TargetOf<R, K, Rel>, Relate, FilledOf<R, K, Rel>>
        & Partial<ExtraOfRelation<R, K, Rel>>)
      | GraphReference
      | (Relate extends true ? IdObject<R, TargetOf<R, K, Rel>> : never)
  >;
};

type UpsertGraphInput<R extends Registry, K, Filled = never> = (
  | OptionalKeys<EntryOf<R, K>['insert'], Filled>
  | (IdObject<R, K> & EntryOf<R, K>['patch'])
)
& GraphRefs & {
  [Rel in StrKeys<RelationsOf<R, K>>]?: WrapRelation<
    KindOf<R, K, Rel>,
      | (UpsertGraphInput<R, TargetOf<R, K, Rel>, FilledOf<R, K, Rel>>
        & Partial<ExtraOfRelation<R, K, Rel>>)
      | GraphReference
  >;
};

type IdObject<R extends Registry, K> = Pick<
  RowOf<R, K>,
  IdKeys<EntryOf<R, K>['id']> & keyof RowOf<R, K>
>;

interface GraphRefs {
  '#id'?: string;
}

type GraphReference = { '#ref': string } | { '#dbRef': unknown };

type GraphOutput<R extends Registry, K> = EntryOf<R, K>['insertResult'] & {
  [Rel in StrKeys<RelationsOf<R, K>>]?: KindOf<R, K, Rel> extends 'many'
    ? GraphOutput<R, TargetOf<R, K, Rel>>[]
    : GraphOutput<R, TargetOf<R, K, Rel>> | null;
};

/**
 * A typed objection query. At runtime this is an ordinary `QueryBuilder`; use
 * `toQueryBuilder(query)` to reach APIs not covered by the typed surface.
 */
export interface Query<S extends QueryState> extends PromiseLike<Output<S>> {
  /** Phantom: the resolved result type. */
  readonly '~result': Output<S>;

  select<const Cols extends readonly SelectArg<S>[]>(...columns: Cols): Query<SelectState<S, Cols>>;

  where: Where<S>;
  andWhere: Where<S>;
  orWhere: Where<S>;
  whereNot: Where<S>;
  orWhereNot: Where<S>;
  whereIn: WhereIn<S>;
  orWhereIn: WhereIn<S>;
  whereNotIn: WhereIn<S>;
  orWhereNotIn: WhereIn<S>;
  whereNull: WhereColumn<S>;
  orWhereNull: WhereColumn<S>;
  whereNotNull: WhereColumn<S>;
  orWhereNotNull: WhereColumn<S>;
  whereBetween: WhereBetween<S>;
  whereNotBetween: WhereBetween<S>;
  whereExists: WhereExists<S>;
  whereNotExists: WhereExists<S>;

  orderBy(column: S['refs'], order?: 'asc' | 'desc'): Query<S>;
  groupBy(...columns: S['refs'][]): Query<S>;
  limit(limit: number): Query<S>;
  offset(offset: number): Query<S>;

  modify(modifier: Modifiers<S> | readonly Modifiers<S>[], ...args: any[]): Query<S>;
  modify(modifier: (query: Query<S>, ...args: any[]) => void, ...args: any[]): Query<S>;

  withGraphFetched<const X extends GraphExpression<R_<S>, K_<S>>>(
    expression: X & CheckExpression<R_<S>, K_<S>, X>,
    options?: GraphOptions,
  ): Query<GraphState<S, X>>;
  withGraphFetched<const X extends RelationPathHints<R_<S>, K_<S>>>(
    expression: X,
    options?: GraphOptions,
  ): Query<GraphState<S, X>>;
  withGraphFetched<const X extends string>(
    expression: X & CheckExpression<R_<S>, K_<S>, X>,
    options?: GraphOptions,
  ): Query<GraphState<S, X>>;
  withGraphJoined<const X extends GraphExpression<R_<S>, K_<S>>>(
    expression: X & CheckExpression<R_<S>, K_<S>, X>,
    options?: GraphOptions,
  ): Query<JoinState<GraphState<S, X>, X>>;
  withGraphJoined<const X extends RelationPathHints<R_<S>, K_<S>>>(
    expression: X,
    options?: GraphOptions,
  ): Query<JoinState<GraphState<S, X>, X>>;
  withGraphJoined<const X extends string>(
    expression: X & CheckExpression<R_<S>, K_<S>, X>,
    options?: GraphOptions,
  ): Query<JoinState<GraphState<S, X>, X>>;
  /** Modify a relation of a previous `withGraph*` call. The path is checked. */
  modifyGraph: ModifyGraph<S>;

  joinRelated<const X extends GraphExpression<R_<S>, K_<S>>>(
    expression: X & CheckExpression<R_<S>, K_<S>, X>,
  ): Query<JoinState<S, X>>;
  joinRelated<const X extends RelationPathHints<R_<S>, K_<S>>>(
    expression: X,
  ): Query<JoinState<S, X>>;
  joinRelated<const X extends string>(
    expression: X & CheckExpression<R_<S>, K_<S>, X>,
  ): Query<JoinState<S, X>>;
  leftJoinRelated<const X extends GraphExpression<R_<S>, K_<S>>>(
    expression: X & CheckExpression<R_<S>, K_<S>, X>,
  ): Query<JoinState<S, X>>;
  leftJoinRelated<const X extends RelationPathHints<R_<S>, K_<S>>>(
    expression: X,
  ): Query<JoinState<S, X>>;
  leftJoinRelated<const X extends string>(
    expression: X & CheckExpression<R_<S>, K_<S>, X>,
  ): Query<JoinState<S, X>>;

  findById(id: IdValue<R_<S>, K_<S>>): Query<ContainerState<S, 'maybe'>>;
  findByIds(ids: readonly IdValue<R_<S>, K_<S>>[]): Query<ContainerState<S, 'array'>>;
  findOne(filter: WhereObject<S>): Query<ContainerState<S, 'maybe'>>;
  first(): Query<ContainerState<S, 'maybe'>>;
  throwIfNotFound(): Query<
    ContainerState<S, S['container'] extends 'maybe' ? 'single' : S['container']>
  >;
  page(page: number, pageSize: number): Query<ContainerState<S, 'page'>>;
  range(start: number, end: number): Query<ContainerState<S, 'page'>>;
  resultSize(): Promise<number>;

  /** Owner(s) of a `relatedQuery`. */
  for(ids: IdValue<R_<S>, any> | readonly unknown[] | AnyQuery | object): Query<S>;

  insert(row: E_<S>['insert']): Query<MutationState<S, 'single', E_<S>['insertResult']>>;
  insert(rows: readonly E_<S>['insert'][]): Query<MutationState<S, 'array', E_<S>['insertResult']>>;
  insertAndFetch(row: E_<S>['insert']): Query<MutationState<S, 'single', RowOf<R_<S>, K_<S>>>>;
  insertAndFetch(
    rows: readonly E_<S>['insert'][],
  ): Query<MutationState<S, 'array', RowOf<R_<S>, K_<S>>>>;
  insertGraph(
    graph: InsertGraphInput<R_<S>, K_<S>, false>,
    options?: InsertGraphOptions & { relate?: false },
  ): Query<MutationState<S, 'single', GraphOutput<R_<S>, K_<S>>>>;
  insertGraph(
    graph: InsertGraphInput<R_<S>, K_<S>, true>,
    options: InsertGraphOptions & { relate: true | readonly string[] },
  ): Query<MutationState<S, 'single', GraphOutput<R_<S>, K_<S>>>>;
  insertGraph(
    graphs: readonly InsertGraphInput<R_<S>, K_<S>, false>[],
    options?: InsertGraphOptions,
  ): Query<MutationState<S, 'array', GraphOutput<R_<S>, K_<S>>>>;
  upsertGraph(
    graph: UpsertGraphInput<R_<S>, K_<S>>,
    options?: UpsertGraphOptions,
  ): Query<MutationState<S, 'single', GraphOutput<R_<S>, K_<S>>>>;

  patch(patch: E_<S>['patch']): Query<MutationState<S, 'number', {}>>;
  update(row: E_<S>['insert']): Query<MutationState<S, 'number', {}>>;
  patchAndFetchById(
    id: IdValue<R_<S>, K_<S>>,
    patch: E_<S>['patch'],
  ): Query<MutationState<S, 'maybe', RowOf<R_<S>, K_<S>>>>;
  delete(): Query<MutationState<S, 'number', {}>>;
  deleteById(id: IdValue<R_<S>, K_<S>>): Query<MutationState<S, 'number', {}>>;
  relate(
    ids: IdValue<R_<S>, K_<S>> | readonly IdValue<R_<S>, K_<S>>[],
  ): Query<MutationState<S, 'number', {}>>;
  unrelate(): Query<MutationState<S, 'number', {}>>;

  /** Postgres / SQL Server. */
  returning<const Cols extends readonly (ColumnKeys<R_<S>, K_<S>> | '*')[]>(
    ...columns: Cols
  ): Query<
    With<
      S,
      {
        container: S['container'] extends 'number' ? 'array' : S['container'];
        row: '*' extends Cols[number]
          ? RowOf<R_<S>, K_<S>>
          : Simplify<Pick<RowOf<R_<S>, K_<S>>, Cols[number] & keyof RowOf<R_<S>, K_<S>>>>;
        selected: true;
      }
    >
  >;

  context(context: object): Query<S>;
  transacting(trx: TransactionOrKnex | undefined): Query<S>;
  timeout(ms: number, options?: { cancel?: boolean }): Query<S>;
  debug(): Query<S>;
  as(alias: string): Query<S>;
  toKnexQuery(): Knex.QueryBuilder;

  catch<T = never>(
    onrejected?: ((reason: any) => T | PromiseLike<T>) | null,
  ): Promise<Output<S> | T>;
  finally(onfinally?: (() => void) | null): Promise<Output<S>>;
}

// ---------------------------------------------------------------------------
// Model definitions and handles
// ---------------------------------------------------------------------------

export interface ModelSpec {
  table: string;
  columns: Columns;
  id: IdSpec;
  modifiers: string;
  /** The `base` class. Optional so that specs named without it keep working (`typeof Model`). */
  base?: ModelConstructor<Model>;
}

/** For lib/: `base`'s constraint, and its default (objection's `Model`). */
export type BaseClass = ModelConstructor<Model>;

export type DefaultBase = typeof Model;

type BaseOf<Sp extends ModelSpec> = Sp extends { base: infer B extends ModelConstructor<Model> }
  ? B
  : typeof Model;

/**
 * Hooks see the base's instance members without the column fields: the column's schema is what
 * validates and types the field, and the update and delete hooks get it partial.
 */
type HookInstance<B extends ModelConstructor<Model>, Row> = Omit<InstanceType<B>, keyof Row>;

/** Fields the base declares with a type the column's values don't fit, e.g. `id!: string`. */
type ClashingKeys<I, Row> = {
  [K in keyof Row & keyof I]: [Row[K]] extends [I[K]] ? never : K;
}[keyof Row & keyof I];

/**
 * Instances of the generated class: the base's instance plus the row. The intersection keeps
 * objection's `this`-typed members (`QueryBuilderType`, `$query()`, custom query builders) bound
 * to the full instance. On a clash the column wins, and since `Omit` binds those members to the
 * base's instance type, it's only used then.
 */
type ModelInstanceOf<B extends ModelConstructor<Model>, Row> = ([
  ClashingKeys<InstanceType<B>, Row>,
] extends [never]
  ? InstanceType<B>
  : Omit<InstanceType<B>, ClashingKeys<InstanceType<B>, Row>>)
& Row;

/**
 * The generated class: the base's own statics, and objection's static side typed for its
 * instances. `Model`'s statics are dropped from `B`, because `B`'s own `query()` and friends
 * would bind `this` to `B` and return instances without the row.
 */
type ModelClassOf<B extends ModelConstructor<Model>, Row> = Omit<B, keyof typeof Model>
  & ModelClassFor<ModelInstanceOf<B, Row>>;

/** The fallback is for a column that clashes with one of `Model`'s own members. */
type ModelClassFor<I> = I extends Model ? ModelClass<I> : ModelClass<Model>;

type SelfRegistry<Sp extends ModelSpec> = { '~self': SpecEntry<Sp, {}> };

/**
 * Hooks receive the model instance: `Instance` is what the base class adds to the row
 * (`defineModel` passes the base's instance members, objection's `Model` without a `base`).
 */
export interface Hooks<Row, Instance = {}> {
  beforeInsert?: (row: Instance & Row, context: QueryContext) => void | Promise<void>;
  afterInsert?: (row: Instance & Row, context: QueryContext) => void | Promise<void>;
  beforeUpdate?: (
    row: Instance & Partial<Row>,
    options: ModelOptions,
    context: QueryContext,
  ) => void | Promise<void>;
  afterUpdate?: (
    row: Instance & Partial<Row>,
    options: ModelOptions,
    context: QueryContext,
  ) => void | Promise<void>;
  afterFind?: (row: Instance & Row, context: QueryContext) => void | Promise<void>;
  beforeDelete?: (row: Instance & Partial<Row>, context: QueryContext) => void | Promise<void>;
  afterDelete?: (row: Instance & Partial<Row>, context: QueryContext) => void | Promise<void>;
}

/** Shared by model definitions and handles to classic models. */
export interface ModelHandle<R extends Registry, K> {
  /** Phantom: the registry and model key this handle is typed with. */
  readonly '~types': { registry: R; model: K };
  readonly name: string;
  readonly table: EntryOf<R, K>['table'];
  /**
   * The generated (or wrapped classic) model class. Use it where objection expects a class,
   * e.g. `modelClass: () => db.Person.modelClass` in a classic model's `relationMappings`.
   * A generated class keeps its `base`'s statics, and its instances are the base's plus the row.
   */
  readonly modelClass: EntryOf<R, K>['modelClass'];
  readonly isObjectionModelDefinition: true;

  query(trxOrKnex?: TransactionOrKnex): Query<InitialState<R, K>>;
  relatedQuery<Rel extends StrKeys<RelationsOf<R, K>>>(
    relation: Rel,
    trxOrKnex?: TransactionOrKnex,
  ): Query<
    InitialState<R, TargetOf<R, K, Rel>> extends infer S extends QueryState
      ? With<S, { row: Simplify<S['row'] & ExtraOfRelation<R, K, Rel>> }>
      : never
  >;
  /** Validate input like an insert (or a patch with `{ patch: true }`) without a database. */
  validate(json: EntryOf<R, K>['insert'] | object, options?: { patch?: false }): RowOf<R, K>;
  validate(json: EntryOf<R, K>['patch'] | object, options: { patch: true }): Partial<RowOf<R, K>>;
  fromJson(json: EntryOf<R, K>['insert'], options?: ModelOptions): RowOf<R, K>;
  ref(column: ColumnKeys<R, K>): ReferenceBuilder;
  bindKnex(knex: TransactionOrKnex): this;
}

export interface ModelDefinition<Sp extends ModelSpec = ModelSpec>
  extends ModelHandle<SelfRegistry<Sp>, '~self'> {
  readonly '~spec': Sp;
  readonly columns: Sp['columns'];
  readonly idColumn: Sp['id'];
}

/** Brands used as constraints. Comparing full generic handles structurally is both slow and too strict. */
export type AnyModelDefinition = {
  readonly isObjectionModelDefinition: true;
  readonly '~spec': ModelSpec;
};

export type AnyModelHandle = { readonly '~types': { registry: Registry; model: unknown } };

type ModifierQuery<
  C extends Columns,
  Id extends IdSpec,
  T extends string,
  B extends ModelConstructor<Model>,
> = Query<
  InitialState<SelfRegistry<{ table: T; columns: C; id: Id; modifiers: string; base: B }>, '~self'>
>;

export interface ModelConfig<
  T extends string,
  C extends Columns,
  Id extends IdSpec,
  M extends string,
  B extends ModelConstructor<Model> = ModelConstructor<Model>,
> {
  /** Name of the generated class (shows up in errors and stack traces). */
  name?: string;
  table: T;
  columns: C;
  /** Id column(s). Defaults to `'id'`. */
  id?: Id;
  modifiers?: Record<M, (query: ModifierQuery<C, Id, T, B>, ...args: any[]) => void>;
  hooks?: Hooks<RowOfColumns<C>, HookInstance<B, RowOfColumns<C>>>;
  /**
   * Base model class, e.g. one with plugins mixed in. Defaults to `Model`. `modelClass` keeps
   * its statics, and its instances (and the hooks' `row`) have its members.
   */
  base?: B;
  /** Set to `false` to skip runtime validation (types only). */
  validate?: boolean;
}

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

/** A classic model class. Inferring through `ModelClass<M>` yields `Model | M`, so match the constructor. */
type ClassicModelClass<M extends Model = Model> = (abstract new (...args: any[]) => M) & {
  readonly tableName: unknown;
};

type InstanceOf<C> = C extends abstract new (...args: any[]) => infer M
  ? M extends Model
    ? M
    : never
  : never;

export type ModelsInput = Record<string, AnyModelDefinition | ClassicModelClass>;

type ColumnsOfInput<X> = X extends { '~spec': infer Sp extends ModelSpec }
  ? StrKeys<Sp['columns']>
  : X extends ClassicModelClass
    ? StrKeys<Omit<ModelObject<InstanceOf<X>>, ClassicRelationKeys<InstanceOf<X>>>>
    : never;

type JoinColumns<X> = ColumnsOfInput<X> | readonly ColumnsOfInput<X>[];

export interface RelationSpec<
  Kind extends 'one' | 'many',
  Target extends string,
  Extra extends object = {},
  Filled extends string = never,
> {
  readonly '~kind': Kind;
  readonly '~target': Target;
  readonly '~extra': Extra;
  readonly '~filled': Filled;
}

type KeysOf<X> = X extends readonly (infer E)[] ? E : X;

interface RelationOptions {
  /** Modifier name(s) or a function applied to every query of the relation. */
  modify?: string | readonly string[] | ((query: QueryBuilder<any, any>) => void);
  beforeInsert?: (model: any, context: QueryContext) => void | Promise<void>;
}

interface Join<M extends ModelsInput, K extends keyof M, T extends keyof M> {
  from: JoinColumns<M[K]>;
  to: JoinColumns<M[T]>;
}

type ExtraInput = readonly string[] | Record<string, ColumnInput>;

type ExtraOf<X> = X extends readonly string[]
  ? { [P in X[number]]: unknown }
  : X extends Record<string, ColumnInput>
    ? { -readonly [P in keyof X]: ColOut<X[P]> }
    : {};

export interface RelationBuilder<M extends ModelsInput, K extends keyof M> {
  hasMany<T extends StrKeys<M>, const J extends Join<M, K, T>>(
    target: T,
    join: J,
    options?: RelationOptions,
  ): RelationSpec<'many', T, {}, KeysOf<J['to']>>;
  hasOne<T extends StrKeys<M>, const J extends Join<M, K, T>>(
    target: T,
    join: J,
    options?: RelationOptions,
  ): RelationSpec<'one', T, {}, KeysOf<J['to']>>;
  belongsToOne<T extends StrKeys<M>>(
    target: T,
    join: Join<M, K, T>,
    options?: RelationOptions,
  ): RelationSpec<'one', T>;
  manyToMany<T extends StrKeys<M>, const X extends ExtraInput = []>(
    target: T,
    join: Join<M, K, T> & {
      through: {
        table: string;
        from: string | readonly string[];
        to: string | readonly string[];
        extra?: X;
      };
    },
    options?: RelationOptions,
  ): RelationSpec<'many', T, ExtraOf<X>>;
  hasOneThrough<T extends StrKeys<M>>(
    target: T,
    join: Join<M, K, T> & {
      through: { table: string; from: string | readonly string[]; to: string | readonly string[] };
    },
    options?: RelationOptions,
  ): RelationSpec<'one', T>;
}

export type RelationSpecs = Record<string, RelationSpec<any, any, any, any>>;

/**
 * Inferred as a reverse mapped type: `Rels` is the *return types* of the
 * callbacks, which lets TypeScript contextually type each callback's builder.
 */
export type RelationsInput<M extends ModelsInput, Rels> = {
  [K in keyof Rels]: K extends keyof M
    ? M[K] extends AnyModelDefinition
      ? (r: RelationBuilder<M, K>) => Rels[K]
      : never
    : never;
};

type DescriptorsOf<O> = {
  [Rel in keyof O]: O[Rel] extends RelationSpec<infer Kind, infer Target, infer Extra, infer Filled>
    ? { kind: Kind; target: Target; extra: Extra; filled: Filled }
    : never;
};

// --- relations(Model, (r) => ({ ... })) -------------------------------------

type ModelInput = AnyModelDefinition | ClassicModelClass;

export interface ModelRelationSpec<
  Kind extends 'one' | 'many',
  Target extends ModelInput,
  Extra extends object = {},
  Filled extends string = never,
> {
  readonly '~kind': Kind;
  readonly '~targetModel': Target;
  readonly '~extra': Extra;
  readonly '~filled': Filled;
}

interface ModelJoin<O, T> {
  from: JoinColumns<O>;
  to: JoinColumns<T>;
}

/** Like `RelationBuilder`, but targets are models instead of registry names. */
export interface ModelRelationBuilder<O extends AnyModelDefinition> {
  hasMany<T extends ModelInput, const J extends ModelJoin<O, T>>(
    target: T,
    join: J,
    options?: RelationOptions,
  ): ModelRelationSpec<'many', T, {}, KeysOf<J['to']>>;
  hasOne<T extends ModelInput, const J extends ModelJoin<O, T>>(
    target: T,
    join: J,
    options?: RelationOptions,
  ): ModelRelationSpec<'one', T, {}, KeysOf<J['to']>>;
  belongsToOne<T extends ModelInput>(
    target: T,
    join: ModelJoin<O, T>,
    options?: RelationOptions,
  ): ModelRelationSpec<'one', T>;
  manyToMany<T extends ModelInput, const X extends ExtraInput = []>(
    target: T,
    join: ModelJoin<O, T> & {
      through: {
        table: string;
        from: string | readonly string[];
        to: string | readonly string[];
        extra?: X;
      };
    },
    options?: RelationOptions,
  ): ModelRelationSpec<'many', T, ExtraOf<X>>;
  hasOneThrough<T extends ModelInput>(
    target: T,
    join: ModelJoin<O, T> & {
      through: { table: string; from: string | readonly string[]; to: string | readonly string[] };
    },
    options?: RelationOptions,
  ): ModelRelationSpec<'one', T>;
}

export interface RelationDeclaration<
  O extends AnyModelDefinition = AnyModelDefinition,
  Rels = unknown,
> {
  readonly isObjectionRelationDeclaration: true;
  readonly '~owner': O;
  readonly '~relations': Rels;
}

type Same<A, B>
  = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;

type SameModel<A, B> = A extends { '~spec': infer SA }
  ? B extends { '~spec': infer SB }
    ? Same<SA, SB>
    : false
  : Same<A, B>;

/** The registry key of a model (definition or classic class), or `never`. */
type KeyOfModel<M, T> = {
  [K in StrKeys<M>]: SameModel<M[K], T> extends true ? K : never;
}[StrKeys<M>];

type DeclarationOwnerKey<M, Decl>
  = Decl extends RelationDeclaration<infer O, any> ? KeyOfModel<M, O> : never;

type DeclarationDescriptors<M, K, D extends readonly unknown[]> = UnionToIntersection<
  {
    [I in keyof D]: D[I] extends RelationDeclaration<any, infer Rels>
      ? [DeclarationOwnerKey<M, D[I]>] extends [K]
          ? [DeclarationOwnerKey<M, D[I]>] extends [never]
              ? never
              : {
                  [N in keyof Rels]: Rels[N] extends ModelRelationSpec<
                    infer Kind,
                    infer T,
                    infer X,
                    infer F
                  >
                    ? { kind: Kind; target: KeyOfModel<M, T>; extra: X; filled: F }
                    : never;
                }
          : never
      : never;
  }[number]
>;

// --- column(schema).references(...) -----------------------------------------

type ColumnsOfModel<X> = X extends { '~spec': infer Sp extends ModelSpec } ? Sp['columns'] : {};

type ReferenceAt<M, J, P> = ReferenceOfColumn<
  ColumnsOfModel<M[J & keyof M]>[P & keyof ColumnsOfModel<M[J & keyof M]>]
>;

/** Mirrors the runtime: `as`, else the column name without a trailing `_id` / `Id`. */
type ForwardName<P extends string, R extends ColumnReference> = R['as'] extends string
  ? R['as']
  : P extends `${infer N}_id`
    ? N
    : P extends `${infer N}Id`
      ? N
      : never;

/** Every `"Model.column"` that has a reference. */
type ReferenceSites<M> = {
  [J in StrKeys<M>]: {
    [P in StrKeys<ColumnsOfModel<M[J]>>]: ReferenceAt<M, J, P> extends ColumnReference
      ? `${J}.${P}`
      : never;
  }[StrKeys<ColumnsOfModel<M[J]>>];
}[StrKeys<M>];

type ReferenceDescriptors<M, K> = UnionToIntersection<
  | {
    [P in StrKeys<ColumnsOfModel<M[K & keyof M]>>]: ReferenceAt<M, K, P> extends infer R extends
    ColumnReference
      ? {
          [N in ForwardName<P, R>]: {
            kind: 'one';
            target: R['target'];
            extra: {};
            filled: never;
          };
        }
      : never;
  }[StrKeys<ColumnsOfModel<M[K & keyof M]>>]
  | {
    [Site in ReferenceSites<M>]: Site extends `${infer J}.${infer P}`
      ? ReferenceAt<M, J, P> extends infer R extends ColumnReference
        ? R['target'] extends K
          ? R['inverse'] extends string
            ? { [N in R['inverse']]: { kind: R['inverseKind']; target: J; extra: {}; filled: P } }
            : never
          : never
        : never
      : never;
  }[ReferenceSites<M>]
>;

// --- merging and checking ----------------------------------------------------

/**
 * Every relation definition in the registry as an `"Owner|name|site"` string. Conflict
 * checks run on this flat union: building per-model maps of definition sites and comparing
 * them pairwise was roughly cubic in the registry size (40 models hit TS2589).
 */
type RelationDefinitions<M, Rels, D extends readonly unknown[]>
  = | { [K in StrKeys<Rels>]: `${K}|${StrKeys<Rels[K]>}|keyed` }[StrKeys<Rels>]
    | {
      [I in keyof D]: D[I] extends RelationDeclaration<any, infer RR>
        ? `${DeclarationOwnerKey<M, D[I]>}|${StrKeys<RR>}|relations:${I & string}`
        : never;
    }[number]
    | {
      [Site in ReferenceSites<M>]: Site extends `${infer J}.${infer P}`
        ? ReferenceAt<M, J, P> extends infer R extends ColumnReference
          ? | `${J}|${ForwardName<P, R>}|${Site}`
          | (R['inverse'] extends string
            ? `${R['target']}|${R['inverse']}|${Site}:inverse`
            : never)
          : never
        : never;
    }[ReferenceSites<M>];

type DuplicateErrors<
  U extends string,
  All extends string = U,
> = U extends `${infer K}|${infer N}|${string}`
  ? [Exclude<Extract<All, `${K}|${N}|${string}`>, U>] extends [never]
      ? never
      : `relation "${K}.${N}" is defined more than once`
  : never;

// Only models in the registry: for an unknown one (already reported by ReferenceErrors)
// the lookup would yield every string as a "column".
type ColumnNameErrors<
  M,
  U extends string,
> = U extends `${infer K extends StrKeys<M>}|${infer N}|${string}`
  ? N extends StrKeys<ColumnsOfModel<M[K]>>
    ? `relation "${K}.${N}" has the same name as a column`
    : never
  : never;

type ReferenceErrors<M> = {
  [Site in ReferenceSites<M>]: Site extends `${infer J}.${infer P}`
    ? ReferenceAt<M, J, P> extends infer R extends ColumnReference
      ? R['target'] extends StrKeys<M>
        ? | (R['column'] extends ColumnsOfInput<M[R['target']]>
          ? never
          : `${Site}.references(): unknown column "${R['target']}.${R['column']}"`)
        | ([ForwardName<P, R>] extends [never]
          ? `${Site}.references(): needs an \`as\` relation name`
          : never)
        | (R['inverse'] extends string
          ? M[R['target']] extends AnyModelDefinition
            ? never
            : `${Site}.references(): "${R['target']}" is a classic model class and can't get the inverse relation "${R['inverse']}"`
          : never)
        : `${Site}.references(): unknown model "${R['target']}"`
      : never
    : never;
}[ReferenceSites<M>];

type DeclarationErrors<M, D extends readonly unknown[]> = {
  [I in keyof D]: D[I] extends RelationDeclaration<any, infer Rels>
    ? | ([DeclarationOwnerKey<M, D[I]>] extends [never]
      ? `relations() declared for a model that isn't part of this registry`
      : never)
    | {
      [N in StrKeys<Rels>]: Rels[N] extends ModelRelationSpec<any, infer T, any, any>
        ? [KeyOfModel<M, T>] extends [never]
            ? `relation "${N}" points to a model that isn't part of this registry`
            : never
        : never;
    }[StrKeys<Rels>]
    : never;
}[number];

type NameErrors<M, Rels, D extends readonly unknown[]>
  = RelationDefinitions<M, Rels, D> extends infer U extends string
    ? DuplicateErrors<U> | ColumnNameErrors<M, U>
    : never;

/**
 * The errors `defineModels(models, declarations, relations)` reports for a registry, as a
 * union of messages (`never` when it's valid). Mainly useful for testing.
 */
export type RelationErrors<
  M extends ModelsInput,
  D extends readonly unknown[] = [],
  Rels = {},
> = RelationErrorsOf<M, D, Rels>;

type RelationErrorsOf<M, D extends readonly unknown[], Rels>
  = | ReferenceErrors<M>
    | DeclarationErrors<M, D>
    | NameErrors<M, Rels, D>;

export type CheckRelations<M, Rels, D extends readonly unknown[]>
  = RelationErrorsOf<M, D, Rels> extends infer E
    ? [E] extends [never]
        ? unknown
        : { '~error': E }
    : never;

type RelationsOfModel<M, Rels, D extends readonly unknown[], K> = (K extends keyof Rels
  ? DescriptorsOf<Rels[K]>
  : {})
& DeclarationDescriptors<M, K, D>
& ReferenceDescriptors<M, K>;

export type RegistryOf<M extends ModelsInput, Rels, D extends readonly unknown[] = []> = {
  [K in StrKeys<M>]: M[K] extends { '~spec': infer Sp extends ModelSpec }
    ? Simplify<RelationsOfModel<M, Rels, D, K>> extends infer R extends Record<
      string,
      RelationDescriptor
    >
      ? SpecEntry<Sp, R>
      : SpecEntry<Sp, {}>
    : M[K] extends ClassicModelClass
      ? ClassicEntry<InstanceOf<M[K]>>
      : never;
};

export type Models<M extends ModelsInput, Rels, D extends readonly unknown[] = []> = {
  [K in StrKeys<M>]: ModelHandle<RegistryOf<M, Rels, D>, K>
    & (M[K] extends { '~spec': infer Sp extends ModelSpec }
      ? Pick<ModelDefinition<Sp>, 'columns' | 'idColumn' | '~spec'>
      : {});
};

// ---------------------------------------------------------------------------
// Inference helpers
// ---------------------------------------------------------------------------

type HandleInfo<H extends AnyModelHandle> = { r: H['~types']['registry']; k: H['~types']['model'] };

/** The row type of a model: `Row<typeof db.Person>` */
export type Row<H extends AnyModelHandle> = Simplify<RowOf<HandleInfo<H>['r'], HandleInfo<H>['k']>>;

/** The insert input type of a model. */
export type Insert<H extends AnyModelHandle> = EntryOf<
  HandleInfo<H>['r'],
  HandleInfo<H>['k']
>['insert'];

/** The patch input type of a model. */
export type Patch<H extends AnyModelHandle> = EntryOf<
  HandleInfo<H>['r'],
  HandleInfo<H>['k']
>['patch'];

/** The resolved result of a typed query: `Result<typeof query>` */
export type Result<Q extends AnyQuery> = Q['~result'];

/** A row together with relations, as returned by `withGraphFetched(expression)`. */
export type RowWithGraph<
  H extends AnyModelHandle,
  X extends RelationExpressionInput<HandleInfo<H>['r'], HandleInfo<H>['k']>,
> = Simplify<
  RowOf<HandleInfo<H>['r'], HandleInfo<H>['k']>
  & GraphResult<HandleInfo<H>['r'], HandleInfo<H>['k'], ToExpressionObject<X>>
>;
