// Type tests for the schema-first `defineModel` / `defineModels` API.
// Compiled by `npm run test:types`. Nothing here is executed.

import { z } from 'zod';
import * as v from 'valibot';
import { Model, raw, ref } from 'objection';
import {
  defineModel,
  defineModels,
  relations,
  column,
  defineModelNames,
  unchecked,
  toQueryBuilder,
  Row,
  Insert,
  Patch,
  Result,
  RowWithGraph,
} from 'objection-schema';

type Flat<T> = { [K in keyof T]: T[K] } & {};
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expectType<T extends true>() {}
declare function run<Q extends PromiseLike<any>>(query: Q): Awaited<Q>;

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const Person = defineModel({
  table: 'persons',
  columns: {
    id: column(z.number().int()).generated(),
    firstName: z.string().min(1),
    lastName: z.string(),
    age: z.number().int().nullable().optional(),
    address: column(z.object({ street: z.string(), city: z.string() }).nullable()).json(),
    parentId: z.number().nullable().optional(),
    status: z.enum(['active', 'inactive']).default('active'),
    createdAt: column(z.date()).hasDefault(),
  },
  modifiers: {
    adults: (q) => q.where('age', '>=', 18),
    // @ts-expect-error unknown column inside a modifier
    broken: (q) => q.where('agee', 1),
  },
});

const Animal = defineModel({
  table: 'animals',
  columns: {
    id: column(v.number()).generated(),
    name: v.string(),
    species: v.picklist(['dog', 'cat']),
    ownerId: v.nullable(v.number()),
  },
  modifiers: { dogs: (q) => q.where('species', 'dog') },
});

// A classic class-based model taking part in the same registry.
class Movie extends Model {
  static tableName = 'movies';
  id!: number;
  title!: string;
}

const PersonMovie = defineModel({
  table: 'persons_movies',
  id: ['personId', 'movieId'],
  columns: { personId: z.number(), movieId: z.number(), role: z.string() },
});

const db = defineModels(
  { Person, Animal, Movie, PersonMovie },
  {
    Person: (r) => ({
      pets: r.hasMany('Animal', { from: 'id', to: 'ownerId' }),
      parent: r.belongsToOne('Person', { from: 'parentId', to: 'id' }),
      children: r.hasMany('Person', { from: 'id', to: 'parentId' }),
      movies: r.manyToMany('Movie', {
        from: 'id',
        through: {
          table: 'persons_movies',
          from: 'personId',
          to: 'movieId',
          extra: { role: z.string() },
        },
        to: 'id',
      }),
    }),
    Animal: (r) => ({
      owner: r.belongsToOne('Person', { from: 'ownerId', to: 'id' }),
    }),
  },
);

defineModels(
  { Person, Animal },
  {
    Person: (r) => ({
      // @ts-expect-error `ownerIdd` is not a column of Animal
      pets: r.hasMany('Animal', { from: 'id', to: 'ownerIdd' }),
      // @ts-expect-error unknown target model
      nope: r.hasMany('Animals', { from: 'id', to: 'ownerId' }),
    }),
  },
);

// @ts-expect-error id must be one of the columns
defineModel({ table: 't', id: 'uuid', columns: { id: z.number() } });

// ---------------------------------------------------------------------------
// Inferred row / insert / patch types
// ---------------------------------------------------------------------------

type PersonRow = Row<typeof db.Person>;
expectType<
  Equal<
    PersonRow,
    {
      id: number;
      firstName: string;
      lastName: string;
      age: number | null | undefined;
      address: { street: string; city: string } | null;
      parentId: number | null | undefined;
      status: 'active' | 'inactive';
      createdAt: Date;
    }
  >
>();

type PersonInsert = Insert<typeof db.Person>;
// Required on insert: firstName, lastName, address. Generated / db default / schema default are optional.
expectType<Equal<keyof PersonInsert, keyof PersonRow>>();
const okInsert: PersonInsert = { firstName: 'a', lastName: 'b', address: null };
const okInsertWithRaw: PersonInsert = {
  firstName: raw('upper(?)', ['a']),
  lastName: 'b',
  address: null,
};
// @ts-expect-error lastName is required
const missing: PersonInsert = { firstName: 'a', address: null };
// @ts-expect-error wrong value type
const wrongType: PersonInsert = { firstName: 'a', lastName: 1, address: null };

