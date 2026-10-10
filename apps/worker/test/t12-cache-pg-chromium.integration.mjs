import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import {
  AccountsRepository,
  Database,
  ModelRepository,
  ProjectRepository,
  SecretVault,
  hashPayload,
  migrate,
} from '@localqa/storage';
import { BrowserManager } from '@localqa/browser';
import {
  Coordinator,
  RuntimeClient,
  ArtifactStore,
} from '@localqa/orchestrator';
import { Worker, CandidateVerifier } from '../dist/index.js';

const docker = (args) => {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(
    result.status,
    0,
    `Docker operation ${args[0]} must succeed: ${String(result.stderr).slice(0, 320)}`,
  );
  return result.stdout.trim();
};

test(
  'PG18 + Worker + Chromium: approved replay cache persists across runs and invalidates changed DOM',
  { timeout: 115000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'localqa-t12-cache-'));
    const secret = randomBytes(24).toString('hex');
    const envFile = join(dir, 'postgres.env');
    writeFileSync(
      envFile,
      `POSTGRES_USER=localqa\nPOSTGRES_DB=localqa\nPOSTGRES_PASSWORD=${secret}\n`,
      { mode: 0o600 },
    );
    let container;
    let db;
    let browser;
    let fixture;
    let evidenceApi;
    try {
      let duplicate = false;
      fixture = createServer((_req, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end(
          '<!DOCTYPE html><html><body>' +
            '<button type="button" aria-label="Select product" onclick="document.getElementById(\'out\').textContent=\'Selected\'">Pick</button>' +
            (duplicate
              ? '<button aria-label="Select product">Other</button>'
              : '') +
            '<p id="out" data-testid="out">Ready</p></body></html>',
        );
      });
      fixture.listen(0, '127.0.0.1');
      await once(fixture, 'listening');
      const origin = `http://127.0.0.1:${fixture.address().port}`;
      container = docker([
        'run',
        '--detach',
        '--name',
        `localqa-t12-cache-${randomUUID().slice(0, 10)}`,
        '--publish',
        '127.0.0.1::5432',
        '--env-file',
        envFile,
        'postgres:18-alpine',
      ]);
      const port = docker(['port', container, '5432/tcp']).split(':').at(-1);
      const connection = `postgresql://localqa:${secret}@127.0.0.1:${port}/localqa`;
      const migrationsUrl = new URL(
        '../../../packages/storage/migrations/',
        import.meta.url,
      );
      const migrationPath = fileURLToPath(migrationsUrl);
      const legacyPath = join(dir, 'pre-t13-migrations');
      mkdirSync(legacyPath);
      for (const name of readdirSync(migrationPath)) {
        if (
          name.endsWith('.sql') &&
          !name.startsWith('019_') &&
          !name.startsWith('020_') &&
          !name.startsWith('021_') &&
          !name.startsWith('022_')
        )
          copyFileSync(join(migrationPath, name), join(legacyPath, name));
      }
      const legacyUrl = pathToFileURL(legacyPath + sep);
      let migrated = false;
      for (let i = 0; i < 70; i++) {
        try {
          await migrate(connection, legacyUrl);
          migrated = true;
          break;
        } catch {
          await delay(180);
        }
      }
      assert.equal(migrated, true, 'isolated database migrations');
      const vault = new SecretVault(1, new Map([[1, randomBytes(32)]]));
      db = new Database(connection);
      const owner = await new AccountsRepository(db).bootstrap({
        email: `cache-${randomUUID()}@localqa.test`,
        displayName: 'Cache integration owner',
        password: 'IntegrationTestOnlyPassword!',
      });
      const actor = { userId: owner.id };
      const project = await new ProjectRepository(db).create(actor, {
        name: 'T12 cache integration',
      });
      const model = await new ModelRepository(db, vault).create(actor, {
        name: 'unused-model',
        endpoint: 'https://unused.example.test/v1',
        configuredModelId: 'not-called',
        adapter: 'openai_compatible',
        dataBoundary: 'internal',
      });
      await new ModelRepository(db, vault).grant(actor, project.id, model.id);
      const caseId = randomUUID(),
        versionId = randomUUID();
      const document = {
        schemaVersion: 1,
        kind: 'localqa/test',
        id: 'cache-case',
        name: 'Real role replay',
        criteria: [
          {
            id: 'visible',
            kind: 'element_visible',
            description: 'Outcome visible',
            sourceKind: 'user_spec',
            sourceRef: 'cache-local-fixture',
            locator: { by: 'test_id', value: 'out' },
          },
        ],
        steps: [
          { kind: 'navigate', url: origin + '/product' },
          {
            kind: 'click',
            locator: { by: 'role', value: 'button', name: 'Select product' },
          },
          { kind: 'assert', criterionId: 'visible' },
        ],
      };
      const sha256 = hashPayload(document);
      await db.actor(actor, async (client) => {
        await client.query(
          "INSERT INTO saved_cases(id,project_id,slug,name,status,current_approved_version_id,version) VALUES($1,$2,'t12-cached','T12 cached case','active',NULL,1)",
          [caseId, project.id],
        );
        await client.query(
          "INSERT INTO saved_case_versions(id,case_id,project_id,version,document,sha256,review_status,created_by) VALUES($1,$2,$3,1,$4,$5,'draft',$6)",
          [versionId, caseId, project.id, document, sha256, owner.id],
        );
        await client.query(
          "UPDATE saved_case_versions SET review_status='approved',reviewed_by=$2,reviewed_at=clock_timestamp() WHERE id=$1",
          [versionId, owner.id],
        );
        await client.query(
          'UPDATE saved_cases SET current_approved_version_id=$2 WHERE id=$1',
          [caseId, versionId],
        );
      });
      const coordinator = new Coordinator({
        db,
        vault,
        serviceActor: actor,
        platformSlots: 2,
        projectSlots: 2,
      });
      browser = new BrowserManager();
      const runOnce = async (index) => {
        const runId = randomUUID();
        const bindings = Object.fromEntries(
          [
            'coordinator',
            'explorer',
            'executor',
            'assertion',
            'reproducer',
          ].map((name) => [
            name,
            { profileId: model.id, version: model.version },
          ]),
        );
        // The same approved immutable CaseDefinition enters via production
        // regression admission, without weakening the database snapshot guard.
        const { createRegressionPlan, compileRegression } =
          await import('@localqa/orchestrator');
        const { parseContract } = await import('@localqa/contracts');
        const { DEFAULT_LIMITS } = await import('@localqa/domain');
        compileRegression(document, {
          projectId: project.id,
          allowedOrigins: [origin],
          env: { BASE_URL: origin + '/product' },
          maxExpandedSteps: DEFAULT_LIMITS.maxActionsPerCase,
          resolveModule: () => undefined,
        });
        const binding = parseContract('RegressionBinding', {
          sourceVersionId: versionId,
          sourceDocumentSha256: sha256,
          snapshotDocumentSha256: sha256,
          document,
          moduleSnapshots: [],
        });
        const definition = parseContract('CaseDefinition', {
          id: randomUUID(),
          runId,
          projectId: project.id,
          version: 1,
          title: 'Real role replay',
          summary: 'Approved case',
          preconditions: ['approved source'],
          outline: document.steps.map((st) => st.kind),
          criteria: createRegressionPlan(binding, {
            projectId: project.id,
            allowedOrigins: [origin],
            env: { BASE_URL: origin + '/product' },
            maxExpandedSteps: DEFAULT_LIMITS.maxActionsPerCase,
          }).criteria,
          regression: binding,
        });
        const run = await coordinator.start(
          actor,
          { projectId: project.id, targetUrl: origin + '/product' },
          {
            allowedOrigins: [origin],
            actionPolicy: 'non_submitting',
            budget: DEFAULT_LIMITS,
            environmentVersion: null,
            authProfileVersion: null,
            knowledgeVersionIds: [],
            models: bindings,
          },
          randomUUID(),
          [definition],
        );
        assert.equal(run.id, runId);
        const runtime = new RuntimeClient(
          coordinator,
          {
            projectId: project.id,
            workerId: `t12-cache-worker-${index}-${randomUUID()}`,
          },
          new ArtifactStore(join(dir, 'artifacts')),
          {},
        );
        const worker = new Worker({
          runtime,
          browser,
          scratch: join(dir, `scratch-${index}`),
          heartbeatMs: 200,
          leaseSeconds: 45,
          pollMs: 100,
        });
        let terminal = false;
        for (let i = 0; i < 24; i++) {
          await coordinator.tick(project.id);
          await worker.once();
          const phase = await db.actor(
            actor,
            async (client) =>
              (
                await client.query(
                  'SELECT status,phase FROM runs WHERE id=$1',
                  [run.id],
                )
              ).rows[0],
          );
          if (
            phase.status === 'completed' ||
            phase.status === 'failed' ||
            phase.status === 'cancelled'
          ) {
            terminal = true;
            break;
          }
        }
        assert.equal(terminal, true, 'run must reach terminal status');
        const results = await db.actor(actor, async (client) => {
          const stats = (
            await client.query(
              'SELECT hits,misses,invalidated FROM run_locator_cache_stats WHERE run_id=$1',
              [run.id],
            )
          ).rows[0];
          const jobs = (
            await client.query(
              "SELECT document->>'summary' AS stage,status,result FROM jobs WHERE run_id=$1 ORDER BY id",
              [run.id],
            )
          ).rows;
          return { stats, jobs };
        });
        const replay = results.jobs.find((job) => job.stage === 'execute')
          ?.result?.regressionReplay;
        assert.equal(
          replay?.status,
          index === 3 ? 'failed' : 'completed',
          'real replay result must match expected fixture',
        );
        if (index === 3) assert.equal(replay?.reasonCode, 'LOCATOR_NOT_UNIQUE');
        return { ...results, runId: run.id };
      };
      const first = await runOnce(1);
      assert.ok(first.stats?.misses >= 1, 'first run must record cache miss');
      const second = await runOnce(2);
      assert.ok(
        second.stats?.hits >= 1,
        'second run must revalidate cached target',
      );
      duplicate = true;
      const third = await runOnce(3);
      assert.ok(
        third.stats?.invalidated >= 1,
        'changed DOM must invalidate cache',
      );
      console.log('T12 PG18 + Worker + Chromium: miss -> hit -> invalidated');

      // A candidate is NOT inserted into normal approved regression runs.
      // Seed a human-accepted repair proposal and isolated draft in the
      // owned ephemeral database, then use the actual CandidateVerifier lane.
      const proposalId = randomUUID();
      const candidateVersionId = randomUUID();
      const candidateDoc = {
        ...document,
        name: 'Independent candidate URL check',
        criteria: [
          {
            id: 'candidate-url',
            kind: 'url_matches',
            description: 'Exact candidate destination',
            sourceKind: 'user_spec',
            sourceRef: 'candidate-local-fixture',
            expectedValue: origin + '/product',
          },
        ],
        steps: [
          { kind: 'navigate', url: origin + '/product' },
          { kind: 'assert', criterionId: 'candidate-url' },
        ],
      };
      const candidateSha = hashPayload(candidateDoc);
      const verificationId = randomUUID();
      await db.actor(actor, async (client) => {
        let finding = (
          await client.query(
            'SELECT id FROM findings WHERE project_id=$1 AND run_id=$2 LIMIT 1',
            [project.id, third.runId],
          )
        ).rows[0]?.id;
        if (!finding) {
          const source = (
            await client.query(
              `SELECT c.id AS case_id,c.criteria_hash,a.id AS attempt_id
               FROM run_cases c JOIN case_attempts a ON a.case_id=c.id
               WHERE c.project_id=$1 AND c.run_id=$2 LIMIT 1`,
              [project.id, third.runId],
            )
          ).rows[0];
          assert.ok(source, 'failed replay must produce an attempt');
          finding = randomUUID();
          await client.query(
            `INSERT INTO findings(
               id,project_id,run_id,case_id,original_attempt_id,
               criteria_hash,fingerprint,kind,status,expected_source,document
             ) VALUES($1,$2,$3,$4,$5,$6,$7,'functional','suspected','user_spec',$8)`,
            [
              finding,
              project.id,
              third.runId,
              source.case_id,
              source.attempt_id,
              source.criteria_hash,
              hashPayload({ finding }),
              {
                id: finding,
                projectId: project.id,
                runId: third.runId,
                caseIds: [source.case_id],
                kind: 'functional',
                status: 'suspected',
                expectedSource: 'user_spec',
                version: 1,
                reproductionRef: null,
              },
            ],
          );
        }
        await client.query(
          `INSERT INTO repair_proposals(
             id,project_id,case_id,finding_id,proposed_version,diff
           ) VALUES($1,$2,$3,$4,2,$5)`,
          [
            proposalId,
            project.id,
            caseId,
            finding,
            'Candidate URL oracle instead of element check',
          ],
        );
        await client.query(
          `UPDATE repair_proposals SET status='approved',
             reviewed_by=$2,reviewed_at=clock_timestamp(),
             review_reason='Explicit human-reviewed test fixture approval'
           WHERE id=$1`,
          [proposalId, owner.id],
        );
        await client.query(
          `INSERT INTO saved_case_versions(
             id,case_id,project_id,version,document,sha256,review_status,created_by
           ) VALUES($1,$2,$3,2,$4,$5,'draft',$6)`,
          [
            candidateVersionId,
            caseId,
            project.id,
            candidateDoc,
            candidateSha,
            owner.id,
          ],
        );
        await client.query(
          `INSERT INTO repair_candidate_drafts(
             project_id,proposal_id,case_id,case_version_id
           ) VALUES($1,$2,$3,$4)`,
          [project.id, proposalId, caseId, candidateVersionId],
        );
      });
      await assert.rejects(
        db.actor(actor, async (client) =>
          client.query(
            `UPDATE saved_case_versions SET review_status='approved',
             reviewed_by=$2,reviewed_at=clock_timestamp() WHERE id=$1`,
            [candidateVersionId, owner.id],
          ),
        ),
        (error) => error.code === 'VALIDATION_ERROR',
        'a candidate without real independent validation cannot be approved',
      );
      const legacyResultId = randomUUID();
      await db.actor(actor, async (client) => {
        await client.query(
          `INSERT INTO repair_candidate_verifications(
             id,project_id,proposal_id,case_id,case_version_id,
             candidate_sha256,requested_by
           ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            legacyResultId,
            project.id,
            proposalId,
            caseId,
            candidateVersionId,
            candidateSha,
            owner.id,
          ],
        );
        // Simulate a legacy 018 record that a project owner could write.
        await client.query(
          `UPDATE repair_candidate_verifications SET
           status='completed',outcome='passed',
           started_at=clock_timestamp(),finished_at=clock_timestamp(),
           result='{"fullyVerified":true,"verifiedCriteria":1,"observedSteps":1,"observations":[{"passed":true}]}'::jsonb
           WHERE id=$1`,
          [legacyResultId],
        );
      });
      const prePrivacyPath = join(dir, 'pre-privacy-migrations');
      mkdirSync(prePrivacyPath);
      for (const name of readdirSync(migrationPath)) {
        if (name.endsWith('.sql') && !name.startsWith('022_'))
          copyFileSync(join(migrationPath, name), join(prePrivacyPath, name));
      }
      const upgraded = await migrate(
        connection,
        pathToFileURL(prePrivacyPath + sep),
      );
      assert.deepEqual(upgraded, [
        '019_candidate_verification_fencing.sql',
        '020_candidate_verification_evidence.sql',
        '021_candidate_evidence_retention.sql',
      ]);
      const legacyReceiptId = randomUUID();
      // A legacy 021 receipt can retain a sensitive page path. Run the
      // migration against that exact case, not only against empty tables.
      docker([
        'exec',
        container,
        'psql',
        '-U',
        'localqa',
        '-d',
        'localqa',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `INSERT INTO repair_candidate_evidence_receipts(
          id,project_id,verification_id,case_version_id,step_index,
          step_kind,criterion_id,criterion_passed,snapshot_id,snapshot_sha256,display_url,created_at
        ) VALUES(
          '${legacyReceiptId}','${project.id}','${legacyResultId}',
          '${candidateVersionId}',0,'assert','customer-john-private-account',true,'${randomUUID()}',
          '${hashPayload({ legacyReceiptId })}',
          'https://internal.example/orders/private-account?token=secret',
          clock_timestamp()
        )`,
      ]);
      assert.deepEqual(await migrate(connection, migrationsUrl), [
        '022_candidate_receipt_privacy.sql',
      ]);
      const scrubbed = await db.actor(
        actor,
        async (client) =>
          (
            await client.query(
              'SELECT display_url,criterion_id FROM repair_candidate_evidence_receipts WHERE id=$1',
              [legacyReceiptId],
            )
          ).rows[0],
      );
      assert.equal(
        scrubbed.display_url,
        '',
        '022 must erase existing sensitive URLs during upgrade',
      );
      assert.equal(
        scrubbed.criterion_id,
        null,
        '022 must erase user-defined criterion identifiers during upgrade',
      );
      const oldResult = await db.actor(
        actor,
        async (client) =>
          (
            await client.query(
              `SELECT outcome,result,legacy_result
           FROM repair_candidate_verifications WHERE id=$1`,
              [legacyResultId],
            )
          ).rows[0],
      );
      assert.equal(oldResult.outcome, 'inconclusive');
      assert.equal(oldResult.result.reasonCode, 'LEGACY_UNTRUSTED');
      assert.equal(oldResult.legacy_result.outcome, 'passed');
      await db.actor(actor, async (client) => {
        await client.query(
          `INSERT INTO repair_candidate_verifications(
             id,project_id,proposal_id,case_id,case_version_id,
             candidate_sha256,requested_by
           ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            verificationId,
            project.id,
            proposalId,
            caseId,
            candidateVersionId,
            candidateSha,
            owner.id,
          ],
        );
      });
      await assert.rejects(
        db.actor(actor, async (client) =>
          client.query(
            `UPDATE repair_candidate_verifications
             SET status='completed',outcome='passed',
               started_at=clock_timestamp(),finished_at=clock_timestamp(),
               result='{"fullyVerified":true,"observations":[{"passed":true}]}'::jsonb
             WHERE id=$1`,
            [verificationId],
          ),
        ),
        (error) => error.code === 'NOT_FOUND',
        'even the project owner cannot forge verification evidence',
      );
      await assert.rejects(
        db.worker(
          { projectId: project.id, workerId: 't13-rogue-worker' },
          async (client) =>
            client.query(
              `UPDATE repair_candidate_verifications SET
               status='completed',outcome='passed',
               started_at=clock_timestamp(),finished_at=clock_timestamp(),
               worker_id='t13-rogue-worker',fencing_token=1,
               result='{"fullyVerified":true,"observations":[{"passed":true}]}'::jsonb
               WHERE id=$1`,
              [verificationId],
            ),
        ),
        (error) => error.code === 'VALIDATION_ERROR',
        'a worker cannot skip a fenced claim',
      );
      const verifier = new CandidateVerifier(
        db,
        actor,
        browser,
        't13-candidate-integration-worker',
        vault,
      );
      assert.equal(await verifier.once(project.id), true);
      const verified = await db.actor(
        actor,
        async (client) =>
          (
            await client.query(
              `SELECT v.status,v.outcome,v.result,s.review_status
           FROM repair_candidate_verifications v
           JOIN saved_case_versions s ON s.project_id=v.project_id
             AND s.id=v.case_version_id WHERE v.id=$1`,
              [verificationId],
            )
          ).rows[0],
      );
      assert.equal(verified?.status, 'completed');
      assert.equal(
        verified?.outcome,
        'passed',
        'actual isolated Chromium candidate navigate + criterion evaluation',
      );
      assert.equal(verified.result.fullyVerified, true);
      assert.equal(verified.result.observations.length, 1);
      const durableEvidence = await db.actor(
        actor,
        async (client) =>
          (
            await client.query(
              `SELECT id,step_index,step_kind,criterion_id,criterion_passed,
                    snapshot_document,snapshot_sha256,screenshot_sha256,
                    screenshot_bytes,screenshot_ciphertext,screenshot_nonce,
                    screenshot_tag,screenshot_key_version
             FROM repair_candidate_evidence
             WHERE project_id=$1 AND verification_id=$2 ORDER BY step_index`,
              [project.id, verificationId],
            )
          ).rows,
      );
      assert.deepEqual(
        durableEvidence.map((e) => e.step_kind),
        ['navigate', 'assert'],
      );
      for (const e of durableEvidence)
        assert.equal(hashPayload(e.snapshot_document), e.snapshot_sha256);
      const screenshotEvidence = durableEvidence[1];
      assert.equal(screenshotEvidence.criterion_passed, true);
      assert.ok(screenshotEvidence.screenshot_bytes > 100);
      assert.equal(
        screenshotEvidence.screenshot_ciphertext
          .subarray(0, 8)
          .equals(Buffer.from('89504e470d0a1a0a', 'hex')),
        false,
        'PNG bytes must be encrypted at rest',
      );
      const screenshotBytes = Buffer.from(
        vault.decrypt(
          {
            ciphertext: screenshotEvidence.screenshot_ciphertext,
            nonce: screenshotEvidence.screenshot_nonce,
            authTag: screenshotEvidence.screenshot_tag,
            keyVersion: screenshotEvidence.screenshot_key_version,
          },
          {
            projectId: project.id,
            secretId: screenshotEvidence.id,
            purpose: 'candidate_screenshot',
          },
        ),
        'base64',
      );
      assert.equal(screenshotBytes.length, screenshotEvidence.screenshot_bytes);
      assert.equal(
        createHash('sha256').update(screenshotBytes).digest('hex'),
        screenshotEvidence.screenshot_sha256,
      );
      assert.ok(
        screenshotBytes
          .subarray(0, 8)
          .equals(Buffer.from('89504e470d0a1a0a', 'hex')),
      );
      const { createRouter, createRequestHandler } =
        await import('../../../apps/api/dist/app.js');
      const accountsRepo = new AccountsRepository(db);
      const login = await accountsRepo.login({
        email: owner.email,
        password: 'IntegrationTestOnlyPassword!',
      });
      evidenceApi = createServer(
        createRequestHandler(
          {
            db,
            vault,
            accountsRepo,
          },
          createRouter(),
        ),
      );
      evidenceApi.listen(0, '127.0.0.1');
      await once(evidenceApi, 'listening');
      const evidenceRoot = `http://127.0.0.1:${evidenceApi.address().port}/api/v1/saved-cases/${caseId}/repair-proposals/${proposalId}/verifications/${verificationId}/evidence`;
      const denied = await fetch(evidenceRoot);
      assert.equal(denied.status, 401, 'unauthenticated evidence read denied');
      const authenticated = { Cookie: `session=${login.token}` };
      const evidenceResponse = await fetch(evidenceRoot, {
        headers: authenticated,
      });
      assert.equal(evidenceResponse.status, 200);
      const evidencePage = await evidenceResponse.json();
      assert.equal(evidencePage.items.length, 2);
      assert.equal(
        evidencePage.items[1].screenshotSha256,
        screenshotEvidence.screenshot_sha256,
      );
      const screenshotResponse = await fetch(
        evidenceRoot + `/${screenshotEvidence.id}/screenshot`,
        { headers: authenticated },
      );
      assert.equal(screenshotResponse.status, 200);
      assert.ok(
        screenshotResponse.headers.get('content-type')?.startsWith('image/png'),
      );
      assert.equal(
        screenshotResponse.headers.get('cache-control'),
        'private, no-store',
      );
      assert.deepEqual(
        Buffer.from(await screenshotResponse.arrayBuffer()),
        screenshotBytes,
      );
      assert.equal(
        verified.review_status,
        'draft',
        'independent verification must never automatically approve a baseline',
      );
      await assert.rejects(
        db.actor(actor, async (client) =>
          client.query(
            `UPDATE repair_candidate_verifications
             SET outcome='failed' WHERE id=$1`,
            [verificationId],
          ),
        ),
        (error) => error.code === 'NOT_FOUND',
        'completed verification evidence is immutable to application actors',
      );
      await assert.rejects(
        db.actor(actor, async (client) =>
          client.query('DELETE FROM repair_candidate_evidence WHERE id=$1', [
            screenshotEvidence.id,
          ]),
        ),
        (error) => error.code === 'NOT_FOUND',
        'owners cannot delete screenshot evidence',
      );
      await assert.rejects(
        db.actor(actor, async (client) =>
          client.query('SELECT prune_candidate_evidence($1,100)', [project.id]),
        ),
        (error) => error.code === 'NOT_FOUND',
        'ordinary project owners cannot invoke evidence deletion',
      );
      const maintenanceVerifier = new CandidateVerifier(
        db,
        actor,
        browser,
        't13-retention-worker',
        vault,
      );
      assert.equal(
        await maintenanceVerifier.pruneExpiredEvidence(project.id),
        0,
        'fresh evidence must not be pruned',
      );
      // Only the ephemeral test DB superuser can age an immutable verification.
      docker([
        'exec',
        container,
        'psql',
        '-U',
        'localqa',
        '-d',
        'localqa',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `BEGIN;
         ALTER TABLE repair_candidate_verifications
           DISABLE TRIGGER candidate_verification_transition;
         UPDATE repair_candidate_verifications
           SET finished_at=clock_timestamp()-interval '91 days'
           WHERE id='${verificationId}';
         ALTER TABLE repair_candidate_verifications
           ENABLE TRIGGER candidate_verification_transition;
         COMMIT;`,
      ]);
      assert.equal(
        await maintenanceVerifier.pruneExpiredEvidence(project.id),
        2,
        'retention prunes two eligible raw evidence rows',
      );
      assert.equal(
        await maintenanceVerifier.pruneExpiredEvidence(project.id),
        0,
        'repeated maintenance is idempotent',
      );
      const retained = await db.actor(
        actor,
        async (client) =>
          (
            await client.query(
              `SELECT id,snapshot_sha256,screenshot_sha256,display_url
           FROM repair_candidate_evidence_receipts
           WHERE project_id=$1 AND verification_id=$2 ORDER BY step_index`,
              [project.id, verificationId],
            )
          ).rows,
      );
      assert.equal(retained.length, 2);
      assert.ok(
        retained.every((e) => e.display_url === ''),
        '90-day audit receipts cannot retain page URLs or path identifiers',
      );
      assert.equal(
        retained[1].screenshot_sha256,
        screenshotEvidence.screenshot_sha256,
      );
      assert.equal(
        (await fetch(evidenceRoot, { headers: authenticated })).status,
        200,
      );
      const prunedPage = await (
        await fetch(evidenceRoot, { headers: authenticated })
      ).json();
      assert.deepEqual(
        prunedPage.items.map((e) => e.retention),
        ['purged', 'purged'],
      );
      assert.ok(
        prunedPage.items.every((e) => e.displayUrl === ''),
        'expired evidence API must not expose historical page addresses',
      );
      assert.equal(
        prunedPage.items[1].screenshotSha256,
        screenshotEvidence.screenshot_sha256,
      );
      assert.equal(
        (
          await fetch(evidenceRoot + `/${screenshotEvidence.id}/screenshot`, {
            headers: authenticated,
          })
        ).status,
        404,
        'expired screenshot bytes must no longer be retrievable',
      );
      await assert.rejects(
        db.actor(actor, async (client) =>
          client.query(
            `UPDATE saved_case_versions SET review_status='approved',
           reviewed_by=$2,reviewed_at=clock_timestamp() WHERE id=$1`,
            [candidateVersionId, owner.id],
          ),
        ),
        (error) => error.code === 'VALIDATION_ERROR',
        'expired evidence cannot authorize a late draft approval',
      );
      // Kill the *real* PostgreSQL backend just as an independently verified
      // Chromium candidate tries to persist its result. An uncertain COMMIT
      // must not publish a pass or replay browser actions automatically.
      const connectionLostId = randomUUID();
      await db.actor(actor, async (client) =>
        client.query(
          `INSERT INTO repair_candidate_verifications(
           id,project_id,proposal_id,case_id,case_version_id,
           candidate_sha256,requested_by
         ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            connectionLostId,
            project.id,
            proposalId,
            caseId,
            candidateVersionId,
            candidateSha,
            owner.id,
          ],
        ),
      );
      const regularWorker = db.worker.bind(db);
      let scopedCalls = 0;
      db.worker = (scope, callback) => {
        if (scope.workerId !== 't13-disconnected-worker')
          return regularWorker(scope, callback);
        scopedCalls++;
        if (scopedCalls !== 2) return regularWorker(scope, callback);
        return regularWorker(scope, async (client) => {
          const backend = (await client.query('SELECT pg_backend_pid() AS pid'))
            .rows[0].pid;
          docker([
            'exec',
            container,
            'psql',
            '-U',
            'localqa',
            '-d',
            'localqa',
            '-v',
            'ON_ERROR_STOP=1',
            '-c',
            `SELECT pg_terminate_backend(${Number(backend)})`,
          ]);
          return callback(client);
        });
      };
      try {
        const disconnected = new CandidateVerifier(
          db,
          actor,
          browser,
          't13-disconnected-worker',
          vault,
        );
        await assert.rejects(
          disconnected.once(project.id),
          (error) => error.code === 'SERVICE_UNAVAILABLE',
          'real backend termination must have a stable, redacted error',
        );
      } finally {
        db.worker = regularWorker;
      }
      assert.equal(scopedCalls, 2, 'failure must occur after Chromium replay');
      const uncommitted = await db.actor(
        actor,
        async (client) =>
          (
            await client.query(
              `SELECT status,outcome FROM repair_candidate_verifications
           WHERE id=$1`,
              [connectionLostId],
            )
          ).rows[0],
      );
      assert.equal(uncommitted.status, 'running');
      assert.equal(uncommitted.outcome, null);
      assert.equal(
        (
          await db.actor(
            actor,
            async (client) =>
              (
                await client.query(
                  'SELECT count(*)::integer AS n FROM repair_candidate_evidence WHERE verification_id=$1',
                  [connectionLostId],
                )
              ).rows[0],
          )
        ).n,
        0,
        'failed final transaction must roll back evidence',
      );
      docker([
        'exec',
        container,
        'psql',
        '-U',
        'localqa',
        '-d',
        'localqa',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `BEGIN;
         ALTER TABLE repair_candidate_verifications
           DISABLE TRIGGER candidate_verification_transition;
         UPDATE repair_candidate_verifications
           SET lease_until=clock_timestamp()-interval '1 second'
           WHERE id='${connectionLostId}';
         ALTER TABLE repair_candidate_verifications
           ENABLE TRIGGER candidate_verification_transition;
         COMMIT;`,
      ]);
      assert.equal(await maintenanceVerifier.once(project.id), false);
      const disconnectedResult = await db.actor(
        actor,
        async (client) =>
          (
            await client.query(
              'SELECT status,outcome,result FROM repair_candidate_verifications WHERE id=$1',
              [connectionLostId],
            )
          ).rows[0],
      );
      assert.equal(disconnectedResult.status, 'completed');
      assert.equal(disconnectedResult.outcome, 'inconclusive');
      assert.equal(
        disconnectedResult.result.reasonCode,
        'VERIFIER_INTERRUPTED',
      );
      const fencedId = randomUUID();
      await db.actor(actor, async (client) => {
        await client.query(
          `INSERT INTO repair_candidate_verifications(
             id,project_id,proposal_id,case_id,case_version_id,
             candidate_sha256,requested_by
           ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            fencedId,
            project.id,
            proposalId,
            caseId,
            candidateVersionId,
            candidateSha,
            owner.id,
          ],
        );
      });
      const fencedWorker = {
        projectId: project.id,
        workerId: 't13-fenced-worker',
      };
      const claimed = await db.worker(
        fencedWorker,
        async (client) =>
          (
            await client.query(
              `UPDATE repair_candidate_verifications SET
           status='running',worker_id=$2,fencing_token=fencing_token+1,
           started_at=clock_timestamp(),
           lease_until=clock_timestamp()+interval '90 seconds'
           WHERE id=$1 AND status='queued'
           RETURNING fencing_token`,
              [fencedId, fencedWorker.workerId],
            )
          ).rows[0],
      );
      assert.equal(Number(claimed.fencing_token), 1);
      await assert.rejects(
        db.worker(
          { projectId: project.id, workerId: 't13-other-worker' },
          async (client) =>
            client.query(
              `UPDATE repair_candidate_verifications SET
             status='completed',outcome='passed',finished_at=clock_timestamp(),
             lease_until=NULL,
             result='{"fullyVerified":true,"verifiedCriteria":1,"observedSteps":1,"observations":[{"passed":true}]}'::jsonb
             WHERE id=$1`,
              [fencedId],
            ),
        ),
        (error) => error.code === 'VALIDATION_ERROR',
        'another worker cannot conclude a foreign lease',
      );
      const stale = await db.worker(fencedWorker, async (client) =>
        client.query(
          `UPDATE repair_candidate_verifications SET
           status='completed',outcome='passed',finished_at=clock_timestamp(),
           lease_until=NULL,
           result='{"fullyVerified":true,"verifiedCriteria":1,"observedSteps":1,"observations":[{"passed":true}]}'::jsonb
           WHERE id=$1 AND fencing_token=0`,
          [fencedId],
        ),
      );
      assert.equal(stale.rowCount, 0, 'stale fencing token cannot update');
      await assert.rejects(
        db.worker(fencedWorker, async (client) =>
          client.query(
            `UPDATE repair_candidate_verifications SET
             status='completed',outcome='passed',finished_at=clock_timestamp(),
             lease_until=NULL,
             result='{"fullyVerified":true,"verifiedCriteria":1,"observedSteps":1,"observations":[{"stepIndex":0,"passed":true}]}'::jsonb
           WHERE id=$1 AND fencing_token=1`,
            [fencedId],
          ),
        ),
        (error) => error.code === 'VALIDATION_ERROR',
        'even a current Worker cannot publish pass without matching screenshot-backed evidence',
      );
      await db.worker(fencedWorker, async (client) =>
        client.query(
          `UPDATE repair_candidate_verifications SET
           status='completed',outcome='inconclusive',finished_at=clock_timestamp(),
           lease_until=NULL,
           result='{"fullyVerified":false,"reasonCode":"VERIFICATION_CANCELLED","observations":[]}'::jsonb
           WHERE id=$1 AND fencing_token=1`,
          [fencedId],
        ),
      );
      // Simulate a process disappearing after lease claim. No replay of
      // potentially side-effecting steps is permitted on recovery.
      const interruptedId = randomUUID();
      await db.actor(actor, async (client) =>
        client.query(
          `INSERT INTO repair_candidate_verifications(
           id,project_id,proposal_id,case_id,case_version_id,
           candidate_sha256,requested_by
         ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            interruptedId,
            project.id,
            proposalId,
            caseId,
            candidateVersionId,
            candidateSha,
            owner.id,
          ],
        ),
      );
      const disappeared = {
        projectId: project.id,
        workerId: 't13-disappeared-worker',
      };
      await db.worker(disappeared, async (client) =>
        client.query(
          `UPDATE repair_candidate_verifications SET
         status='running',worker_id=$2,fencing_token=1,
         started_at=clock_timestamp(),
         lease_until=clock_timestamp()+interval '90 seconds'
         WHERE id=$1 AND status='queued'`,
          [interruptedId, disappeared.workerId],
        ),
      );
      // Only the isolated test DB superuser may fast-forward the lease clock.
      docker([
        'exec',
        container,
        'psql',
        '-U',
        'localqa',
        '-d',
        'localqa',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `BEGIN;
         ALTER TABLE repair_candidate_verifications
           DISABLE TRIGGER candidate_verification_transition;
         UPDATE repair_candidate_verifications
           SET lease_until=clock_timestamp()-interval '1 second'
           WHERE id='${interruptedId}';
         ALTER TABLE repair_candidate_verifications
           ENABLE TRIGGER candidate_verification_transition;
         COMMIT;`,
      ]);
      assert.equal(await verifier.once(project.id), false);
      const recovered = await db.actor(
        actor,
        async (client) =>
          (
            await client.query(
              `SELECT status,outcome,result,worker_id,fencing_token
           FROM repair_candidate_verifications WHERE id=$1`,
              [interruptedId],
            )
          ).rows[0],
      );
      assert.equal(recovered.status, 'completed');
      assert.equal(recovered.outcome, 'inconclusive');
      assert.equal(recovered.result.reasonCode, 'VERIFIER_INTERRUPTED');
      assert.equal(Number(recovered.fencing_token), 2);
      assert.equal(recovered.worker_id, 't13-candidate-integration-worker');
      assert.equal(
        await verifier.once(project.id),
        false,
        'interrupted task must not be replayed on the next poll',
      );
      // A graceful signal during real Chromium session setup must abort the
      // candidate before browser actions and publish an inconclusive verdict.
      const cancelledId = randomUUID();
      await db.actor(actor, async (client) =>
        client.query(
          `INSERT INTO repair_candidate_verifications(
             id,project_id,proposal_id,case_id,case_version_id,
             candidate_sha256,requested_by
           ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            cancelledId,
            project.id,
            proposalId,
            caseId,
            candidateVersionId,
            candidateSha,
            owner.id,
          ],
        ),
      );
      const cancelVerifier = new CandidateVerifier(
        db,
        actor,
        browser,
        't13-graceful-shutdown-worker',
        vault,
      );
      const createSession = browser.createSession.bind(browser);
      browser.createSession = async (...args) => {
        const session = await createSession(...args);
        cancelVerifier.cancelActive();
        return session;
      };
      try {
        assert.equal(await cancelVerifier.once(project.id), true);
      } finally {
        browser.createSession = createSession;
      }
      const cancelled = await db.actor(
        actor,
        async (client) =>
          (
            await client.query(
              `SELECT status,outcome,result
           FROM repair_candidate_verifications WHERE id=$1`,
              [cancelledId],
            )
          ).rows[0],
      );
      assert.equal(cancelled.status, 'completed');
      assert.equal(cancelled.outcome, 'inconclusive');
      assert.equal(cancelled.result.reasonCode, 'WORKER_SHUTDOWN');
      assert.equal(cancelled.result.fullyVerified, false);
      assert.equal(
        await cancelVerifier.once(project.id),
        false,
        'shutdown Worker must not claim another candidate',
      );
      console.log(
        'T13 candidate: forgery rejected, privacy receipt minimized, expired lease and SIGTERM both inconclusive',
      );
    } finally {
      if (evidenceApi)
        await new Promise((resolve) => evidenceApi.close(resolve));
      await browser?.close();
      await db?.close();
      if (fixture) await new Promise((resolve) => fixture.close(resolve));
      if (container) docker(['rm', '--force', '--volumes', container]);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
