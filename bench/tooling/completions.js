'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Asks the TypeScript language service (what editors use) for completions at
// marked positions in a snippet, to verify autocompletion of the typed API.
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const file = path.join(root, 'tests/types/_completions.ts');

const header = `
import { z } from 'zod';
import { defineModel, defineModels, relations, column, defineModelNames } from 'objection-schema';
const Person = defineModel({ table: 'persons', columns: { id: column(z.number()).generated(), firstName: z.string(), age: z.number().nullable(), parentId: z.number().nullable() } });
const Animal = defineModel({ table: 'animals', columns: { id: column(z.number()).generated(), name: z.string(), ownerId: z.number() } });
const db = defineModels({ Person, Animal }, {
  Person: (r) => ({ pets: r.hasMany('Animal', { from: 'id', to: 'ownerId' }), parent: r.belongsToOne('Person', { from: 'parentId', to: 'id' }) }),
  Animal: (r) => ({ owner: r.belongsToOne('Person', { from: 'ownerId', to: 'id' }) }),
});
`;

const cases = {
  'where(\'|\')': `db.Person.query().where('|')`,
  'withGraphFetched(\'|\')': `db.Person.query().withGraphFetched('|')`,
  'withGraphFetched({ | })': `db.Person.query().withGraphFetched({ | })`,
  'joinRelated(\'pets\').where(\'pets.|\')': `db.Person.query().joinRelated('pets').where('pets.|')`,
  'relation target r.hasMany(\'|\')': `defineModels({ Person, Animal }, { Person: (r) => ({ x: r.hasMany('|', { from: 'id', to: 'id' }) }) })`,
  'insert({ | })': `db.Person.query().insert({ | })`,
  'relations(): r.hasMany(Animal, { to: \'|\' })': `relations(Person, (r) => ({ x: r.hasMany(Animal, { from: 'id', to: '|' }) }))`,
  'references(): .references(\'|\')': `column(z.number()).references('|', 'id')`,
  'defineModelNames column .references(\'|\')': `defineModelNames('Person', 'Animal').column(z.number()).references('|', 'id')`,
};

for (const [label, snippet] of Object.entries(cases)) {
  const text = `${header + snippet.replace('|', '')};\n`;
  const pos = header.length + snippet.indexOf('|');
  fs.writeFileSync(file, text);

  const host = {
    getScriptFileNames: () => [file],
    getScriptVersion: () => '1',
    getScriptSnapshot: f =>
      fs.existsSync(f) ? ts.ScriptSnapshot.fromString(fs.readFileSync(f, 'utf8')) : undefined,
    getCurrentDirectory: () => root,
    getCompilationSettings: () => ({
      strict: true,
      esModuleInterop: true,
      module: ts.ModuleKind.NodeNext,
      target: ts.ScriptTarget.ES2020,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    }),
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
  };

  const service = ts.createLanguageService(host);
  const completions = service.getCompletionsAtPosition(file, pos, {});

  const names = (completions ? completions.entries : [])
    .map(e => e.name)
    .filter(n => !/^[A-Z_]/.test(n) || n === 'Animal' || n === 'Person');

  console.log(`${label.padEnd(40)} → ${names.slice(0, 20).join(', ')}`);
}

fs.unlinkSync(file);
