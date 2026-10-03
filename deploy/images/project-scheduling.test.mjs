import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectOffers } from './project-scheduling.mjs';

test('round-robin offers share four slots and rotate the first project', () => {
  assert.deepEqual(projectOffers(['a', 'b'], 4, 0), ['a', 'b', 'a', 'b']);
  assert.deepEqual(projectOffers(['a', 'b'], 4, 1), ['b', 'a', 'b', 'a']);
  assert.deepEqual(projectOffers(['a', 'b', 'c'], 4, 1), ['b', 'c', 'a', 'b']);
  assert.deepEqual(projectOffers([], 4, 0), []);
  assert.deepEqual(projectOffers(['a'], 0, 0), []);
});
