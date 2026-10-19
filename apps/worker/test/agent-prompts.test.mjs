// Prompt text is behaviour here: 66 showed 1/205 steps with a thought and 2/6
// reproduction steps with a recording anchor, because both were presented as
// optional. These assertions pin what the model is told; the validation rules
// around them are unchanged and tested elsewhere (agent-report.test.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderPrompt } from '../../../packages/agents/dist/index.js';
import { reportPrompt } from '../dist/index.js';

test('every browser role is told the note is mandatory and shown to the user', () => {
  for (const role of ['explorer', 'executor', 'reproducer']) {
    const line = renderPrompt(role)
      .text.split('\n')
      .find((candidate) => candidate.includes('note'));
    assert.ok(line, `${role} has a note instruction`);
    assert.match(line, /必须/, `${role}: note is required`);
    assert.doesNotMatch(
      line,
      /不填也能执行|可选/,
      `${role}: no "optional" escape hatch left`,
    );
    assert.match(line, /用户会/, 'says the user reads it');
    assert.match(line, /80 字/, 'one sentence, with a length to aim for');
    assert.match(line, /截断|300/, 'overlong notes are truncated');
    assert.match(line, /敏感值/, 'secrets stay out');
    assert.match(
      line,
      /不能代替工具参数/,
      'the action still comes from toolCalls',
    );
  }
  // The assertion role does not act in the browser, so it gets no note rule.
  assert.equal(renderPrompt('assertion').text.includes('note 写一句'), false);
});

test('the reproduction report asks for an anchor per step, with how to pick it', () => {
  const text = reportPrompt(true);
  assert.match(text, /reproStepActions/);
  assert.doesNotMatch(text, /可选 reproStepActions/, 'no longer optional');
  assert.match(text, /尽量给每条复现步骤都标出/, 'asks for every step');
  // The three mappings the 66 recording needed.
  assert.match(text, /操作类步骤.*执行它的那个动作/);
  assert.match(text, /观察或检查类步骤.*capture 或 observe/);
  assert.match(text, /打开入口地址.*navigate/);
  // The guardrails survive the stronger wording.
  assert.match(text, /index 递增/);
  assert.match(text, /seq 单调不减/);
  assert.match(text, /必须来自本任务已有动作/);
  assert.match(text, /禁止编造不存在的编号/);
  assert.match(text, /不合法锚点只会被丢弃/);
  // Ordinary runs (no reproduction) never see the anchor field.
  assert.equal(reportPrompt(false).includes('reproStepActions'), false);
});
