import { classicModelHandle, isModelHandle } from "./defineModel.mjs";
import { BelongsToOneRelation, HasManyRelation, HasOneRelation, HasOneThroughRelation, isModelClass, ManyToManyRelation, } from "./objection.mjs";
// The model classes of definitions that are part of a registry. Relations are set on the
// class itself, so a second registry would silently replace the first one's relations.
//
// The CommonJS and ES module builds are two copies of this file, and an app may load both
// (`require` and `import`). They share the set through a global symbol, as do other installed
// versions of the package, since they'd set relations on the same classes too.
const REGISTERED = Symbol.for('objection-schema.registered');
// SAFETY: only this file sets the property, and always to a set of model classes.
const shared = globalThis;
const registered = shared[REGISTERED] || (shared[REGISTERED] = new WeakSet());
export function defineModels(models, ...sources) {
    const { declarations, relations } = parseSources(sources);
    const registry = createRegistry(models);
    const collected = Object.create(null);
    const add = (ownerKey, name, spec, source) => {
        const owner = registry.byKey[ownerKey];
        if (!owner.definition) {
            throw new Error(`defineModels: cannot add relation "${ownerKey}.${name}" (${source}): "${ownerKey}" is a classic model class. Classic models keep using \`relationMappings\`.`);
        }
        if (owner.columns && Object.hasOwn(owner.columns, name)) {
            throw new Error(`defineModels: relation "${ownerKey}.${name}" (${source}) has the same name as a column of "${ownerKey}"`);
        }
        const relationsOfOwner = collected[ownerKey] || (collected[ownerKey] = Object.create(null));
        const existing = relationsOfOwner[name];
        if (existing) {
            throw new Error(`defineModels: relation "${ownerKey}.${name}" is defined more than once: ${existing.source} and ${source}`);
        }
        relationsOfOwner[name] = { spec, source };
    };
    // 1. Foreign keys.
    for (const ownerKey of Object.keys(registry.byKey)) {
        const { columns } = registry.byKey[ownerKey];
        for (const prop of Object.keys(columns || {})) {
            // SAFETY: `columns` is non-null here, since a null one has no keys to loop over.
            const col = columns[prop];
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
            throw new Error(`defineModels: relations() declared for a model that isn't part of this registry (${describe(declaration.owner)})`);
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
            const mappings = {};
            for (const name of Object.keys(relationsOfOwner)) {
                mappings[name] = toRelationMapping(ownerClass, relationsOfOwner[name].spec, registry, ownerKey);
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
export function relations(owner, define) {
    if (!isModelHandle(owner)) {
        throw new Error('relations() expects a defineModel() definition as its first argument');
    }
    if (typeof define !== 'function') {
        throw new Error('relations() expects a function as its second argument');
    }
    // SAFETY: `define` is the user's callback, typed by the public overload above.
    return Object.freeze({ isObjectionRelationDeclaration: true, owner, define: define });
}
function parseSources(sources) {
    let declarations = [];
    let relations = {};
    for (const source of sources) {
        // Stryker disable next-line BlockStatement: an empty branch skips the other branches just like `continue`.
        if (source === undefined) {
            continue;
        }
        else if (Array.isArray(source)) {
            for (const declaration of source) {
                if (!declaration || declaration.isObjectionRelationDeclaration !== true) {
                    throw new Error('defineModels: the declarations array may only contain relations() results');
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
function createRegistry(models) {
    const byKey = Object.create(null);
    const keys = new Map();
    const handles = {};
    for (const key of Object.keys(models)) {
        const model = models[key];
        if (isModelHandle(model)) {
            if (keys.has(model)) {
                throw new Error(`defineModels: "${key}" is the same definition as "${keys.get(model)}". Call defineModel() again for a second model over the same table.`);
            }
            if (registered.has(model.modelClass)) {
                throw new Error(`defineModels: "${key}" (${model.name}) is already part of another registry. A definition's relations are set on its model class, so it can only be in one registry; call defineModel() again for another one.`);
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
            throw new Error(`defineModels: "${key}" is neither a defineModel() definition nor a Model class`);
        }
    }
    return { byKey, handles, keyOf: model => keys.get(model) };
}
function addReferenceRelations(registry, ownerKey, prop, ref, add) {
    const source = `${ownerKey}.${prop}.references()`;
    const target = registry.byKey[ref.target];
    if (!target) {
        throw new Error(`defineModels: ${source} points to unknown model "${ref.target}"`);
    }
    if (target.columns && !Object.hasOwn(target.columns, ref.column)) {
        throw new Error(`defineModels: ${source} points to unknown column "${ref.target}.${ref.column}"`);
    }
    const name = ref.as || forwardName(prop);
    if (!name) {
        throw new Error(`defineModels: ${source} needs an \`as\` relation name (it can only be derived from columns ending in "Id" or "_id")`);
    }
    add(ownerKey, name, spec(BelongsToOneRelation, ref.target, { from: prop, to: ref.column }), source);
    if (ref.inverse) {
        const relation = ref.inverseKind === 'one' ? HasOneRelation : HasManyRelation;
        add(ref.target, ref.inverse, spec(relation, ownerKey, { from: ref.column, to: prop }), `${source} inverse`);
    }
}
function forwardName(prop) {
    // Stryker disable next-line Regex: without `^` the leftmost match still starts at 0.
    const match = /^(.+?)(?:Id|_id)$/.exec(prop);
    return match ? match[1] : null;
}
const relationBuilder = Object.freeze({
    hasMany: (target, join, opt) => spec(HasManyRelation, target, join, opt),
    hasOne: (target, join, opt) => spec(HasOneRelation, target, join, opt),
    belongsToOne: (target, join, opt) => spec(BelongsToOneRelation, target, join, opt),
    manyToMany: (target, join, opt) => spec(ManyToManyRelation, target, join, opt),
    hasOneThrough: (target, join, opt) => spec(HasOneThroughRelation, target, join, opt),
});
// Same as `relationBuilder`, but targets are models instead of registry names.
function createDeclarationBuilder(registry, ownerKey) {
    const keyOf = (target) => {
        const key = registry.keyOf(target);
        if (!key) {
            throw new Error(`defineModels: a relation of "${ownerKey}" points to a model that isn't part of this registry (${describe(target)})`);
        }
        return key;
    };
    const builder = {};
    for (const method of Object.keys(relationBuilder)) {
        builder[method] = (target, join, opt) => relationBuilder[method](keyOf(target), join, opt);
    }
    return Object.freeze(builder);
}
function describe(model) {
    // SAFETY: only read; models, classes and definitions all have a `name`.
    const named = model;
    return (named && named.name) || String(model);
}
function spec(relation, target, join, opt = {}) {
    return { relation, target, join, opt };
}
function toRelationMapping(ownerClass, { relation, target, join, opt }, registry, ownerKey) {
    const targetEntry = registry.byKey[target];
    if (!targetEntry) {
        throw new Error(`defineModels: relation of "${ownerKey}" points to unknown model "${target}"`);
    }
    const targetClass = targetEntry.modelClass;
    const mapping = {
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
            extra: extra,
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
function qualify(table, cols) {
    return Array.isArray(cols) ? cols.map(col => `${table}.${col}`) : `${table}.${cols}`;
}
export function toQueryBuilder(query) {
    return query;
}
