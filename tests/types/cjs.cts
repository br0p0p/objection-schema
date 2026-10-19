// Types through the CommonJS entry point (`require` condition → typings/index.d.ts).
import schema = require('objection-schema');

import { z } from 'zod';

const Item = schema.defineModel({
  table: 'items',
  columns: { id: schema.column(z.number()).generated(), name: z.string() },
});

const db = schema.defineModels({ Item });

export async function check() {
  const rows: { id: number; name: string }[] = await db.Item.query();
  // @ts-expect-error unknown column
  db.Item.query().where('nme', 'x');

  return rows;
}
