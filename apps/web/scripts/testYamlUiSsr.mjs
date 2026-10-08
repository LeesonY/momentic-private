// T10-YAML-UI Offline Component SSR and Static Markup Verification
// Zero browser execution, zero networking, Ego paused.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(pathToFileURL(resolve('apps/web/package.json')));
const viteRequire = createRequire(require.resolve('vite'));
const { build } = viteRequire('esbuild');

const directory = await mkdtemp(resolve('apps/web/.offline-yaml-ui-review-'));
const file = join(directory, 'render-yaml-ui.mjs');

try {
  await build({
    stdin: {
      contents: `
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SavedCaseYamlImportModal } from './src/components/saved-cases/SavedCaseYamlImportModal.tsx';
import { SavedCaseYamlExportModal } from './src/components/saved-cases/SavedCaseYamlExportModal.tsx';
import { SavedCasesPage } from './src/pages/SavedCasesPage.tsx';
import { SavedCaseDetailPage } from './src/pages/SavedCaseDetailPage.tsx';

// 1. Render SavedCaseYamlImportModal open
export const importModalOpenHtml = renderToStaticMarkup(
  React.createElement(SavedCaseYamlImportModal, {
    projectId: 'proj-offline-001',
    isOpen: true,
    onClose: () => {},
    onSuccess: () => {},
  })
);

// 2. Render SavedCaseYamlImportModal closed
export const importModalClosedHtml = renderToStaticMarkup(
  React.createElement(SavedCaseYamlImportModal, {
    projectId: 'proj-offline-001',
    isOpen: false,
    onClose: () => {},
    onSuccess: () => {},
  })
);

// 3. Render SavedCaseYamlExportModal open
export const exportModalOpenHtml = renderToStaticMarkup(
  React.createElement(SavedCaseYamlExportModal, {
    versionId: '9d82c93d-3c29-44c7-a389-91f11088d174',
    versionNum: 1,
    caseSlug: 'demo-login-flow',
    isOpen: true,
    onClose: () => {},
  })
);

// 4. Render SavedCaseYamlExportModal closed
export const exportModalClosedHtml = renderToStaticMarkup(
  React.createElement(SavedCaseYamlExportModal, {
    versionId: '9d82c93d-3c29-44c7-a389-91f11088d174',
    versionNum: 1,
    caseSlug: 'demo-login-flow',
    isOpen: false,
    onClose: () => {},
  })
);

// 5. Render SavedCasesPage with mocked AppContext
export const savedCasesPageHtml = renderToStaticMarkup(
  React.createElement(SavedCasesPage, null)
);

// 6. Render SavedCaseDetailPage with mocked AppContext
export const savedCaseDetailPageHtml = renderToStaticMarkup(
  React.createElement(SavedCaseDetailPage, null)
);
`,
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
        name: 'offline-api-stub',
        setup(builder) {
          builder.onResolve({ filter: /api\/index\.ts$/ }, () => ({
            path: 'offline-api-stub',
            namespace: 'offline-api-stub',
          }));
          builder.onLoad(
            { filter: /.*/, namespace: 'offline-api-stub' },
            () => ({
              contents: `
export const isUsingMock = () => false;
export const setUseMock = () => {};
export const defaultApiClient = {
  currentUser: async () => ({ id: 'u1', email: 'test@localqa.dev', role: 'admin' }),
  listProjects: async () => ({ items: [] }),
  listSavedCases: async () => ({ items: [] }),
  listSavedCaseVersions: async () => ({ items: [] }),
  importSavedCaseYaml: async () => { throw new Error('Offline SSR'); },
  exportSavedCaseYaml: async () => { throw new Error('Offline SSR'); },
};
`,
              loader: 'js',
            }),
          );

          builder.onResolve({ filter: /state\/AppContext\.tsx$/ }, () => ({
            path: 'mock-app-context',
            namespace: 'mock-app-context',
          }));
          builder.onLoad(
            { filter: /.*/, namespace: 'mock-app-context' },
            () => ({
              contents: `
import React from 'react';
export const useApp = () => ({
  currentUser: { id: 'u1', name: 'Tester', email: 'test@example.com', role: 'admin' },
  currentProject: { id: 'proj-001', name: 'Demo Project', slug: 'demo' },
  projects: [{ id: 'proj-001', name: 'Demo Project', slug: 'demo' }],
  currentRoute: 'saved-cases',
  routeParams: {},
  isMock: false,
  sessionLoading: false,
  setRoute: () => {},
  setCurrentProject: () => {},
  toggleMock: () => {},
  logout: async () => {},
  login: async () => {},
});
export const AppProvider = ({ children }) => children;
`,
              loader: 'js',
            }),
          );
        },
      },
    ],
  });

  const {
    importModalOpenHtml,
    importModalClosedHtml,
    exportModalOpenHtml,
    exportModalClosedHtml,
    savedCasesPageHtml,
    savedCaseDetailPageHtml,
  } = await import(pathToFileURL(file).href);

  console.log('--- Suite 1: SavedCaseYamlImportModal Static Markup ---');
  // Closed should render nothing
  assert.equal(
    importModalClosedHtml,
    '',
    'Closed import modal must render empty',
  );
  console.log('  ✓ [PASS] Closed import modal renders empty string');

  // Open should render modal elements
  assert.ok(
    importModalOpenHtml.includes('data-testid="yaml-import-modal"'),
    'Modal container missing',
  );
  assert.ok(
    importModalOpenHtml.includes('data-testid="yaml-import-safety-notice"'),
    'Safety notice missing',
  );
  assert.ok(importModalOpenHtml.includes('draft'), 'Draft notice missing');
  assert.ok(
    importModalOpenHtml.includes('data-testid="input-yaml-slug"'),
    'Slug input missing',
  );
  assert.ok(
    importModalOpenHtml.includes('data-testid="input-yaml-name"'),
    'Name input missing',
  );
  assert.ok(
    importModalOpenHtml.includes('data-testid="input-yaml-content"'),
    'YAML textarea missing',
  );
  assert.ok(
    importModalOpenHtml.includes('data-testid="yaml-char-counter"'),
    'Character counter missing',
  );
  assert.ok(
    importModalOpenHtml.includes('262,144'),
    'Max length 262,144 missing',
  );
  assert.ok(
    importModalOpenHtml.includes('data-testid="btn-upload-yaml-file"'),
    'File upload button missing',
  );
  assert.ok(
    importModalOpenHtml.includes('data-testid="btn-submit-yaml-import"'),
    'Submit button missing',
  );
  console.log(
    '  ✓ [PASS] Open import modal includes all required form elements and draft notice',
  );

  console.log('--- Suite 2: SavedCaseYamlExportModal Static Markup ---');
  // Closed should render nothing
  assert.equal(
    exportModalClosedHtml,
    '',
    'Closed export modal must render empty',
  );
  console.log('  ✓ [PASS] Closed export modal renders empty string');

  // Open should render export modal structure
  assert.ok(
    exportModalOpenHtml.includes('data-testid="yaml-export-modal"'),
    'Export modal container missing',
  );
  assert.ok(exportModalOpenHtml.includes('v1'), 'Version number missing');
  assert.ok(
    exportModalOpenHtml.includes('data-testid="btn-close-yaml-export"'),
    'Close button missing',
  );
  assert.ok(
    exportModalOpenHtml.includes('data-testid="yaml-export-loading"'),
    'Loading indicator missing',
  );
  console.log(
    '  ✓ [PASS] Open export modal renders modal structure and version binding',
  );

  console.log('--- Suite 3: SavedCasesPage Button Mounting ---');
  assert.ok(
    savedCasesPageHtml.includes('data-testid="btn-import-yaml-case"'),
    'Import YAML button missing on page',
  );
  assert.ok(
    savedCasesPageHtml.includes('导入 YAML 用例'),
    'Import YAML text missing on button',
  );
  console.log(
    '  ✓ [PASS] SavedCasesPage mounts btn-import-yaml-case action button',
  );

  console.log('--- Suite 4: SavedCaseDetailPage Static SSR ---');
  assert.ok(
    savedCaseDetailPageHtml.includes('data-testid="saved-case-detail-loading"'),
    'Detail page container missing',
  );
  assert.ok(
    savedCaseDetailPageHtml.includes('正在加载用例详情与版本历史'),
    'Loading indicator text missing',
  );
  console.log(
    '  ✓ [PASS] SavedCaseDetailPage SSR succeeds and mounts without runtime errors',
  );

  console.log(
    '\n================================================================',
  );
  console.log(' Summary: All T10-YAML-UI offline SSR assertions PASSED');
  console.log(
    '================================================================',
  );

  console.log(
    JSON.stringify(
      {
        importModalMarkupVerified: true,
        exportModalMarkupVerified: true,
        savedCasesPageButtonVerified: true,
        offlineStaticSSR: true,
        browserExecuted: false,
        egoPaused: true,
        P0Passed: false,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
