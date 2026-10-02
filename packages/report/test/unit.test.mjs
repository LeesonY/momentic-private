import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  calculateSummary,
  LocalVolumeArtifactStore,
  MAX_SINGLE_ARTIFACT_BYTES,
  assessReplayDegradation,
  validateEvidenceReferences,
  resolveCleanupStatus,
  renderMarkdownReport,
  packZip,
  unpackZip,
  verifyUnpackedZip,
} from '../dist/index.js';

test('calculateSummary: exact formula and zero denominator handling', () => {
  // 1. All passed
  const s1 = calculateSummary(['passed', 'passed', 'passed']);
  assert.equal(s1.planned, 3);
  assert.equal(s1.passed, 3);
  assert.equal(s1.issueFound, 0);
  assert.equal(s1.blocked, 0);
  assert.equal(s1.inconclusive, 0);
  assert.equal(s1.notRun, 0);
  assert.equal(s1.attempted, 3);
  assert.equal(s1.evaluated, 3);
  assert.equal(s1.passRate, 1);
  assert.equal(s1.attemptRate, 1);

  // 2. Mixed outcomes
  const s2 = calculateSummary([
    'passed',
    'issue_found',
    'blocked',
    'inconclusive',
    'not_run',
  ]);
  assert.equal(s2.planned, 5);
  assert.equal(s2.passed, 1);
  assert.equal(s2.issueFound, 1);
  assert.equal(s2.blocked, 1);
  assert.equal(s2.inconclusive, 1);
  assert.equal(s2.notRun, 1);
  assert.equal(s2.attempted, 4);
  assert.equal(s2.evaluated, 2);
  assert.equal(s2.passRate, 0.5); // 1 / 2
  assert.equal(s2.attemptRate, 0.8); // 4 / 5

  // 3. Zero evaluated (only blocked, inconclusive, not_run) -> passRate must be null
  const s3 = calculateSummary(['blocked', 'not_run']);
  assert.equal(s3.planned, 2);
  assert.equal(s3.attempted, 1);
  assert.equal(s3.evaluated, 0);
  assert.equal(s3.passRate, null);
  assert.equal(s3.attemptRate, 0.5);

  // 4. Zero planned (empty list) -> passRate and attemptRate must both be null
  const s4 = calculateSummary([]);
  assert.equal(s4.planned, 0);
  assert.equal(s4.attempted, 0);
  assert.equal(s4.evaluated, 0);
  assert.equal(s4.passRate, null);
  assert.equal(s4.attemptRate, null);
});

