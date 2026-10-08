// Actual App and AppProvider initial SSR only. API is stubbed; no browser or paint.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(pathToFileURL(resolve('apps/web/package.json')));
const viteRequire = createRequire(require.resolve('vite'));
const { build } = viteRequire('esbuild');
const directory = await mkdtemp(resolve('apps/web/.offline-session-review-'));
const file = join(directory, 'render.mjs');
try {
  await build({
    stdin: {
      contents:
        "import React from 'react';import{renderToStaticMarkup}from'react-dom/server';import{App}from'./src/App.tsx';import{AppProvider}from'./src/state/AppContext.tsx';export const html=renderToStaticMarkup(React.createElement(AppProvider,null,React.createElement(App)));",
      resolveDir: resolve('apps/web'),
      loader: 'tsx',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: file,
    external: ['react', 'react-dom/server'],
    define: { 'import.meta.env': '{}' },
    plugins: [
      {
        name: 'offline-api',
        setup(builder) {
          builder.onResolve({ filter: /api\/index\.ts$/ }, () => ({
            path: 'offline-api',
            namespace: 'offline-api',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'offline-api' }, () => ({
            contents:
              "export const isUsingMock=()=>false;export const setUseMock=()=>{};export const defaultApiClient={currentUser:async()=>{throw Error('No networking in offline SSR')}};export class SseClient{};export const fetchRunMessages=async()=>{throw Error('No calls')};export const recordMessageRendered=()=>{throw Error('No calls')};",
            loader: 'js',
          }));
        },
      },
    ],
  });
  const { html } = await import(pathToFileURL(file).href);
  assert.ok(html.includes('data-testid="app-session-loading"'));
  assert.equal(/type="password"|data-testid="login/.test(html), false);
  console.log(
    JSON.stringify({
      initialPendingSession: true,
      initialLoginFormAbsent: true,
      actualProductAppAndProvider: true,
      apiStubbed: true,
      browserExecuted: false,
      clientHydrationVerified: false,
      P0Passed: false,
    }),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