type PersonPatch = Patch<typeof db.Person>;
const okPatch: PersonPatch = { age: 3 };
// @ts-expect-error status enum
const badPatch: PersonPatch = { status: 'deleted' };

// unchecked: type-only column
const Raw = defineModel({
  table: 'raw',
  columns: { id: unchecked<string>(), data: unchecked<{ a: 1 }>() },
});
expectType<Equal<Row<typeof Raw>, { id: string; data: { a: 1 } }>>();

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

async function queries() {
  // Plain find: plain row objects, no classes in sight.
  expectType<Equal<Awaited<ReturnType<typeof db.Person.query>>, PersonRow[]>>();

  // select narrows (and accumulates), aliases rename.
  const selected = await db.Person.query().select('id', 'firstName').select('lastName as surname');
  expectType<Equal<typeof selected, { id: number; firstName: string; surname: string }[]>>();

  // @ts-expect-error unknown column
  db.Person.query().select('nope');

  // where: columns and values are checked against the schema.
  db.Person.query().where('age', '>', 18).where('status', 'active').where({ firstName: 'x' });
  db.Person.query().where('persons.age', '>', 18).whereIn('id', [1, 2]).whereNull('parentId');
  db.Person.query()
    .where('firstName', ref('lastName'))
    .where((q) => q.where('age', 1).orWhere('age', 2));
  // @ts-expect-error status is an enum
  db.Person.query().where('status', 'deleted');
  // @ts-expect-error age is a number
  db.Person.query().where('age', '>', '18');
  // @ts-expect-error unknown column
  db.Person.query().where('agee', 18);
  // @ts-expect-error unknown column in object form
  db.Person.query().where({ agee: 18 });

  // first / findById / throwIfNotFound
  expectType<Equal<Awaited<ReturnType<typeof db.Person.query>>, PersonRow[]>>();
  const maybe = await db.Person.query().findById(1);
  expectType<Equal<typeof maybe, PersonRow | undefined>>();
  const sure = await db.Person.query().findById(1).throwIfNotFound();
  expectType<Equal<typeof sure, PersonRow>>();
  // @ts-expect-error id is a number
  db.Person.query().findById('1');
  // composite ids are tuples
  db.PersonMovie.query().findById([1, 2]);
  // @ts-expect-error composite id needs both parts
  db.PersonMovie.query().findById([1]);

  const page = await db.Person.query().select('id').page(0, 10);
  expectType<Equal<typeof page, { results: { id: number }[]; total: number }>>();

  // modifiers are checked by name
  db.Person.query().modify('adults');
  // @ts-expect-error unknown modifier
  db.Person.query().modify('adultz');

  // ---------------------------------------------------------------------------
  // Graphs
  // ---------------------------------------------------------------------------

  type AnimalRow = Row<typeof db.Animal>;
  type MovieRow = { id: number; title: string };

  const [p1] = await db.Person.query().withGraphFetched({ pets: true, parent: { pets: true } });
  expectType<Equal<typeof p1.pets, AnimalRow[]>>();
  expectType<Equal<typeof p1.parent, Flat<PersonRow & { pets: AnimalRow[] }> | null>>();

  // The string form is parsed at the type level.
  const [p2] = await db.Person.query().withGraphFetched('[pets.owner, movies, children(adults)]');
  expectType<Equal<typeof p2.pets, Flat<AnimalRow & { owner: PersonRow | null }>[]>>();
  // manyToMany `extra` columns are typed too
  expectType<Equal<typeof p2.movies, Flat<MovieRow & { role: string }>[]>>();
  // modifiers in string expressions are understood (and stripped for typing)
  const [p9] = await db.Person.query().withGraphFetched('children');
  expectType<Equal<typeof p2.children, typeof p9.children>>();
  expectType<Equal<typeof p9.children, PersonRow[]>>();

  // select + graph combine
  const [p3] = await db.Person.query().select('id').withGraphFetched('pets');
  expectType<Equal<typeof p3, { id: number; pets: AnimalRow[] }>>();

  // @ts-expect-error unknown relation (string)
  db.Person.query().withGraphFetched('pest');
  // @ts-expect-error unknown nested relation (string)
  db.Person.query().withGraphFetched('pets.ownr');
  // @ts-expect-error unknown relation (object)
  db.Person.query().withGraphFetched({ pets: true, pest: true });

  // modifyGraph paths come from the previous expression; the callback is typed for the target.
  db.Person.query()
    .withGraphFetched('pets.owner')
    .modifyGraph('pets', (q) => q.where('species', 'dog'))
    .modifyGraph('pets.owner', (q) => q.where('age', '>', 1));
  const petsQuery = db.Person.query().withGraphFetched('pets');
  // @ts-expect-error path not in the graph expression
  petsQuery.modifyGraph('parent', () => {});
  // @ts-expect-error callback is typed for Animal
  petsQuery.modifyGraph('pets', (q) => q.where('firstName', 'x'));

  // joins expose `relation.column` (and `parent:pets.column` for nested) references
  const joined = await db.Person.query()
    .joinRelated('[pets, parent.pets]')
    .where('pets.species', 'dog')
    .where('parent:pets.name', 'Rex')
    .select('persons.firstName', 'pets.name as petName');
  expectType<Equal<typeof joined, { firstName: string; petName: string }[]>>();
  // @ts-expect-error not joined
  db.Person.query().where('pets.species', 'dog');
  // @ts-expect-error species is an enum
  db.Person.query().joinRelated('pets').where('pets.species', 'cow');

  const withJoined = await db.Person.query().withGraphJoined('pets').where('pets.species', 'cat');
  expectType<Equal<(typeof withJoined)[number]['pets'], AnimalRow[]>>();

  // relatedQuery targets the related model
  const pets = await db.Person.relatedQuery('pets').for(1).where('species', 'cat');
  expectType<Equal<typeof pets, AnimalRow[]>>();
  // @ts-expect-error unknown relation
  db.Person.relatedQuery('pest');

  // Relations into a classic model use the class's own property types.
  const [m] = await db.Person.query().withGraphFetched('movies');
  expectType<Equal<(typeof m.movies)[number]['title'], string>>();

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  const inserted = await db.Person.query().insert({ firstName: 'a', lastName: 'b', address: null });
  // insert resolves to what was given, plus the id and schema defaults
  expectType<Equal<typeof inserted.id, number>>();
  expectType<Equal<typeof inserted.status, 'active' | 'inactive'>>();
  expectType<Equal<typeof inserted.createdAt, Date | undefined>>();
  // @ts-expect-error lastName missing
  db.Person.query().insert({ firstName: 'a', address: null });
  // @ts-expect-error excess property
  db.Person.query().insert({ firstName: 'a', lastName: 'b', address: null, nope: 1 });

  const fetched = await db.Person.query().insertAndFetch({
    firstName: 'a',
    lastName: 'b',
    address: null,
  });
  expectType<Equal<typeof fetched, PersonRow>>();

  const n = await db.Person.query().patch({ age: 1 }).where('id', 1);
  expectType<Equal<typeof n, number>>();
  // @ts-expect-error negative tests for patch values
  db.Person.query().patch({ age: 'old' });

  const returned = await db.Person.query().patch({ age: 1 }).returning('id', 'age');
  expectType<Equal<typeof returned, { id: number; age: number | null | undefined }[]>>();

  const deleted = await db.Person.query().delete().where('id', 1);
  expectType<Equal<typeof deleted, number>>();

  // graphs are checked all the way down
  const graph = await db.Person.query().insertGraph({
    firstName: 'a',
    lastName: 'b',
    address: null,
    pets: [{ name: 'Rex', species: 'dog', ownerId: null }],
    movies: [{ title: 'Up', role: 'Lead' }],
  });
  expectType<Equal<typeof graph.id, number>>();
  // @ts-expect-error species is an enum
  db.Person.query().insertGraph({
    firstName: 'a',
    lastName: 'b',
    address: null,
    pets: [{ name: 'Rex', species: 'cow', ownerId: null }],
  });
  // relate: true allows id references
  db.Person.query().insertGraph(
    { firstName: 'a', lastName: 'b', address: null, pets: [{ id: 1 }] },
    { relate: true },
  );
  db.Person.query().upsertGraph({ id: 1, firstName: 'x', pets: [{ id: 2, name: 'Rexy' }] });

  // ---------------------------------------------------------------------------
  // Interop
  // ---------------------------------------------------------------------------

  // Classic relation mappings use the class a definition generated.
  class Review extends Model {
    static tableName = 'reviews';
    static relationMappings = {
      author: {
        relation: Model.BelongsToOneRelation,
        modelClass: () => db.Person.modelClass,
        join: { from: 'reviews.authorId', to: 'persons.id' },
      },
      animal: {
        relation: Model.BelongsToOneRelation,
        modelClass: db.Animal.modelClass,
        join: { from: 'reviews.animalId', to: 'animals.id' },
      },
    };
  }

  // Escape hatch to the full classic QueryBuilder API.
  toQueryBuilder(db.Person.query()).whereJsonSupersetOf('address', { city: 'x' });

  // Helper types
  const q = db.Person.query().select('id').first();
  expectType<Equal<Result<typeof q>, { id: number } | undefined>>();
  type PersonWithPets = RowWithGraph<typeof db.Person, 'pets'>;
  expectType<Equal<PersonWithPets['pets'], AnimalRow[]>>();
}

