import process from 'node:process';
import antfu from '@antfu/eslint-config';
import globals from 'globals';

export default antfu(
  {
    // ESLint is also the formatter (antfu's stylistic rules; there is no Prettier). After a
    // formatting change to the typings in lib/, update the patterns in scripts/mutate-types.js:
    // they match the source verbatim, and the script fails on any that no longer match.
    stylistic: {
      semi: true,
      overrides: {
        // antfu's default (`consistent-as-needed`) quotes every key once one needs quotes,
        // which quoted all the method names next to `'~types'` in the typings.
        'style/quote-props': ['error', 'as-needed'],
      },
    },
    // The Claude Code edit hook sets this, so that `--fix` reports an import that isn't used
    // *yet* instead of deleting it. Otherwise antfu detects editors itself.
    isInEditor: process.env.ESLINT_IN_EDITOR === '1' ? true : undefined,
    // antfu ignores all of .claude/ (agent worktrees live there); lint the project's hooks.
    ignores: defaults => [
      ...defaults.filter(glob => glob !== '**/.claude'),
      // Preserve the vendored anti-slop source and its upstream formatting for future merges.
      'tools/oxlint/anti-slop/**',
      '**/.claude/*',
      '!.claude/hooks/',
    ],
  },

  {
    files: ['**/*.js', '**/*.cjs'],
    ignores: ['**/*.md/**'], // code blocks in Markdown are examples, written as ES modules
    languageOptions: { sourceType: 'commonjs' },
  },
  {
    rules: {
      // Uses inside functions that run later are fine; same-scope (TDZ) uses still fail.
      'no-use-before-define': ['error', { classes: false, functions: false, variables: false }],
      'ts/no-use-before-define': [
        'error',
        { classes: false, functions: false, variables: false, typedefs: false },
      ],
      // `modelClass` is the public name of a definition's generated class.
      'new-cap': [
        'error',
        { capIsNew: false, newIsCap: true, properties: true, newIsCapExceptions: ['modelClass'] },
      ],
    },
  },

  // The published runtime. It has to run on every Node version objection 3 supports
  // (`engines` in package.json), and its only runtime dependency is the `objection` peer
  // dependency: schema libraries are supplied by users.
  {
    files: ['lib/**'],
    rules: {
      'node/no-unsupported-features/es-builtins': 'error',
      'node/no-unsupported-features/es-syntax': 'error',
      'node/no-unsupported-features/node-builtins': 'error',
      // The error class is part of the API; switching to TypeError would be a breaking change.
      'unicorn/prefer-type-error': 'off',
      'no-restricted-syntax': [
        'error',
        // Type-only imports are erased from the build (e.g. `knex` types in types.ts).
        ...[
          'ImportDeclaration[importKind!=\'type\']',
          'ExportNamedDeclaration[source][exportKind!=\'type\']',
          'ExportAllDeclaration[exportKind!=\'type\']',
        ].map(node => ({
          selector: `${node}[source.value!=/^(objection$|\\.\\/)/]`,
          message:
            'lib/ may only import objection (the peer dependency) and its own files. Schema libraries are supplied by users.',
        })),
        {
          selector:
            'CallExpression[callee.name=\'require\'][arguments.0.value!=/^(objection$|\\.\\/)/]',
          message:
            'lib/ may only import objection (the peer dependency) and its own files. Schema libraries are supplied by users.',
        },
      ],
    },
  },

  // Type-level code: these rules change what the types mean, not just how they look
  // (method parameters are bivariant, `{}` is load-bearing in conditional types,
  // interfaces and type aliases differ in assignability).
  {
    files: ['lib/**/*.ts', 'tests/types/**'],
    rules: {
      // The Standard Schema spec (copied into lib/types.ts as recommended) declares a namespace.
      'ts/no-namespace': ['error', { allowDeclarations: true }],
      'ts/method-signature-style': 'off',
      'ts/no-empty-object-type': 'off',
      'ts/consistent-type-definitions': 'off',
    },
  },
  {
    files: ['tests/types/**'],
    rules: {
      // Type tests declare values only to check their types.
      'unused-imports/no-unused-vars': 'off',
    },
  },
  {
    files: ['tests/types/cjs.cts'],
    rules: {
      // `import x = require()` is what this file tests.
      'ts/no-require-imports': 'off',
    },
  },

  {
    files: ['tests/runtime/**'],
    languageOptions: { globals: globals.mocha },
    rules: {
      'test/prefer-lowercase-title': ['error', { allowedPrefixes: ['ES'] }],
    },
  },
  {
    files: ['bench/**', 'scripts/**', '.claude/hooks/**'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['scripts/mutate-types.js'],
    rules: {
      // The mutant patterns contain TypeScript template literal types.
      'no-template-curly-in-string': 'off',
    },
  },
);
