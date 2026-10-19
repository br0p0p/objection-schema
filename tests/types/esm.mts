import type { Row } from 'objection-schema';
import { column, defineModel, defineModels, relations } from 'objection-schema';
// Types through the ES module entry point (`import` condition → dist/index.d.mts).
import { z } from 'zod';

type Equal<A, B>
  = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

function expectType<T extends true>() {}

const Item = defineModel({
  table: 'items',
  columns: {
    id: column(z.number()).generated(),
    name: z.string(),
    parentId: column(z.number().nullable()).references('Item', 'id', { inverse: 'children' }),
  },
});

const itemRelations = relations(Item, () => ({}));
const db = defineModels({ Item }, [itemRelations]);

export async function check() {
  const [item] = await db.Item.query().withGraphFetched('[parent, children]');
  expectType<Equal<typeof item.children, Row<typeof db.Item>[]>>();
  // @ts-expect-error unknown column
  db.Item.query().where('nme', 'x');
}
