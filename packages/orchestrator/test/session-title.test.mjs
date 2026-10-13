import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Coordinator } from '../dist/core.js';
import { SessionAgent } from '../dist/session-agent.js';
import { reviewSessionProposal } from '../dist/session-planning.js';

test('reviewSessionProposal extracts title and trims whitespace', () => {
  const proposal = {
    action: 'finish',
    rationale: '冒烟完成',
    title: '  TodoMVC 待办流程  ',
    cases: [],
    exploreTargets: [],
    coverageGaps: [],
  };
  const accepted = reviewSessionProposal(proposal, {
    targetUrl: 'https://fixture.test/',
    allowedOrigins: ['https://fixture.test'],
    protectedOrigins: [],
    remainingCases: 2,
    remainingPages: 2,
    existingCases: [],
    exploredUrls: [],
  });
  assert.equal(accepted.title, 'TodoMVC 待办流程');
});

test('SessionAgent writes title on first plan and never overwrites on subsequent plans', async () => {
  const projectId = randomUUID();
  const runId = randomUUID();
  const profileId = randomUUID();
  const run = {
    id: runId,
    projectId,
    phase: 'plan',
    targetUrl: 'https://fixture.test/',
    effectiveConfig: {
      allowedOrigins: ['https://fixture.test'],
      actionPolicy: 'non_submitting',
      taskIntent: 'flow',
      budget: { maxCases: 5, maxPages: 5 },
      models: {
        assertion: { profileId, version: 1 },
      },
    },
  };

  let sessionDoc = {
    objective: '测试 TodoMVC 流程',
    round: 1,
    status: 'planning',
    plan: '',
    caseIds: [],
    exploredUrls: [],
    coverageGaps: [],
    summary: '',
    history: [],
  };

  const client = {
    async query(sql, params) {
      if (sql.includes('SELECT event_seq FROM runs')) {
        return { rows: [{ event_seq: '0' }] };
      }
      if (sql.includes('UPDATE runs SET event_seq')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT run_id FROM run_sessions')) {
        return { rows: [{ run_id: runId }] };
      }
      if (sql.includes('SELECT document FROM run_sessions')) {
        return { rows: [{ document: sessionDoc }] };
      }
      if (sql.includes('UPDATE run_sessions SET document=$3')) {
        sessionDoc = params[2];
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO run_events')) {
        return { rows: [] };
      }
      if (sql.includes('FROM run_messages')) {
        return { rows: [] };
      }
      if (sql.includes('FROM run_knowledge_bindings')) {
        return { rows: [] };
      }
      if (sql.includes('FROM page_snapshots')) {
        return { rows: [] };
      }
      if (sql.includes('FROM run_cases')) {
        return { rows: [] };
      }
      if (sql.includes('FROM findings')) {
        return { rows: [] };
      }
      if (sql.includes('FROM model_profile_versions')) {
        return {
          rows: [
            {
              document: {
                id: profileId,
                name: 'test-model',
                endpoint: 'https://model.test/v1',
                configuredModelId: 'test-model',
                adapter: 'openai_compatible',
                dataBoundary: 'internal',
                capabilities: {
                  structuredOutput: true,
                  nativeTools: true,
                  imageInput: false,
                },
                status: 'ready',
                version: 1,
              },
            },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const coordinator = new Coordinator({
    db: {},
    vault: {},
    serviceActor: { userId: randomUUID() },
  });
  coordinator.protectedOrigins = [];
  coordinator.change = async () => {};
  coordinator.enqueue = async () => {};
  coordinator.insertCase = async () => {};

  const agent = new SessionAgent(coordinator);

  const jobRound0 = {
    id: randomUUID(),
    role: 'coordinator',
    result: { stage: 'plan', sessionRound: 1 },
  };

  // 1. 首次规划：传入 title，应成功写入 sessionDoc.title
  await agent.applyPlan(client, run, jobRound0, {
    action: 'finish',
    rationale: '首次规划完成',
    title: 'TodoMVC 待办流程',
    cases: [],
    exploreTargets: [],
    coverageGaps: [],
  });

  assert.equal(sessionDoc.title, 'TodoMVC 待办流程');

  // 2. 第二次规划：sessionDoc 已有 title，即使新 proposal 给出新 title，也不覆盖
  sessionDoc.round = 2;
  const jobRound1 = {
    id: randomUUID(),
    role: 'coordinator',
    result: { stage: 'plan', sessionRound: 2 },
  };

  await agent.applyPlan(client, run, jobRound1, {
    action: 'finish',
    rationale: '二次规划完成',
    title: '企图覆盖的全新标题',
    cases: [],
    exploreTargets: [],
    coverageGaps: [],
  });

  assert.equal(
    sessionDoc.title,
    'TodoMVC 待办流程',
    '已有的 title 不应被后续轮次覆盖',
  );
});
