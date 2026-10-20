import type { Model, QueryBuilder, RelationMapping, RelationMappings, RelationType } from 'objection';
import type { Reference } from './column';
import type { RuntimeHandle } from './defineModel';
import type { ModelClass } from './objection';
import type {
  AnyModelDefinition,
  AnyQuery,
  CheckRelations,
  ModelRelationBuilder,
  ModelRelationSpec,
  Models,
  ModelsInput,
  RelationDeclaration,
  RelationsInput,
  RelationSpecs,
} from './types';
import { classicModelHandle, isModelHandle } from './defineModel';
import {
  BelongsToOneRelation,
  HasManyRelation,
  HasOneRelation,
  HasOneThroughRelation,
  isModelClass,
  ManyToManyRelation,
} from './objection';

type JoinColumns = string | readonly string[];

interface Join {
  from: JoinColumns;
  to: JoinColumns;
  through?: { table: string; from: JoinColumns; to: JoinColumns; extra?: unknown };
}

interface RelationOptions {
  modify?: RelationMapping<Model>['modify'];
  beforeInsert?: RelationMapping<Model>['beforeInsert'];
}

/** What the relation builders return: a relation to a registry key. */
interface Spec {
  relation: RelationType;
  target: string;
  join: Join;
  opt: RelationOptions;
}

type RelationMethod = (target: string, join: Join, opt?: RelationOptions) => Spec;

type Builder = Readonly<Record<string, RelationMethod>>;

type Specs = Record<string, Spec>;

interface Declaration {
  readonly isObjectionRelationDeclaration: true;
  readonly owner: RuntimeHandle;
  readonly define: (builder: Readonly<Record<string, (target: unknown, join: Join, opt?: RelationOptions) => Spec>>) => Specs;
}

interface Entry {
  definition: RuntimeHandle | null;
  modelClass: ModelClass;
  columns: RuntimeHandle['columns'];
}

interface Registry {
  byKey: Record<string, Entry>;
  handles: Record<string, RuntimeHandle>;
  keyOf: (model: unknown) => string | undefined;
}

type Add = (ownerKey: string, name: string, spec: Spec, source: string) => void;

// The model classes of definitions that are part of a registry. Relations are set on the
// class itself, so a second registry would silently replace the first one's relations.
const registered = new WeakSet<ModelClass>();

// Relations are declared outside `defineModel()` so that models can reference each
// other (and themselves) without the circular type inference problems that a
// `relations: { pets: hasMany(() => Animal) }` style API runs into in TypeScript.
//
// They can come from three places, which are merged here:
//
//   1. `column(schema).references('Person', 'id', { as, inverse })` foreign keys,
//   2. `relations(Person, (r) => ({ ... }))` declarations, passed in an array,
//   3. a `{ Person: (r) => ({ ... }) }` object keyed by registry name.
//
// Defining the same relation name twice for a model is an error, as is giving a
// relation the name of one of the model's columns.

/**
 * Creates the registry. Relations can come from `column().references()`, from
 * `relations(Model, ...)` declarations (array) and from a keyed object, in any
 * combination. Defining a relation name twice, or naming a relation like a
 * column, is a type error (and a runtime error).
 *
 * A definition can be part of one registry only (its relations are set on its model
 * class); passing it to a second `defineModels` call throws.
 */
export function defineModels<
  M extends ModelsInput,
  const D extends readonly RelationDeclaration[],
  Rels extends { [K in keyof M]?: RelationSpecs } = {},
>(
  models: M & CheckRelations<M, Rels, D>,
  declarations: D,
  relations?: RelationsInput<M, Rels>,
): Models<M, Rels, D>;
export function defineModels<
  M extends ModelsInput,
  Rels extends { [K in keyof M]?: RelationSpecs } = {},