// ---------------------------------------------------------------------------
// Relation styles: references(), relations() and the keyed object, combined
// ---------------------------------------------------------------------------

const Owner = defineModel({
  table: 'owners',
  columns: {
    id: column(z.number()).generated(),
    name: z.string(),
    parentId: column(z.number().nullable()).references('Owner', 'id', { inverse: 'children' }),
  },
});

const Pet = defineModel({
  table: 'pets',
  columns: {
    id: column(z.number()).generated(),
    name: z.string(),
    ownerId: column(z.number()).references('Owner', 'id', { inverse: 'pets' }),
    vetId: column(z.number().nullable()).references('Vet', 'id', {
      as: 'doctor',
      inverse: { name: 'patient', kind: 'one' },
    }),
  },
});

const Vet = defineModel({ table: 'vets', columns: { id: z.number(), name: z.string() } });

// Colocated declarations target models directly.
const ownerRelations = relations(Owner, (r) => ({
  movies: r.manyToMany(Movie, {
    from: 'id',
    to: 'id',
    through: { table: 'owners_movies', from: 'ownerId', to: 'movieId' },
  }),
  // @ts-expect-error `ownerIdd` is not a column of Pet
  typo: r.hasMany(Pet, { from: 'id', to: 'ownerIdd' }),
}));
const vetRelations = relations(Vet, (r) => ({
  colleagues: r.hasMany(Vet, { from: 'id', to: 'id' }),
}));

