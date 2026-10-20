import path from 'node:path';
import { fileURLToPath } from 'node:url';

import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import redosPlugin from 'eslint-plugin-redos';
import regexpPlugin from 'eslint-plugin-regexp';
import tseslint from 'typescript-eslint';

const tsconfigRootDir = path.dirname(fileURLToPath(import.meta.url));
const tsFiles = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'];
const hostStateMessage = 'The core package reads host state only through an injected context.';
const coreCliTreeImportPattern = {
  regex: String.raw`^(?:\.\./){2,}src(?:/|$)`,
  message: 'The core package must not import from the CLI tree.',
};
const networkMessage = 'The core package makes no network calls';
const coreNetworkImportPaths = [
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'dgram',
  'dns',
  'child_process',
].flatMap((name) => [
  { name: `node:${name}`, message: networkMessage },
  { name, message: networkMessage },
]);
const coreNetworkGlobals = [
  { name: 'fetch', message: networkMessage },
  { name: 'WebSocket', message: networkMessage },
];
const coreAlwaysRestrictedProperties = [
  { object: 'process', property: 'cwd', message: hostStateMessage },
  { object: 'process', property: 'stdout', message: 'The core package prints nothing.' },
  { object: 'process', property: 'stderr', message: 'The core package prints nothing.' },
  { object: 'globalThis', property: 'process', message: hostStateMessage },
  { object: 'globalThis', property: 'fetch', message: networkMessage },
  { object: 'globalThis', property: 'WebSocket', message: networkMessage },
];

function scopeToFiles(configs, files) {
  return configs.map((config) => ({
    ...config,
    files: config.files ?? files,
  }));
}

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'packages/*/dist/**',
      'packages/*/coverage/**',
      'site/**',
      '.github/scripts/**',
      'scripts/**',
      '*.tgz',
      'eslint.config.js',
      'src/share-report/client-bundle.generated.ts',
    ],
  },
  js.configs.recommended,
  regexpPlugin.configs['flat/recommended'],
  ...scopeToFiles(tseslint.configs.recommendedTypeChecked, tsFiles),
  ...scopeToFiles(tseslint.configs.strictTypeChecked, tsFiles),
  ...scopeToFiles(tseslint.configs.stylisticTypeChecked, tsFiles),
  {
    files: tsFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir,
      },
    },
    rules: {
      'no-console': 'off',
      // Control-character classes are built with new RegExp(String.raw`...`) on purpose,
      // which keeps them readable without tripping no-control-regex.
      'prefer-regex-literals': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
        },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-unsafe-type-assertion': 'error',
      '@typescript-eslint/no-unnecessary-type-arguments': 'error',
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        {
          allowNumber: true,
        },
      ],
      'no-duplicate-imports': [
        'error',
        {
          allowSeparateTypeImports: true,
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message: 'Inline dynamic imports are forbidden; use top-level static imports instead.',
        },
      ],
    },
  },
  {
    // The share client and its UI tests type-check against the client tsconfig, whose DOM lib
    // supplies the browser globals (no-undef is off for TypeScript files).
    files: ['src/share-report/client/**/*.ts', 'tests/share-report/client/ui/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: './src/share-report/client/tsconfig.json',
        tsconfigRootDir,
      },
    },
  },
  {
    // recheck finds ReDoS that static rules miss, e.g. alternatives that overlap across
    // iterations of a repeated group. Model names and log text are untrusted input.
    files: ['src/**/*.ts', 'packages/core/src/**/*.ts'],
    plugins: { redos: redosPlugin },
    rules: {
      'redos/no-vulnerable': 'error',
    },
  },
  {
    // The core package prints nothing, makes no network calls, reads host state only through
    // an injected context, and never reaches into the CLI tree.
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-console': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'node:os', message: hostStateMessage },
            { name: 'os', message: hostStateMessage },
            { name: 'node:process', message: hostStateMessage },
            { name: 'process', message: hostStateMessage },
            ...coreNetworkImportPaths,
          ],
          patterns: [coreCliTreeImportPattern],
        },
      ],
      'no-restricted-globals': ['error', ...coreNetworkGlobals],
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'env', message: hostStateMessage },
        { object: 'process', property: 'platform', message: hostStateMessage },
        { object: 'os', property: 'homedir', message: hostStateMessage },
        ...coreAlwaysRestrictedProperties,
      ],
    },
  },
  {
    // The one host reader: `createSourceContext` fills the context from the home directory,
    // environment and platform. Everything else in the core block still applies.
    files: ['packages/core/src/sources/source-context.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: coreNetworkImportPaths, patterns: [coreCliTreeImportPattern] },
      ],
      'no-restricted-globals': ['error', ...coreNetworkGlobals],
      'no-restricted-properties': ['error', ...coreAlwaysRestrictedProperties],
    },
  },
  {
    // The one network call: `fetchLiteLLMPricing` fetches prices with the global `fetch` when
    // its caller asks. Everything else in the core block still applies.
    files: ['packages/core/src/pricing/fetch-litellm-pricing.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...coreNetworkGlobals.filter((global) => global.name !== 'fetch'),
      ],
    },
  },
  {
    files: ['tests/**/*.{ts,tsx,mts,cts}', 'packages/*/tests/**/*.{ts,tsx,mts,cts}'],
    rules: {
      '@typescript-eslint/no-unsafe-type-assertion': 'off',
    },
  },
  prettierConfig,
);