>(models: M & CheckRelations<M, Rels, []>, relations?: RelationsInput<M, Rels>): Models<M, Rels>;
export function defineModels(
  models: Record<string, unknown>,
  ...sources: unknown[]
): object {
  const { declarations, relations } = parseSources(sources);
  const registry = createRegistry(models);
  const collected: Record<string, Record<string, { spec: Spec; source: string }>> = Object.create(null);

  const add: Add = (ownerKey, name, spec, source) => {
    const owner = registry.byKey[ownerKey];

    if (!owner.definition) {
      throw new Error(
        `defineModels: cannot add relation "${ownerKey}.${name}" (${source}): "${ownerKey}" is a classic model class. Classic models keep using \`relationMappings\`.`,
      );
    }

    if (owner.columns && Object.hasOwn(owner.columns, name)) {
      throw new Error(
        `defineModels: relation "${ownerKey}.${name}" (${source}) has the same name as a column of "${ownerKey}"`,
      );
    }

    const relationsOfOwner = collected[ownerKey] || (collected[ownerKey] = Object.create(null));
    const existing = relationsOfOwner[name];

    if (existing) {
      throw new Error(
        `defineModels: relation "${ownerKey}.${name}" is defined more than once: ${existing.source} and ${source}`,
      );
    }

    relationsOfOwner[name] = { spec, source };
  };

  // 1. Foreign keys.
  for (const ownerKey of Object.keys(registry.byKey)) {
    const { columns } = registry.byKey[ownerKey];

    for (const prop of Object.keys(columns || {})) {
      // SAFETY: `columns` is non-null here, since a null one has no keys to loop over.
      const col = (columns as NonNullable<typeof columns>)[prop];
      const ref = col && col['~column'] && col['~column'].references;

      if (ref) {
        addReferenceRelations(registry, ownerKey, prop, ref, add);
      }
    }
  }

  // 2. `relations(Model, ...)` declarations.
  for (const declaration of declarations) {
    const ownerKey = registry.keyOf(declaration.owner);

    if (!ownerKey) {
      throw new Error(
        `defineModels: relations() declared for a model that isn't part of this registry (${describe(declaration.owner)})`,
      );
    }

    const specs = declaration.define(createDeclarationBuilder(registry, ownerKey));

    for (const name of Object.keys(specs)) {
      add(ownerKey, name, specs[name], `relations(${ownerKey})`);
    }
  }

  // 3. Keyed relations object.
  for (const ownerKey of Object.keys(relations)) {
    if (!registry.byKey[ownerKey]) {
      throw new Error(`defineModels: relations given for unknown model "${ownerKey}"`);
    }

    const specs = relations[ownerKey](relationBuilder);

    for (const name of Object.keys(specs)) {
      add(ownerKey, name, specs[name], `defineModels relations for ${ownerKey}`);
    }
  }

  for (const ownerKey of Object.keys(collected)) {
    const ownerClass = registry.byKey[ownerKey].modelClass;
    const relationsOfOwner = collected[ownerKey];

    ownerClass.relationMappings = () => {
      const mappings: RelationMappings = {};

      for (const name of Object.keys(relationsOfOwner)) {
        mappings[name] = toRelationMapping(
          ownerClass,
          relationsOfOwner[name].spec,
          registry,
          ownerKey,
        );
      }

      return mappings;
    };
  }

  // Only once the registry is complete, so that fixing an error and calling again works.
  // Classic classes are added too, but only definitions are checked.
  for (const key of Object.keys(registry.byKey)) {
    registered.add(registry.byKey[key].modelClass);
  }

  return registry.handles;
}

/**
 * Declares relations next to a model. Pass the result to `defineModels` in an array.
 * The callback is called by `defineModels`, so circular imports between model files are fine.
 *
 * `relations(Person, (r) => ({ pets: r.hasMany(Animal, { from: 'id', to: 'ownerId' }) }))`
 *
 * Unlike the keyed form, targets are definitions (or classic classes) instead of
 * registry names, so declarations can live next to their models.
 */