const zoo = defineModels({ Owner, Pet, Vet, Movie }, [ownerRelations, vetRelations], {
  Vet: (r) => ({
    owners: r.manyToMany('Owner', {
      from: 'id',
      to: 'id',
      through: { table: 'x', from: 'a', to: 'b' },
    }),
  }),
});

async function relationStyles() {
  type OwnerRow = Row<typeof zoo.Owner>;
  type PetRow = Row<typeof zoo.Pet>;
  type VetRow = Row<typeof zoo.Vet>;

  const [o] = await zoo.Owner.query().withGraphFetched({
    parent: true, // forward, from `parentId`
    children: true, // inverse of Owner.parentId
    pets: { doctor: true }, // inverse of Pet.ownerId, then forward with `as`
    movies: true, // relations()
  });
  expectType<Equal<typeof o.parent, OwnerRow | null>>();
  expectType<Equal<typeof o.children, OwnerRow[]>>();
  expectType<Equal<(typeof o.pets)[number]['doctor'], VetRow | null>>();
  expectType<Equal<(typeof o.movies)[number]['title'], string>>();

  const [v] = await zoo.Vet.query().withGraphFetched('[patient.owner, colleagues, owners]');
  expectType<Equal<NonNullable<typeof v.patient>['owner'], OwnerRow | null>>();
  expectType<Equal<typeof v.colleagues, VetRow[]>>();
  expectType<Equal<typeof v.owners, OwnerRow[]>>();

  // Joins and graph inserts see derived relations too.
  zoo.Pet.query().joinRelated('owner').where('owner.name', 'x');
  zoo.Owner.query().insertGraph({
    name: 'a',
    parentId: null,
    pets: [{ name: 'Rex', vetId: null }],
  });
  // @ts-expect-error not a relation
  zoo.Pet.query().withGraphFetched('ownerr');
}

