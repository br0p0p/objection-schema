'use strict';

// The public surface is declared in lib/index.ts (values and types), which zshy builds as
// CommonJS and as an ES module (compared in esm.test.mjs). This compares the built declarations
// with the built runtime: a value exported only as a type (`export type`),
// or a type-only declaration of something that isn't exported at runtime, would slip past the
// runtime and the type tests on their own.

const path = require('node:path');
const expect = require('expect.js');
const api = require('objection-schema');
const ts = require('typescript');

const TYPINGS = path.join(__dirname, '../../dist/index.d.ts');

function valueExportsOfTypings() {
  const program = ts.createProgram([TYPINGS], { noEmit: true, skipLibCheck: true, types: [] });
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(TYPINGS));

  // index.d.ts re-exports, so follow the aliases. `export type { X }` exports no value.
  const isValue = symbol =>
    !symbol.declarations.some(it => ts.isTypeOnlyImportOrExportDeclaration(it))
    && (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol).flags
    & ts.SymbolFlags.Value;

  return checker
    .getExportsOfModule(moduleSymbol)
    .filter(isValue)
    .map(symbol => symbol.name)
    .sort();
}

describe('public exports', () => {
  it('the declarations declare exactly the values that the runtime exports', function () {
    // Building a TypeScript program takes a moment.
    this.timeout(30000);

    expect(valueExportsOfTypings()).to.eql(Object.keys(api).sort());
  });
});
