'use strict';

// The public surface is declared three times: the CommonJS implementation (lib/index.js),
// its ES module re-export (lib/index.mjs, checked in esm.test.mjs) and the hand-written
// typings (typings/index.d.ts). Adding or removing an export in only one of them is an
// easy mistake that neither the runtime nor the type tests would notice on their own.

const path = require('node:path');
const expect = require('expect.js');
const api = require('objection-schema');
const ts = require('typescript');

const TYPINGS = path.join(__dirname, '../../typings/index.d.ts');

function valueExportsOfTypings() {
  const program = ts.createProgram([TYPINGS], { noEmit: true, skipLibCheck: true, types: [] });
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(TYPINGS));

  return checker
    .getExportsOfModule(moduleSymbol)
    .filter(symbol => symbol.flags & ts.SymbolFlags.Value)
    .map(symbol => symbol.name)
    .sort();
}

describe('public exports', () => {
  it('the typings declare exactly the values that lib/index.js exports', function () {
    // Building a TypeScript program takes a moment.
    this.timeout(30000);

    expect(valueExportsOfTypings()).to.eql(Object.keys(api).sort());
  });
});