test('LocalVolumeArtifactStore: defensive path traversal rejection and limits', async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), 'lqa-artifact-test-'));
  const store = new LocalVolumeArtifactStore(tempDir);

  try {
    const validProject = randomUUID();
    const validRun = randomUUID();
    const validArtifact = randomUUID();

    // Rejection of non-UUID / path traversal
    await assert.rejects(
      store.get('../etc', validRun, validArtifact),
      (err) => err.code === 'VALIDATION_ERROR',
    );
    await assert.rejects(
      store.get(validProject, '../../root', validArtifact),
      (err) => err.code === 'VALIDATION_ERROR',
    );
    await assert.rejects(
      store.get(validProject, validRun, 'cmd.sh;id'),
      (err) => err.code === 'VALIDATION_ERROR',
    );

    // Rejection of oversized single artifact (> 25 MiB)
    const oversizedBytes = MAX_SINGLE_ARTIFACT_BYTES + 1;
    const fakeData = Buffer.alloc(oversizedBytes, 0xaa);
    await assert.rejects(
      store.put(
        {
          id: validArtifact,
          projectId: validProject,
          runId: validRun,
          kind: 'screenshot',
          redaction: 'not_needed',
          bytes: oversizedBytes,
          sha256: createHash('sha256').update(fakeData).digest('hex'),
        },
        fakeData,
      ),
      (err) => err.code === 'VALIDATION_ERROR',
    );

    // Normal write and read
    const testData = Buffer.from('Valid screenshot content bytes', 'utf8');
    const sha = createHash('sha256').update(testData).digest('hex');
    const art = await store.put(
      {
        id: validArtifact,
        projectId: validProject,
        runId: validRun,
        kind: 'screenshot',
        redaction: 'not_needed',
        bytes: testData.length,
        sha256: sha,
      },
      testData,
    );

    assert.equal(art.id, validArtifact);
    assert.equal(art.sha256, sha);
    assert.equal(art.bytes, testData.length);
    assert.equal(
      await store.exists(validProject, validRun, validArtifact),
      true,
    );

    const readBack = await store.get(validProject, validRun, validArtifact);
    assert.deepEqual(readBack, testData);

    // Deletion
    await store.delete(validProject, validRun, validArtifact);
    assert.equal(
      await store.exists(validProject, validRun, validArtifact),
      false,
    );
    await assert.rejects(
      store.get(validProject, validRun, validArtifact),
      (err) => err.code === 'NOT_FOUND',
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('ZIP packaging and extraction roundtrip', () => {
  const entries = [
    {
      name: 'report.json',
      data: JSON.stringify({ schemaVersion: 1, run: { id: 'test-run-id' } }),
    },
    {
      name: 'report.md',
      data: '# Offline Markdown Report\n\nNo external CDN.',
    },
    {
      name: 'manifest.json',
      data: JSON.stringify({
        schemaVersion: 1,
        runId: 'test-run-id',
        total: 1,
        available: 1,
      }),
    },
    {
      name: 'artifacts/screen-1.png',
      data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    },
  ];

  const zipBuf = packZip(entries);
  assert.ok(zipBuf.length > 0);

  const extracted = unpackZip(zipBuf);
  assert.equal(extracted.size, 4);
  assert.ok(extracted.has('report.json'));
  assert.ok(extracted.has('report.md'));
  assert.ok(extracted.has('manifest.json'));
  assert.ok(extracted.has('artifacts/screen-1.png'));

  assert.equal(
    extracted.get('report.json').data.toString('utf8'),
    JSON.stringify({ schemaVersion: 1, run: { id: 'test-run-id' } }),
  );
  assert.deepEqual(
    extracted.get('artifacts/screen-1.png').data,
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );

  const mockReport = {
    run: { id: 'test-run-id' },
  };
  const mockManifest = new Map([
    [
      'screen-1',
      {
        id: 'screen-1',
        kind: 'screenshot',
        status: 'available',
        relativePath: 'artifacts/screen-1.png',
        sha256: createHash('sha256')
          .update(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          .digest('hex'),
      },
    ],
  ]);

  const verifyRes = verifyUnpackedZip(zipBuf, mockManifest, mockReport);
  assert.equal(verifyRes.verified, true, JSON.stringify(verifyRes.errors));
});

test('Markdown export contains zero external CDN links and respects snapshot banner', () => {
  const mockReport = {
    schemaVersion: 1,
    example: false,
    generatedAt: new Date().toISOString(),
    run: {
      id: randomUUID(),
      projectId: randomUUID(),
      creatorId: randomUUID(),
      targetUrl: 'http://localhost:8080/test',
      status: 'running', // in-progress
      phase: 'execute',
      completion: 'none',
      terminationReason: null,
      contextVersion: 1,
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      effectiveConfig: {
        allowedOrigins: ['http://localhost:8080'],
        actionPolicy: 'non_submitting',
        budget: {
          maxCases: 8,
          maxPages: 6,
          maxDepth: 2,
          maxActiveSeconds: 600,
          maxActionsPerCase: 12,
          maxActions: 120,
          maxModelCalls: 100,
          maxReproductions: 3,
          concurrency: 2,
          maxTotalTokens: 300000,
        },
        environmentVersion: null,
        authProfileVersion: null,
        knowledgeVersionIds: [],
        models: {
          coordinator: { profileId: randomUUID(), version: 1 },
          explorer: { profileId: randomUUID(), version: 1 },
          executor: { profileId: randomUUID(), version: 1 },
          assertion: { profileId: randomUUID(), version: 1 },
          reproducer: { profileId: randomUUID(), version: 1 },
        },
      },
      budgetUsed: {
        activeSeconds: 10,
        actions: 2,
        modelCalls: 1,
        reproductions: 0,
        totalTokens: 50,
      },
    },
    summary: {
      planned: 2,
      passed: 1,
      issueFound: 0,
      blocked: 0,
      inconclusive: 0,
      notRun: 1,
      attempted: 1,
      evaluated: 1,
      passRate: 1,
      attemptRate: 0.5,
    },
    cases: [
      {
        definition: {
          id: randomUUID(),
          projectId: randomUUID(),
          runId: randomUUID(),
          version: 1,
          title: 'Case 1 - Entry',
          summary: 'Entry verification',
          preconditions: [],
          outline: ['Navigate http://localhost:8080'],
          criteria: [
            {
              id: 'c1',
              kind: 'http_status',
              description: 'HTTP 200',
              sourceKind: 'generic_smoke',
              sourceRef: 'smoke',
            },
          ],
        },
        outcome: 'passed',
        verdict: {
          id: randomUUID(),
          caseId: randomUUID(),
          attemptId: randomUUID(),
          status: 'passed',
          reasonCode: 'ALL_PASSED',
          criterionResults: [
            {
              criterionId: 'c1',
              result: 'passed',
              reason: 'OK',
              evidenceRefs: [],
            },
          ],
          version: 1,
        },
      },
    ],
    findings: [],
    reproductions: [],
    artifacts: [],
    modelUsage: [],
    coverageGaps: ['1 planned test case was not started'],
    cleanupStatus: 'pending',
    warnings: [],
  };

  const mdRunning = renderMarkdownReport(mockReport);
  // Must have snapshot banner
  assert.ok(mdRunning.includes('[SNAPSHOT / PARTIAL EXPORT]'));
  // Must NOT contain external CDN links
  assert.ok(
    !/https?:\/\/(?!localhost\b)[\w.-]+\/(?:css|js|cdn|static)/i.test(
      mdRunning,
    ),
  );

  // Change to terminal status completed
  const terminalReport = {
    ...mockReport,
    run: {
      ...mockReport.run,
      status: 'completed',
      completion: 'complete',
    },
  };
  const mdCompleted = renderMarkdownReport(terminalReport);
  assert.ok(!mdCompleted.includes('[SNAPSHOT / PARTIAL EXPORT]'));
});

test('Replay degradation: traces missing degrades to step events and screenshots', () => {
  const shotId = randomUUID();
  const artifacts = [
    {
      id: shotId,
      projectId: randomUUID(),
      runId: randomUUID(),
      kind: 'screenshot',
      status: 'available',
      bytes: 1024,
      sha256: 'a'.repeat(64),
      contentUrl: '/api/v1/...',
      redaction: 'not_needed',
      error: null,
      createdAt: new Date().toISOString(),
      taskId: null,
      stepId: null,
      caseId: null,
      snapshotId: null,
    },
  ];

  const steps = [
    {
      id: randomUUID(),
      runId: randomUUID(),
      taskId: randomUUID(),
      caseId: null,
      seq: 1,
      toolName: 'navigate',
      status: 'succeeded',
      summary: 'Navigated to entry URL',
      targetDescription: 'http://localhost:8080',
      evidenceRefs: [shotId],
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    },
  ];

  const assessment = assessReplayDegradation(artifacts, steps);
  assert.equal(assessment.mode, 'degraded');
  assert.equal(assessment.hasTrace, false);
  assert.equal(assessment.hasRrweb, false);
  assert.equal(assessment.timeline.length, 1);
  assert.equal(assessment.timeline[0].screenshotArtifactId, shotId);
  assert.ok(
    assessment.warnings.some((w) => w.includes('degraded to step events')),
  );
});

test('Reference validation: detects foreign or non-existent artifacts', async () => {
  const validArtifactId = randomUUID();
  const foreignArtifactId = randomUUID();
  const runId = randomUUID();
  const projectId = randomUUID();

  const createdAt = new Date().toISOString();
  const base = {
    projectId,
    runId,
    kind: 'screenshot',
    sha256: 'b'.repeat(64),
    contentUrl: null,
    createdAt,
    taskId: null,
    stepId: null,
    caseId: null,
    snapshotId: null,
  };
  const degradedId = randomUUID();
  const oversizedId = randomUUID();
  const redactionFailedId = randomUUID();
  const artifacts = [
    {
      ...base,
      id: validArtifactId,
      status: 'available',
      bytes: 100,
      redaction: 'not_needed',
      error: null,
    },
    {
      ...base,
      id: degradedId,
      status: 'degraded',
      bytes: 100,
      redaction: 'not_needed',
      error: null,
    },
    {
      ...base,
      id: oversizedId,
      status: 'available',
      bytes: 25 * 1024 * 1024 + 1,
      redaction: 'not_needed',
      error: null,
    },
    {
      ...base,
      id: redactionFailedId,
      status: 'available',
      bytes: 100,
      redaction: 'failed',
      error: null,
    },
  ];

  const verdicts = [
    {
      id: randomUUID(),
      caseId: randomUUID(),
      attemptId: randomUUID(),
      status: 'passed',
      reasonCode: 'ALL_PASSED',
      criterionResults: [
        {
          criterionId: 'c1',
          result: 'passed',
          reason: 'OK',
          evidenceRefs: [validArtifactId, foreignArtifactId],
        },
      ],
      version: 1,
    },
  ];

  const res = await validateEvidenceReferences(
    projectId,
    runId,
    artifacts,
    verdicts,
    [],
    [],
  );

  assert.equal(res.manifest.get(validArtifactId).status, 'available');
  assert.ok(res.manifest.get(validArtifactId).relativePath);
  const degraded = res.manifest.get(degradedId);
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.relativePath, null);
  const oversized = res.manifest.get(oversizedId);
  assert.equal(oversized.status, 'failed');
  assert.match(oversized.error, /25MiB/);
  assert.equal(oversized.relativePath, null);
  const redactionFailed = res.manifest.get(redactionFailedId);
  assert.equal(redactionFailed.status, 'failed');
  assert.match(redactionFailed.error, /redaction failed/);
  assert.equal(redactionFailed.relativePath, null);
  assert.equal(res.invalidReferences.length, 1);

  const failedCleanup = resolveCleanupStatus('completed', ['failed']);
  assert.equal(failedCleanup.status, 'failed');
  assert.notEqual(failedCleanup.status, 'succeeded');
  const unknownCleanup = resolveCleanupStatus('completed', ['unknown']);
  assert.equal(unknownCleanup.status, 'manual_required');
  assert.deepEqual(unknownCleanup.unrecognized, ['unknown']);
  assert.equal(resolveCleanupStatus('failed', []).status, 'not_required');
  assert.equal(resolveCleanupStatus('running', []).status, 'pending');
  assert.equal(
    resolveCleanupStatus('completed', ['succeeded']).status,
    'succeeded',
  );
  assert.equal(res.invalidReferences[0].refId, foreignArtifactId);
  assert.ok(res.warnings.some((w) => w.includes(foreignArtifactId)));
});
