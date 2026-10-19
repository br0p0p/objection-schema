'use strict';
// Runs the runtime and type tests against several objection 3.x releases, then
// reinstalls the version from package.json. Run: npm run test:objection-versions [versions...]
const { execSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const versions = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['3.0.0', '3.1.5', '3.5.0', '3.9.1'];

const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'pipe', encoding: 'utf8' });
const install = (spec) =>
  run(`npm install --no-save --no-audit --no-fund --ignore-scripts objection@${spec}`);

const results = [];
try {
  for (const version of versions) {
    install(version);
    const result = { version };

    // objection 3.0.x's own declarations don't compile under TypeScript 5.8 with library
    // checking on (TS2344 in its index.d.ts), so those versions are checked with
    // `--skipLibCheck`, like most projects do anyway.
    const libCheck = version.startsWith('3.0.') ? ' --skipLibCheck' : '';
    const checks = [
      ['runtime', 'npx mocha --timeout 15000 --reporter dot "tests/runtime/**/*.test.{js,mjs}"'],
      [
        'types',
        `npx tsc -p tests/types/tsconfig.json${libCheck} && npx tsc -p tests/types/tsconfig.nodenext.json`,
      ],
    ];

    for (const [name, cmd] of checks) {
      try {
        const out = run(cmd);
        const passing = (out.match(/(\d+) passing/) || [])[1];
        result[name] = passing
          ? `ok (${passing} passing)`
          : `ok${libCheck ? ' (skipLibCheck)' : ''}`;
      } catch (err) {
        const out = `${err.stdout || ''}${err.stderr || ''}`;
        const failing = (out.match(/(\d+) failing/) || [])[1];
        result[name] = failing ? `FAILED (${failing} failing)` : 'FAILED';
        result.output =
          (result.output || '') +
          out
            .split('\n')
            .filter((l) => /error|failing|Error/.test(l))
            .slice(0, 8)
            .join('\n');
      }
    }

    results.push(result);
    console.log(`objection ${version}: runtime ${result.runtime}, types ${result.types}`);
    if (result.output) console.log(result.output);
  }
} finally {
  install(pkg.devDependencies.objection);
}

process.exitCode = results.every((r) => !r.output) ? 0 : 1;
