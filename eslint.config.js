// ESLint 設定。エラーの握りつぶしを機械的に禁止する（docs/error-handling.md 0章）。
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const SWALLOW_MESSAGE =
  'エラーを握りつぶさないでください。AppError のコードに写像してログに出すか、再 throw してください（docs/error-handling.md）。';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      'tools/demo-kit/out/**',
      'coverage/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            '*.js',
            '*.mjs',
            '*.ts',
            'apps/*/*.mjs',
            'apps/*/*.ts',
            'packages/*/*.ts',
            'tools/*/*.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {...globals.node},
    },
    rules: {
      // --- 握りつぶし禁止 ---
      'no-empty': ['error', {allowEmptyCatch: false}],
      'no-restricted-syntax': [
        'error',
        {selector: 'CatchClause > BlockStatement[body.length=0]', message: SWALLOW_MESSAGE},
        {
          selector:
            "CallExpression[callee.property.name='catch'] > :matches(ArrowFunctionExpression, FunctionExpression) > BlockStatement[body.length=0]",
          message: SWALLOW_MESSAGE,
        },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'error',
      // --- その他 ---
      // Fastify のプラグインは await がなくても async で書く慣習のため
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {argsIgnorePattern: '^_', varsIgnorePattern: '^_'},
      ],
      'no-console': ['error', {allow: ['error']}],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: {'react-hooks': reactHooks},
    languageOptions: {globals: {...globals.browser}},
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    files: ['**/test/**', '**/*.spec.ts', '**/*.spec.tsx'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  {
    // ビルド・設定スクリプトは型情報なしで十分
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['tools/**/*.ts'],
    rules: {'no-console': 'off'},
  }
);
