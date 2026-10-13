/* global window */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BrowserManager } from '@localqa/browser';
import { compileRegression } from '@localqa/orchestrator';
import { replayRegression } from '../dist/regression-replay.js';

test(
  'real Chromium: delayed first control recovers, then next business step shares browser state',
  { timeout: 30000 },
  async () => {
    const manager = new BrowserManager();
    const session = await manager.createSession({
      projectId: randomUUID(),
      runId: randomUUID(),
      taskId: randomUUID(),
      mode: 'full',
    });
    try {
      const page = session.getPage();
      await page.setContent(`
        <h1>Checkout fixture</h1>
        <script>
          window.clickCount = 0;
          setTimeout(() => {
            const next = document.createElement('button');
            next.setAttribute('aria-label', 'Next');
            next.textContent = 'Next';
            next.addEventListener('click', () => {
              window.clickCount++;
              const label = document.createElement('label');
              label.textContent = 'Email';
              const input = document.createElement('input');
              label.append(input);
              document.body.append(label);
            });
            document.body.append(next);
          }, 400);
        </script>
      `);
      const plan = compileRegression(
        {
          schemaVersion: 1,
          kind: 'localqa/test',
          id: 'business-recovery',
          name: 'Checkout fixture',
          criteria: [
            {
              id: 'email-entered',
              kind: 'text_equals',
              description: 'Email is entered',
              sourceKind: 'user_spec',
              sourceRef: 'fixture',
              locator: { by: 'label', value: 'Email' },
              expectedValue: 'business@example.test',
            },
          ],
          steps: [
            {
              kind: 'click',
              locator: { by: 'role', value: 'button', name: 'Next' },
            },
            {
              kind: 'type_text',
              locator: { by: 'label', value: 'Email' },
              text: 'business@example.test',
            },
            { kind: 'assert', criterionId: 'email-entered' },
          ],
        },
        {
          projectId: 'p',
          env: {},
          allowedOrigins: ['https://fixture.test'],
          maxExpandedSteps: 100,
          resolveModule: () => undefined,
        },
      );
      const signal = new AbortController().signal;
      const result = await replayRegression(
        plan,
        {
          async resolveTarget(locator, _source, operationSignal) {
            const observed = await session.executeTool(
              { name: 'observe', args: {} },
              { signal: operationSignal },
            );
            assert.equal(observed.status, 'succeeded');
            return session.resolveRegressionLocator(locator, operationSignal);
          },
          async executeTool(call, _source, operationSignal) {
            const receipt = await session.executeTool(call, {
              signal: operationSignal,
            });
            return {
              status: receipt.status === 'succeeded' ? 'succeeded' : 'failed',
              ...(receipt.reasonCode ? { reasonCode: receipt.reasonCode } : {}),
            };
          },
          async evaluateCriterion(criterion) {
            const typed = await page.getByLabel('Email').inputValue();
            return {
              criterionId: criterion.id,
              result: typed === criterion.expectedValue ? 'passed' : 'failed',
              reason: 'Observed in actual browser',
              evidenceRefs: [],
            };
          },
        },
        signal,
      );
      assert.equal(result.status, 'completed', JSON.stringify(result));
      assert.ok(result.steps[0].resolutionAttempts > 1);
      assert.ok(result.steps[0].resolutionAttempts <= 3);
      assert.equal(result.steps[0].tools.length, 1);
      assert.equal(result.steps[1].tools.length, 1);
      assert.equal(result.steps[2].criterionResults[0].result, 'passed');
      assert.equal(await page.evaluate(() => window.clickCount), 1);
      assert.equal(
        await page.getByLabel('Email').inputValue(),
        'business@example.test',
      );
    } finally {
      await session.close();
      await manager.close();
    }
  },
);