// ----- Errors: each of these is a compile error on the `defineModels` call -----

const ownerPetsRelation = relations(Owner, (r) => ({
  pets: r.hasMany(Pet, { from: 'id', to: 'ownerId' }),
}));
// prettier-ignore
// @ts-expect-error relation "Owner.pets" is defined more than once (references() inverse + relations())
defineModels({ Owner, Pet, Vet }, [ownerPetsRelation]);

// prettier-ignore
// @ts-expect-error relation "Vet.colleagues" is defined more than once (relations() + keyed)
defineModels({ Owner, Pet, Vet }, [vetRelations], { Vet: (r) => ({ colleagues: r.hasMany('Vet', { from: 'id', to: 'id' }) }) });

// prettier-ignore
// @ts-expect-error relation "Vet.name" has the same name as a column
defineModels({ Owner, Pet, Vet }, { Vet: (r) => ({ name: r.hasMany('Pet', { from: 'id', to: 'vetId' }) }) });

// @ts-expect-error Pet.vetId.references(): unknown model "Vet" (missing from the registry)
defineModels({ Owner, Pet });

const BadColumn = defineModel({
  table: 'b',
  columns: { id: z.number(), ownerId: column(z.number()).references('Owner', 'uuid') },
});
// @ts-expect-error references(): unknown column "Owner.uuid"
defineModels({ Owner, BadColumn });

const NoName = defineModel({
  table: 'c',
  columns: { id: z.number(), owner: column(z.number()).references('Owner', 'id') },
});
// @ts-expect-error references(): needs an `as` relation name
defineModels({ Owner, NoName });

const InverseOnClassic = defineModel({
  table: 'd',
  columns: {
    id: z.number(),
    movieId: column(z.number()).references('Movie', 'id', { inverse: 'links' }),
  },
});
// @ts-expect-error "Movie" is a classic model class and can't get the inverse relation "links"
defineModels({ Movie, InverseOnClassic });

const strangerRelations = relations(Vet, (r) => ({
  x: r.hasMany(Vet, { from: 'id', to: 'id' }),
}));
// @ts-expect-error relations() declared for a model that isn't part of this registry
defineModels({ Owner, Pet: Raw }, [strangerRelations]);

// ----- defineModelNames: reference targets checked on the column itself -----

const { column: libraryColumn } = defineModelNames('Author', 'Book');

const Author = defineModel({
  table: 'authors',
  columns: { id: libraryColumn(z.number()).generated(), name: z.string() },
});
const Book = defineModel({
  table: 'books',
  columns: {
    id: libraryColumn(z.number()).generated(),
    authorId: libraryColumn(z.number()).references('Author', 'id', { inverse: 'books' }),
  },
});

// @ts-expect-error "Autor" is not a declared model name
libraryColumn(z.number()).references('Autor', 'id');
// @ts-expect-error still checked after other modifiers
libraryColumn(z.number()).generated().references('Autor', 'id');
// Plain `column()` accepts any name; it's checked when `defineModels` runs instead.
column(z.number()).references('Anything', 'id');

const library = defineModels({ Author, Book });

async function modelNames() {
  const [author] = await library.Author.query().withGraphFetched('books.author');
  expectType<Equal<(typeof author.books)[number]['author'], Row<typeof library.Author> | null>>();
}

// @ts-expect-error Book.authorId.references(): unknown model "Author" (declared, but not registered)
defineModels({ Book });
