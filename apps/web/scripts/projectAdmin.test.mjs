// Offline verification of the rules behind 项目管理: name validation, which
// project the shell switches to after a deletion, how a deletion preview reads,
// and the "this model is another project's default" hint. Pure functions only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deletionBlocker,
  deletionPreviewLines,
  deletionPreviewSummary,
  describeDefaultModel,
  isVersionConflict,
  nextProjectAfterRemoval,
  projectStatusLabel,
  projectsUsingDefaultModel,
  validateProjectName,
} from '../src/utils/projectAdmin.ts';

const project = (id, name, status = 'active', modelId = null) => ({
  id,
  name,
  status,
  defaultModelProfileId: modelId,
  createdAt: '2026-10-01T00:00:00.000Z',
  version: 1,
});

test('a project name is trimmed, non-empty and at most 120 characters', () => {
  assert.deepEqual(validateProjectName('  项目 A  '), {
    ok: true,
    name: '项目 A',
  });
  const empty = validateProjectName('   ');
  assert.equal(empty.ok, false);
  assert.equal(empty.error, '项目名称不能为空');
  const long = validateProjectName('x'.repeat(121));
  assert.equal(long.ok, false);
  assert.match(long.error, /120/);
  assert.equal(validateProjectName('x'.repeat(120)).ok, true);
});

test('status labels and the default-model column are readable', () => {
  assert.equal(projectStatusLabel('active'), '进行中');
  assert.equal(projectStatusLabel('archived'), '已归档');
  const models = [{ id: 'm1', name: 'GPT-4o' }];
  assert.equal(describeDefaultModel(models, 'm1'), 'GPT-4o');
  assert.equal(describeDefaultModel(models, null), '未设置');
  assert.equal(describeDefaultModel(models, 'gone'), '已删除的模型');
});

test('after deleting the current project the next usable one is selected', () => {
  const active = project('a', 'A');
  const archived = project('b', 'B', 'archived');
  const other = project('c', 'C');
  assert.equal(nextProjectAfterRemoval([archived, active, other], 'a'), other);
  // No active project left: fall back to whatever remains (archived included).
  assert.equal(nextProjectAfterRemoval([archived], 'a'), archived);
  assert.equal(nextProjectAfterRemoval([active], 'a'), null);
  // The helper only answers "which project should be selected now"; the shell
  // keeps the current one when the removed project was not it.
  assert.equal(nextProjectAfterRemoval([active, other], 'c'), active);
  assert.equal(nextProjectAfterRemoval([other], 'c'), null);
});

test('the model-delete hint names the projects that use it as default', () => {
  const first = project('a', 'Alpha', 'active', 'm1');
  const second = project('b', 'Beta', 'active', 'm1');
  const third = project('c', 'Gamma', 'active', 'm2');
  assert.deepEqual(
    projectsUsingDefaultModel([first, second, third], 'm1').map((p) => p.name),
    ['Alpha', 'Beta'],
  );
  assert.deepEqual(projectsUsingDefaultModel([first, third], 'm9'), []);
  assert.deepEqual(projectsUsingDefaultModel([first], null), []);
});

test('the deletion preview reads as one sentence about what disappears', () => {
  const preview = {
    empty: false,
    counts: {
      runs: 3,
      activeRuns: 0,
      savedCases: 2,
      enabledSchedules: 1,
      environments: 4,
      authProfiles: 5,
      members: 2,
      activeApiKeys: 6,
    },
  };
  assert.deepEqual(deletionPreviewLines(preview), [
    '3 个会话',
    '2 条用例',
    '4 个环境',
    '5 个凭证',
    '1 个启用的定时计划（将停用）',
    '6 个 API Key（将吊销）',
    '2 位成员',
  ]);
  assert.equal(
    deletionPreviewSummary(preview),
    '包含 3 个会话、2 条用例、4 个环境、5 个凭证、1 个启用的定时计划（将停用）、6 个 API Key（将吊销）、2 位成员。',
  );
  const empty = {
    empty: true,
    counts: {
      runs: 0,
      activeRuns: 0,
      savedCases: 0,
      enabledSchedules: 0,
      environments: 0,
      authProfiles: 0,
      members: 0,
      activeApiKeys: 0,
    },
  };
  assert.deepEqual(deletionPreviewLines(empty), []);
  assert.match(deletionPreviewSummary(empty), /没有任何数据/);
});

test('a running session blocks the deletion with a reason the user can act on', () => {
  const counts = { activeRuns: 2 };
  assert.equal(
    deletionBlocker({ counts }),
    '项目还有 2 个会话没结束，请先停止后再删除',
  );
  assert.equal(deletionBlocker({ counts: { activeRuns: 0 } }), null);
  assert.equal(deletionBlocker(null), null);
});

test('a stale project version is recognised from the error code or message', () => {
  assert.equal(
    isVersionConflict(
      Object.assign(new Error('conflict'), { code: 'VERSION_CONFLICT' }),
    ),
    true,
  );
  assert.equal(
    isVersionConflict(new Error('VERSION_CONFLICT: expected 2')),
    true,
  );
  assert.equal(isVersionConflict(new Error('项目不存在')), false);
  assert.equal(isVersionConflict(null), false);
});
