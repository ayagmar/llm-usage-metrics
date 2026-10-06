import path from 'node:path';
import { fileURLToPath } from 'node:url';

import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import redosPlugin from 'eslint-plugin-redos';
import regexpPlugin from 'eslint-plugin-regexp';
import tseslint from 'typescript-eslint';

const tsconfigRootDir = path.dirname(fileURLToPath(import.meta.url));
const tsFiles = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'];

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
      'site/**',
      '.github/scripts/**',
      'scripts/**',
      '*.tgz',
      'eslint.config.js',
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
    // recheck finds ReDoS that static rules miss, e.g. alternatives that overlap across
    // iterations of a repeated group. Model names and log text are untrusted input.
    files: ['src/**/*.ts'],
    plugins: { redos: redosPlugin },
    rules: {
      'redos/no-vulnerable': 'error',
    },
  },
  {
    files: ['tests/**/*.ts', 'tests/**/*.tsx', 'tests/**/*.mts', 'tests/**/*.cts'],
    rules: {
      '@typescript-eslint/no-unsafe-type-assertion': 'off',
    },
  },
  prettierConfig,
);
