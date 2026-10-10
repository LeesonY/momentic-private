import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Node 运行时全局（.mjs 脚本与 CommonJS fixture 共用）
const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  structuredClone: 'readonly',
  fetch: 'readonly',
  Headers: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  performance: 'readonly',
  globalThis: 'readonly',
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/src/generated/**',
      '**/test-results/**',
      '.cache/**',
      '.tmp/**',
      '.localqa-t01/**',
      'evidence/**',
      'spikes/**',
      // 已归档的验收复现脚本，按原样保留以便与证据记录对照
      'docs/validation-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // `_` 前缀表示"有意不使用"（接口占位、解构忽略项）
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: nodeGlobals },
  },
  {
    // 受控测试站点：独立的 CommonJS Express 包，Playwright spec 含页面内回调
    files: ['packages/test-fixture/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        ...nodeGlobals,
        window: 'readonly',
        document: 'readonly',
        require: 'readonly',
        module: 'writable',
        __dirname: 'readonly',
      },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