test(
  'real Chromium: 24 sequential DOM replacements execute once each with a frozen final assertion',
  { timeout: 60000 },
  async () => {
    const manager = new BrowserManager();
    const session = await manager.createSession({
      projectId: randomUUID(),
      runId: randomUUID(),
      taskId: randomUUID(),
      mode: 'full',
    });
    try {
      const page = session.getPage();
      await page.setContent(`
        <h1>24-step business workflow</h1>
        <script>
          window.executions = [];
          function showStage(index) {
            const button = document.createElement('button');
            button.textContent = 'Stage ' + index;
            button.addEventListener('click', () => {
              window.executions.push(index);
              button.remove(); // invalidate the previous DOM node after every action
              if (index < 24) showStage(index + 1);
              else {
                const done = document.createElement('div');
                done.setAttribute('role', 'status');
                done.setAttribute('aria-label', 'Workflow completed');
                done.textContent = 'done';
                document.body.append(done);
              }
            });
            document.body.append(button);
          }
          showStage(1);
        </script>
      `);
      const plan = compileRegression(
        {
          schemaVersion: 1,
          kind: 'localqa/test',
          id: '24-stage-business-flow',
          name: 'Sequential DOM replacements',
          criteria: [
            {
              id: 'flow-finished',
              kind: 'element_visible',
              description: 'All stages finished',
              sourceKind: 'user_spec',
              sourceRef: 'fixture',
              locator: {
                by: 'role',
                value: 'status',
                name: 'Workflow completed',
              },
            },
          ],
          steps: [
            ...Array.from({ length: 24 }, (_, index) => ({
              kind: 'click',
              locator: {
                by: 'role',
                value: 'button',
                name: `Stage ${index + 1}`,
              },
            })),
            { kind: 'assert', criterionId: 'flow-finished' },
          ],
        },
        {
          projectId: 'p',
          env: {},
          allowedOrigins: ['https://fixture.test'],
          maxExpandedSteps: 100,
          resolveModule: () => undefined,
        },
      );
      const result = await replayRegression(
        plan,
        {
          async resolveTarget(locator, _source, signal) {
            const fresh = await session.executeTool(
              { name: 'observe', args: {} },
              { signal },
            );
            assert.equal(fresh.status, 'succeeded');
            return session.resolveRegressionLocator(locator, signal);
          },
          async executeTool(call, _source, signal) {
            const receipt = await session.executeTool(call, { signal });
            return {
              status: receipt.status === 'succeeded' ? 'succeeded' : 'failed',
              ...(receipt.reasonCode ? { reasonCode: receipt.reasonCode } : {}),
            };
          },
          async evaluateCriterion(criterion) {
            const visible = await page
              .getByRole('status', { name: 'Workflow completed' })
              .isVisible();
            return {
              criterionId: criterion.id,
              result: visible ? 'passed' : 'failed',
              reason: 'Fresh browser state',
              evidenceRefs: [],
            };
          },
        },
        new AbortController().signal,
      );
      assert.equal(result.status, 'completed', JSON.stringify(result));
      assert.equal(result.steps.length, 25);
      for (const record of result.steps.slice(0, 24)) {
        assert.equal(record.status, 'completed');
        assert.equal(record.tools.length, 1, 'each click executes once');
        assert.equal(record.resolutionAttempts, 1);
      }
      assert.equal(result.steps[24].criterionResults[0].result, 'passed');
      assert.deepEqual(
        await page.evaluate(() => window.executions),
        Array.from({ length: 24 }, (_, index) => index + 1),
      );
    } finally {
      await session.close();
      await manager.close();
    }
  },
);

test(
  'real Chromium: the third unresponsive click is blocked before browser mutation',
  { timeout: 30000 },
  async () => {
    const manager = new BrowserManager();
    const session = await manager.createSession({
      projectId: randomUUID(),
      runId: randomUUID(),
      taskId: randomUUID(),
      mode: 'full',
    });
    try {
      const page = session.getPage();
      await page.setContent(`
        <button>Unresponsive action</button>
        <script>
          window.clickCount = 0;
          document.querySelector('button').addEventListener('click', () => {
            window.clickCount++;
          });
        </script>
      `);
      const signal = new AbortController().signal;
      const outcomes = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const observed = await session.executeTool(
          { name: 'observe', args: {} },
          { signal },
        );
        assert.equal(observed.status, 'succeeded');
        const target = await session.resolveRegressionLocator(
          { by: 'role', value: 'button', name: 'Unresponsive action' },
          signal,
        );
        const result = await session.executeTool(
          { name: 'click', args: { target } },
          { signal },
        );
        outcomes.push(result);
      }
      assert.deepEqual(
        outcomes.map((outcome) => outcome.status),
        ['succeeded', 'succeeded', 'failed'],
      );
      assert.equal(outcomes[2].reasonCode, 'REPEATED_ACTION_LIMIT');
      assert.equal(
        await page.evaluate(() => window.clickCount),
        2,
        'blocked action must never reach the page',
      );
    } finally {
      await session.close();
      await manager.close();
    }
  },
);