export function relations<
  O extends AnyModelDefinition,
  Rels extends Record<string, ModelRelationSpec<any, any, any, any>>,
>(owner: O, define: (r: ModelRelationBuilder<O>) => Rels): RelationDeclaration<O, Rels>;
export function relations(owner: unknown, define: unknown): object {
  if (!isModelHandle(owner)) {
    throw new Error('relations() expects a defineModel() definition as its first argument');
  }

  if (typeof define !== 'function') {
    throw new Error('relations() expects a function as its second argument');
  }

  // SAFETY: `define` is the user's callback, typed by the public overload above.
  return Object.freeze({ isObjectionRelationDeclaration: true, owner, define: define as Declaration['define'] });
}

interface Sources {
  declarations: Declaration[];
  relations: Record<string, (builder: Builder) => Specs>;
}

function parseSources(sources: unknown[]): Sources {
  let declarations: Declaration[] = [];
  let relations = {};

  for (const source of sources) {
    // Stryker disable next-line BlockStatement: an empty branch skips the other branches just like `continue`.
    if (source === undefined) {
      continue;
    }
    else if (Array.isArray(source)) {
      for (const declaration of source) {
        if (!declaration || declaration.isObjectionRelationDeclaration !== true) {
          throw new Error(
            'defineModels: the declarations array may only contain relations() results',
          );
        }
      }

      declarations = declarations.concat(source);
    }
    else if (source && typeof source === 'object') {
      relations = source;
    }
    else {
      throw new Error('defineModels: expected a relations() array and/or a relations object');
    }
  }

  return { declarations, relations };
}

function createRegistry(models: Record<string, unknown>): Registry {
  const byKey: Record<string, Entry> = Object.create(null);
  const keys = new Map<unknown, string>();
  const handles: Record<string, RuntimeHandle> = {};

  for (const key of Object.keys(models)) {
    const model = models[key];

    if (isModelHandle(model)) {
      if (keys.has(model)) {
        throw new Error(
          `defineModels: "${key}" is the same definition as "${keys.get(model)}". Call defineModel() again for a second model over the same table.`,
        );
      }

      if (registered.has(model.modelClass)) {
        throw new Error(
          `defineModels: "${key}" (${model.name}) is already part of another registry. A definition's relations are set on its model class, so it can only be in one registry; call defineModel() again for another one.`,
        );
      }

      byKey[key] = { definition: model, modelClass: model.modelClass, columns: model.columns };
      keys.set(model, key);
      handles[key] = model;
    }
    else if (isModelClass(model)) {
      byKey[key] = { definition: null, modelClass: model, columns: null };
      keys.set(model, key);
      handles[key] = classicModelHandle(model);
    }
    else {
      throw new Error(
        `defineModels: "${key}" is neither a defineModel() definition nor a Model class`,
      );
    }
  }

  return { byKey, handles, keyOf: model => keys.get(model) };
}

function addReferenceRelations(
  registry: Registry,
  ownerKey: string,
  prop: string,
  ref: Reference,
  add: Add,
): void {
  const source = `${ownerKey}.${prop}.references()`;
  const target = registry.byKey[ref.target];

  if (!target) {
    throw new Error(`defineModels: ${source} points to unknown model "${ref.target}"`);
  }

  if (target.columns && !Object.hasOwn(target.columns, ref.column)) {
    throw new Error(
      `defineModels: ${source} points to unknown column "${ref.target}.${ref.column}"`,
    );
  }

  const name = ref.as || forwardName(prop);

  if (!name) {
    throw new Error(
      `defineModels: ${source} needs an \`as\` relation name (it can only be derived from columns ending in "Id" or "_id")`,
    );
  }

  add(
    ownerKey,
    name,
    spec(BelongsToOneRelation, ref.target, { from: prop, to: ref.column }),
    source,
  );

  if (ref.inverse) {
    const relation = ref.inverseKind === 'one' ? HasOneRelation : HasManyRelation;
    add(
      ref.target,
      ref.inverse,
      spec(relation, ownerKey, { from: ref.column, to: prop }),
      `${source} inverse`,
    );
  }
}

