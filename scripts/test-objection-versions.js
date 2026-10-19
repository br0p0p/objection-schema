'use strict';

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Runs the runtime and type tests against several objection 3.x releases, then
// restores package.json, the lockfile and node_modules.
// Run: pnpm run test:objection-versions [versions...]
const process = require('node:process');

const root = path.resolve(__dirname, '..');

const versions = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['3.0.0', '3.1.5', '3.5.0', '3.9.1'];

const run = cmd => execSync(cmd, { cwd: root, stdio: 'pipe', encoding: 'utf8' });

// pnpm has no `--no-save`, so the manifest and lockfile are put back afterwards.
const saved = ['package.json', 'pnpm-lock.yaml'].map(file => [
  path.join(root, file),
  fs.readFileSync(path.join(root, file)),
]);

const install = version => run(`pnpm add --save-dev --save-exact objection@${version}`);

function restore() {
  for (const [file, contents] of saved) fs.writeFileSync(file, contents);
  run('pnpm install --frozen-lockfile');
}

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
      ['runtime', 'pnpm exec mocha --reporter dot "tests/runtime/**/*.test.{js,mjs}"'],
      [
        'types',
        `pnpm exec tsc -p tests/types/tsconfig.json${libCheck} && pnpm exec tsc -p tests/types/tsconfig.nodenext.json`,
      ],
    ];

    for (const [name, cmd] of checks) {
      try {
        const out = run(cmd);
        const passing = (out.match(/(\d+) passing/) || [])[1];
        result[name] = passing
          ? `ok (${passing} passing)`
          : `ok${libCheck ? ' (skipLibCheck)' : ''}`;
      }
      catch (err) {
        const out = `${err.stdout || ''}${err.stderr || ''}`;
        const failing = (out.match(/(\d+) failing/) || [])[1];
        result[name] = failing ? `FAILED (${failing} failing)` : 'FAILED';
        result.output
          = (result.output || '')
            + out
              .split('\n')
              .filter(l => /error|failing|Error/.test(l))
              .slice(0, 8)
              .join('\n');
      }
    }

    results.push(result);
    console.log(`objection ${version}: runtime ${result.runtime}, types ${result.types}`);

    if (result.output)
      console.log(result.output);
  }
}
finally {
  restore();
}

process.exitCode = results.every(r => !r.output) ? 0 : 1;
