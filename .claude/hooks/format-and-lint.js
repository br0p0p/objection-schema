'use strict';
// Claude Code PostToolUse hook (Edit|Write|MultiEdit). Formats the edited file and applies
// the other fixes eslint can make (antfu's config does both), then reports the errors that
// are left back to the agent (exit code 2) so they get fixed right away instead of at
// `pnpm run check`. Anything this hook can't handle (files outside the repo, no
// node_modules yet, file types eslint doesn't lint) is skipped.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');

const root = path.resolve(__dirname, '../..');
const eslint = path.join(root, 'node_modules/.bin/eslint');
// What eslint.config.mjs lints (antfu: code, JSON, YAML, TOML, Markdown).
const LINTED = /\.(?:[cm]?[jt]s|jsonc?|ya?ml|toml|md)$/;

let input = '';
process.stdin.on('data', chunk => (input += chunk));
process.stdin.on('end', () => {
  let file;
  try {
    const payload = JSON.parse(input);
    file = (payload.tool_input && payload.tool_input.file_path) || '';
  }
  catch {
    return;
  }

  const rel = path.relative(root, path.resolve(root, file));
  if (!file || rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(file))
    return;
  if (!LINTED.test(rel) || !fs.existsSync(eslint))
    return;

  // Editor mode: fixes that would delete an import the agent hasn't used *yet* are skipped.
  const result = spawnSync(eslint, ['--fix', '--quiet', '--no-warn-ignored', rel], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ESLINT_IN_EDITOR: '1' },
  });

  if (result.status !== 0) {
    process.stderr.write(`eslint found problems in ${rel}:\n${result.stdout}${result.stderr}`);
    process.exitCode = 2;
  }
});
