import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  hasReadableMainContent,
  isFixedTechnicalSmoke,
} from '../dist/technical-smoke.js';

const http = {
  id: 'smoke.http',
  kind: 'http_status',
  sourceKind: 'generic_smoke',
  sourceRef: 'FR-013/016',
  expectedValue: { min: 200, max: 399 },
};
const body = {
  id: 'smoke.visible',
  kind: 'element_visible',
  sourceKind: 'generic_smoke',
  sourceRef: 'FR-016',
  locator: { by: 'css', value: 'body' },
};
const canonical = {
  outline: [
    'Navigate https://approved.example.test/',
    'Observe visible primary content',
  ],
  criteria: [http, body],
};
test('only canonical server-owned generic smoke can skip AI exploration', () => {
  assert.equal(isFixedTechnicalSmoke(canonical), true);
  assert.equal(
    isFixedTechnicalSmoke({ ...canonical, criteria: [http] }),
    false,
  );
  assert.equal(isFixedTechnicalSmoke(null), false);
  assert.equal(isFixedTechnicalSmoke({ ...canonical, criteria: [] }), false);
  assert.equal(
    isFixedTechnicalSmoke({
      ...canonical,
      outline: ['Navigate https://approved.example.test/', 'Click submit'],
    }),
    false,
  );
  assert.equal(
    isFixedTechnicalSmoke({
      ...canonical,
      criteria: [{ ...http, sourceKind: 'user_spec' }, body],
    }),
    false,
  );
  assert.equal(
    isFixedTechnicalSmoke({
      ...canonical,
      criteria: [{ ...http, expectedValue: { min: 100, max: 599 } }, body],
    }),
    false,
  );
  assert.equal(
    isFixedTechnicalSmoke({
      ...canonical,
      criteria: [
        http,
        { ...body, locator: { by: 'css', value: '.logged-in' } },
      ],
    }),
    false,
  );
  assert.equal(
    isFixedTechnicalSmoke({
      ...canonical,
      criteria: [
        http,
        body,
        {
          id: 'business',
          kind: 'semantic',
          sourceKind: 'user_spec',
          sourceRef: 'user',
          description: 'Logged in',
        },
      ],
    }),
    false,
  );
});

test('loading-only snapshot is not body-visible evidence; rendered button is', () => {
  assert.equal(
    hasReadableMainContent({
      nodes: [
        {
          visible: true,
          frameId: 'main',
          role: 'bar',
          text: '',
          name: 'Loading',
        },
      ],
    }),
    false,
  );
  assert.equal(
    hasReadableMainContent({
      nodes: [
        { visible: true, frameId: 'main', role: 'button', text: 'Sign in' },
      ],
    }),
    true,
  );
  assert.equal(
    hasReadableMainContent({
      nodes: [
        { visible: true, frameId: 'main', role: 'password', text: 'secret' },
      ],
    }),
    false,
  );
  assert.equal(
    hasReadableMainContent({
      nodes: [
        { visible: true, frameId: 'other', role: 'button', text: 'Sign in' },
      ],
    }),
    false,
  );
});
