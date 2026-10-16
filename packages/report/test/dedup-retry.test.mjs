import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ReportBuilder, renderMarkdownReport } from '../dist/index.js';
import { mergeSessionFindings } from '../../orchestrator/dist/session-findings.js';
import { retrySessionCases } from '../../orchestrator/dist/session-retries.js';
import { sessionFixture } from '../../orchestrator/test/fixtures/session.mjs';

const sample = JSON.parse(
  readFileSync(
    new URL('../../../docs/examples/report.sample.json', import.meta.url),
    'utf8',
  ),
);

function reportClient(fixture) {
  return {
    async query(sql, params) {
      if (sql.includes('SELECT id, document FROM run_cases'))
        return {
          rows: [...fixture.state.cases.values()].map((c) => ({
            id: c.id,
            document: c,
          })),
        };
      if (
        sql.includes(
          'SELECT id, case_id, attempt_number, status FROM case_attempts',
        )
      )
        return {
          rows: fixture.state.attempts.map((a) => ({
            id: a.id,
            case_id: a.caseId,
            attempt_number: a.number,
            status: a.verdict ? 'completed' : 'interrupted',
          })),
        };
      if (sql.includes('FROM final_valid_verdicts v'))
        return {
          rows: [...fixture.state.cases.values()]
            .map(fixture.currentCase)
            .filter((c) => c.verdict)
            .map((c) => ({
              id: c.verdict.id,
              case_id: c.definition.id,
              attempt_id: c.verdict.attemptId,
              document: c.verdict,
            })),
        };
      if (
        sql.includes('SELECT document FROM reproductions') ||
        sql.includes('SELECT document FROM steps') ||
        sql.includes('FROM model_requests') ||
        sql.includes("role = 'finalizer'")
      )
        return { rows: [] };
      if (sql.includes('SELECT document FROM artifacts'))
        return {
          rows: [...fixture.state.artifacts.entries()].map(([id, owner]) => ({
            document: {
              id,
              ...owner,
              taskId: null,
              stepId: null,
              caseId: null,
              snapshotId: null,
              kind: 'screenshot',
              status: 'available',
              bytes: 10,
              sha256: 'a'.repeat(64),
              contentUrl: null,
              redaction: 'not_needed',
              error: null,
              createdAt: new Date().toISOString(),
            },
          })),
        };
      return fixture.client.query(sql, params);
    },
  };
}

test('Markdown counts only independent findings and keeps duplicateOf links in a separate audit section', () => {
  const root = structuredClone(sample.findings[0]);
  const duplicate = {
    ...root,
    id: randomUUID(),
    title: '同一 404 的另一条缺陷',
    triageDisposition: 'duplicate',
    duplicateOf: root.id,
  };
  const markdown = renderMarkdownReport({
    ...sample,
    findings: [root, duplicate],
  });
  assert.match(markdown, /Findings & Reproductions \(1 unique finding\(s\)\)/);
  assert.equal((markdown.match(/Finding:/g) ?? []).length, 1);
  assert.ok(!markdown.includes(`Finding: ${duplicate.title}`));
  assert.match(markdown, /Merged duplicate references \(not counted\)/);
  assert.ok(markdown.includes(`Duplicate \`${duplicate.id}\``));
  assert.ok(markdown.includes(`→ \`${root.id}\``));
  const duplicatesOnly = renderMarkdownReport({
    ...sample,
    findings: [duplicate],
  });
  assert.match(duplicatesOnly, /0 unique finding/);
  assert.match(duplicatesOnly, /No independent findings/);
});

test('ReportBuilder retains duplicate records for traceability but excludes them from run stats, not failed-case counts', async () => {
  const fixture = sessionFixture();
  const root = fixture.addFinding(fixture.addCase('issue_found'));
  const source = fixture.addFinding(fixture.addCase('issue_found'));
  await mergeSessionFindings(fixture.client, fixture.run, [
    { findingId: source.id, sameAs: root.id, reason: '同一个 404' },
  ]);
  const report = await new ReportBuilder().build(
    reportClient(fixture),
    fixture.run.projectId,
    fixture.run.id,
  );
  assert.equal(report.run.stats.findings, 1);
  assert.equal(report.run.stats.issues, 2);
  assert.equal(
    report.summary.issueFound,
    2,
    'case failures and independent findings are different metrics',
  );
  assert.equal(report.findings.length, 2);
  assert.equal(
    report.findings.find((finding) => finding.id === source.id).duplicateOf,
    root.id,
  );
  assert.equal(
    report.findings.find((finding) => finding.id === root.id).caseIds.length,
    2,
  );
  assert.match(renderMarkdownReport(report), /1 unique finding/);
});

test('ReportBuilder and Markdown use the newest execution report after retry and do not count old blocks', async () => {
  const fixture = sessionFixture();
  const record = fixture.addCase('blocked');
  await retrySessionCases(
    fixture.client,
    fixture.coordinator,
    fixture.run,
    [record],
    [record.definition.id],
  );
  const job = fixture.state.enqueued[0];
  job.status = 'succeeded';
  const latest = fixture.addAttempt(record.definition, {
    job,
    outcome: 'passed',
    summary: '重跑成功：订单明细显示正确',
  });
  const report = await new ReportBuilder().build(
    reportClient(fixture),
    fixture.run.projectId,
    fixture.run.id,
  );
  assert.equal(report.summary.planned, 1);
  assert.equal(report.summary.passed, 1);
  assert.equal(report.summary.blocked, 0);
  assert.equal(report.cases[0].verdict.id, latest.verdict.id);
  const markdown = renderMarkdownReport(report);
  assert.ok(markdown.includes(latest.verdict.summary));
  assert.ok(!markdown.includes(record.verdict.summary));
});
