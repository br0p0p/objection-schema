// Types through the CommonJS entry point (`require` condition → dist/index.d.ts).
import schema = require('objection-schema');

import { z } from 'zod';

const Item = schema.defineModel({
  table: 'items',
  columns: { id: schema.column(z.number()).generated(), name: z.string() },
});

const db = schema.defineModels({ Item });

const priceCodec: schema.ColumnCodec<number, string> = { fromDatabase: Number, toDatabase: String };

const Price = schema.defineModel({
  table: 'prices',
  columns: { id: schema.column(z.number()).generated(), amount: schema.column(z.number()).codec(priceCodec) },
});

export async function check() {
  const rows: { id: number; name: string }[] = await db.Item.query();
  // @ts-expect-error unknown column
  db.Item.query().where('nme', 'x');
  Price.query().where('amount', '1.50');

  return rows;
}
