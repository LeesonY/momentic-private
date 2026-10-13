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

function makeTestSetup(objective = '测试 TodoMVC 流程') {
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
    objective,
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
      if (sql.includes('FROM input_requests')) {
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
  return {
    run,
    client,
    agent,
    getSessionDoc: () => sessionDoc,
    setSessionDoc: (d) => {
      sessionDoc = d;
    },
  };
}

test('SessionAgent writes explicit title on first plan and never overwrites on subsequent plans', async () => {
  const { run, client, agent, getSessionDoc, setSessionDoc } = makeTestSetup();

  const jobRound1 = {
    id: randomUUID(),
    role: 'coordinator',
    result: { stage: 'plan', sessionRound: 1 },
  };

  // 1. 首次规划：传入 explicit title
  await agent.applyPlan(client, run, jobRound1, {
    action: 'finish',
    rationale: '首次规划完成',
    title: 'TodoMVC 待办流程',
    cases: [],
    exploreTargets: [],
    coverageGaps: [],
  });

  assert.equal(getSessionDoc().title, 'TodoMVC 待办流程');

  // 2. 第二次规划：已有 title，即使新 proposal 给出不同 title，也不覆盖
  const doc = getSessionDoc();
  doc.round = 2;
  setSessionDoc(doc);

  const jobRound2 = {
    id: randomUUID(),
    role: 'coordinator',
    result: { stage: 'plan', sessionRound: 2 },
  };

  await agent.applyPlan(client, run, jobRound2, {
    action: 'finish',
    rationale: '二次规划完成',
    title: '企图覆盖的全新标题',
    cases: [],
    exploreTargets: [],
    coverageGaps: [],
  });

  assert.equal(
    getSessionDoc().title,
    'TodoMVC 待办流程',
    '已有的 title 不应被后续轮次覆盖',
  );
});

test('SessionAgent falls back to objective (first line, trimmed, capped at 20 chars) when model omits title', async () => {
  const longObjective =
    '这是一个超长的用户测试请求说明用于验证兜底标题截取功能正常运作\n第二行额外说明内容';
  const { run, client, agent, getSessionDoc } = makeTestSetup(longObjective);

  const job = {
    id: randomUUID(),
    role: 'coordinator',
    result: { stage: 'plan', sessionRound: 1 },
  };

  // 模型未提供 title
  await agent.applyPlan(client, run, job, {
    action: 'finish',
    rationale: '首次规划',
    cases: [],
    exploreTargets: [],
    coverageGaps: [],
  });

  // 第一行取前 20 字符
  const expected = longObjective.split('\n')[0].trim().slice(0, 20);
  assert.equal(getSessionDoc().title, expected);
  assert.equal(getSessionDoc().title.length, 20);
});

test('SessionAgent does not set title when both model title and objective are empty', async () => {
  const { run, client, agent, getSessionDoc } = makeTestSetup('   \n  ');

  const job = {
    id: randomUUID(),
    role: 'coordinator',
    result: { stage: 'plan', sessionRound: 1 },
  };

  await agent.applyPlan(client, run, job, {
    action: 'finish',
    rationale: '首次规划无目标',
    cases: [],
    exploreTargets: [],
    coverageGaps: [],
  });

  assert.equal(getSessionDoc().title, undefined, 'objective 为空时不写 title');
});
