import type { Model, QueryBuilder } from 'objection';
import type { AnyModelDefinition, AnyQuery, CheckRelations, ModelRelationBuilder, ModelRelationSpec, Models, ModelsInput, RelationDeclaration, RelationsInput, RelationSpecs } from "./types.js";
/**
 * Creates the registry. Relations can come from `column().references()`, from
 * `relations(Model, ...)` declarations (array) and from a keyed object, in any
 * combination. Defining a relation name twice, or naming a relation like a
 * column, is a type error (and a runtime error).
 *
 * A definition can be part of one registry only (its relations are set on its model
 * class); passing it to a second `defineModels` call throws.
 */
export declare function defineModels<M extends ModelsInput, const D extends readonly RelationDeclaration[], Rels extends {
    [K in keyof M]?: RelationSpecs;
} = {}>(models: M & CheckRelations<M, Rels, D>, declarations: D, relations?: RelationsInput<M, Rels>): Models<M, Rels, D>;
export declare function defineModels<M extends ModelsInput, Rels extends {
    [K in keyof M]?: RelationSpecs;
} = {}>(models: M & CheckRelations<M, Rels, []>, relations?: RelationsInput<M, Rels>): Models<M, Rels>;
/**
 * Declares relations next to a model. Pass the result to `defineModels` in an array.
 * The callback is called by `defineModels`, so circular imports between model files are fine.
 *
 * `relations(Person, (r) => ({ pets: r.hasMany(Animal, { from: 'id', to: 'ownerId' }) }))`
 *
 * Unlike the keyed form, targets are definitions (or classic classes) instead of
 * registry names, so declarations can live next to their models.
 */
export declare function relations<O extends AnyModelDefinition, Rels extends Record<string, ModelRelationSpec<any, any, any, any>>>(owner: O, define: (r: ModelRelationBuilder<O>) => Rels): RelationDeclaration<O, Rels>;
/** Identity at runtime. Turns a typed query into a classic `QueryBuilder`. */
export declare function toQueryBuilder(query: AnyQuery): QueryBuilder<Model, any>;