function forwardName(prop: string): string | null {
  // Stryker disable next-line Regex: without `^` the leftmost match still starts at 0.
  const match = /^(.+?)(?:Id|_id)$/.exec(prop);

  return match ? match[1] : null;
}

const relationBuilder: Builder = Object.freeze({
  hasMany: (target, join, opt) => spec(HasManyRelation, target, join, opt),
  hasOne: (target, join, opt) => spec(HasOneRelation, target, join, opt),
  belongsToOne: (target, join, opt) => spec(BelongsToOneRelation, target, join, opt),
  manyToMany: (target, join, opt) => spec(ManyToManyRelation, target, join, opt),
  hasOneThrough: (target, join, opt) => spec(HasOneThroughRelation, target, join, opt),
} satisfies Builder);

// Same as `relationBuilder`, but targets are models instead of registry names.
function createDeclarationBuilder(registry: Registry, ownerKey: string): Parameters<Declaration['define']>[0] {
  const keyOf = (target: unknown) => {
    const key = registry.keyOf(target);

    if (!key) {
      throw new Error(
        `defineModels: a relation of "${ownerKey}" points to a model that isn't part of this registry (${describe(target)})`,
      );
    }

    return key;
  };

  const builder: Record<string, (target: unknown, join: Join, opt?: RelationOptions) => Spec> = {};

  for (const method of Object.keys(relationBuilder)) {
    builder[method] = (target, join, opt) => relationBuilder[method](keyOf(target), join, opt);
  }

  return Object.freeze(builder);
}

function describe(model: unknown): string {
  // SAFETY: only read; models, classes and definitions all have a `name`.
  const named = model as { name?: string } | null | undefined;

  return (named && named.name) || String(model);
}

function spec(relation: RelationType, target: string, join: Join, opt: RelationOptions = {}): Spec {
  return { relation, target, join, opt };
}

function toRelationMapping(
  ownerClass: ModelClass,
  { relation, target, join, opt }: Spec,
  registry: Registry,
  ownerKey: string,
): RelationMapping<Model> {
  const targetEntry = registry.byKey[target];

  if (!targetEntry) {
    throw new Error(`defineModels: relation of "${ownerKey}" points to unknown model "${target}"`);
  }

  const targetClass = targetEntry.modelClass;

  const mapping: RelationMapping<Model> = {
    relation,
    modelClass: targetClass,
    join: {
      from: qualify(ownerClass.getTableName(), join.from),
      to: qualify(targetClass.getTableName(), join.to),
    },
  };

  if (join.through) {
    const { table, from, to, extra } = join.through;
    mapping.join.through = {
      from: qualify(table, from),
      to: qualify(table, to),
      // SAFETY: passed on to objection as given; the typed builders only accept what it takes.
      extra: extra as NonNullable<RelationMapping<Model>['join']['through']>['extra'],
    };
  }

  // Stryker disable next-line ConditionalExpression: objection ignores an undefined `modify`.
  if (opt.modify) {
    mapping.modify = opt.modify;
  }

  // Stryker disable next-line ConditionalExpression: objection ignores an undefined `beforeInsert`.
  if (opt.beforeInsert) {
    mapping.beforeInsert = opt.beforeInsert;
  }

  return mapping;
}

function qualify(table: string, cols: JoinColumns): string | string[] {
  return Array.isArray(cols) ? cols.map(col => `${table}.${col}`) : `${table}.${cols}`;
}

/** Identity at runtime. Turns a typed query into a classic `QueryBuilder`. */
export function toQueryBuilder(query: AnyQuery): QueryBuilder<Model, any>;
export function toQueryBuilder<Q>(query: Q): Q {
  return query;
}
