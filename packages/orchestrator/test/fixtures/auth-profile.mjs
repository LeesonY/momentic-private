import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseContract } from '@localqa/contracts';
import { hashPayload } from '@localqa/storage';
import { sessionFixture } from './session.mjs';

/** SQL-aware unit fixture; no PostgreSQL, RLS or browser is simulated. */
export function authProfileFixture({
  managed = true,
  executionMode = 'smoke',
  realTx = false,
} = {}) {
  const fixture = sessionFixture({ executionMode }, { realTx });
  const { run, coordinator, state } = fixture;
  run.effectiveConfig.authProfileVersion = 1;
  const profileId = randomUUID();
  const profile = parseContract('AuthProfile', {
    id: profileId,
    projectId: run.projectId,
    environmentId: null,
    name: 'Test account',
    mode: 'form',
    allowedOrigins: run.effectiveConfig.allowedOrigins,
    sharingPolicy: 'shared_state',
    hasSecret: true,
    version: 1,
    status: 'active',
    formConfig: { detectionMode: 'ai', loginUrl: 'https://fixture.test/login' },
  });
  const auth = {
    profileId,
    head: 1,
    revoked: false,
    deleted: false,
    versions: new Map([
      [1, { document: profile, secret_id: randomUUID(), secret_version: 1 }],
    ]),
    sessions: new Map(),
    snapshots: new Map(),
    lastSnapshot: null,
    /** When set, the ledger's last-action snapshot (the cited one otherwise). */
    latestSnapshot: null,
    /** secret_id values whose ciphertext row is unavailable. */
    missingSecrets: new Set(),
    intents: new Map(),
    scope: null,
    seq: 0,
    queries: [],
    events: [],
    leaseUntil: new Date(Date.now() + 60000),
    gate: true,
    heldSessionId: null,
  };
  const scope = { projectId: run.projectId, workerId: 'fixture-worker' };
  let task;
  let proof;
  const bindTask = (current) => {
    task = current;
    task.result.authContextId ??= randomUUID();
    proof = {
      taskId: task.id,
      fencingToken: Number(task.fencing_token),
      contextVersion: run.contextVersion,
      leaseToken: 'fixture',
    };
    return proof;
  };
  const selectTask = (role = 'executor', stage = 'execute') => {
    const record = fixture.addCase('not_run');
    task = fixture.addJob(record.definition.id, {
      role,
      stage,
      status: 'running',
    });
    bindTask(task);
    return { task, proof, record };
  };
  selectTask();
  coordinator.validateLease = async () => ({ run, job: task });
  if (!managed) coordinator.sessions.read = async () => null;
  coordinator.reserve = async () => ({ id: randomUUID() });
  coordinator.authImportService.endTask = async () => null;
  coordinator.sessions.advance = async () => true;
  coordinator.vault = {
    decrypt: ({ ciphertext }) => ciphertext.toString('utf8'),
  };
  const rows = (items = []) => ({ rows: items, rowCount: items.length });
  const versionFor = (
    self,
    taskId = proof.taskId,
    fence = 1,
    context = run.contextVersion,
  ) => {
    const pinned = [...auth.sessions.values()].find(
      (s) =>
        s.task_id === taskId &&
        s.fencing_token === String(fence) &&
        s.context_version === context,
    );
    return self ? (pinned?.auth_profile_version ?? auth.head) : 1;
  };
  const head = () => auth.versions.get(auth.head).document;
  const query = fixture.client.query.bind(fixture.client);
  fixture.client.query = async (sql, params = []) => {
    auth.queries.push({ sql, params });
    if (sql.includes('v.version AS selected_version')) {
      assert.deepEqual(params.slice(0, 2), [run.projectId, run.id]);
      assert.match(sql, /h.version=p.version/);
      assert.match(sql, /ELSE r.auth_profile_version END/);
      assert.match(sql, /p.deleted_at IS NULL/);
      const version = versionFor(params[2], params[3], params[4], params[5]);
      return rows([
        {
          auth_profile_id: auth.profileId,
          auth_profile_version: 1,
          environment_id: null,
          revoked: auth.deleted ? null : auth.revoked,
          current_status: auth.deleted ? null : head().status,
          selected_version: version,
          document: auth.versions.get(version)?.document,
        },
      ]);
    }
    if (
      sql.includes('FROM run_auth_scopes') &&
      !sql.includes('LEFT JOIN run_auth_scopes')
    )
      return rows(auth.scope ? [auth.scope] : []);
    if (sql.includes('INSERT INTO run_auth_scopes')) {
      auth.scope = {
        auth_epoch: 1,
        status: 'initializing',
        context_version: params[4],
        auth_profile_id: params[2],
        auth_profile_version: params[3],
        current_state_id: null,
      };
      return rows([auth.scope]);
    }
    if (sql.includes('INSERT INTO auth_execution_sessions')) {
      const s = {
        id: params[0],
        project_id: params[1],
        run_id: params[2],
        task_id: params[3],
        worker_id: params[4],
        fencing_token: String(params[5]),
        context_version: params[6],
        context_id: params[7],
        auth_profile_id: params[8],
        auth_profile_version: params[9],
        auth_epoch: params[10],
        purpose: 'initializer',
        status: 'allocated',
        expires_at: params[11],
      };
      auth.sessions.set(s.id, s);
      return rows([s]);
    }
    if (
      sql.includes('FROM auth_execution_sessions') &&
      !sql.includes('FROM runs r')
    ) {
      let sessions = [...auth.sessions.values()];
      if (sql.includes('WHERE task_id = $1'))
        sessions = sessions.filter(
          (s) =>
            s.task_id === params[0] && s.fencing_token === String(params[1]),
        );
      else if (sql.includes('WHERE id = $1') || sql.includes('WHERE id=$1'))
        sessions = sessions.filter((s) => s.id === params[0]);
      if (sql.includes('SELECT id FROM'))
        sessions = sessions.filter((s) => s.expires_at > new Date());
      return rows(sessions);
    }
    if (sql.includes('SELECT p.id,p.revoked,p.version')) {
      auth.onProfileLock?.();
      return rows(
        auth.deleted
          ? []
          : [
              {
                id: profileId,
                revoked: auth.revoked,
                version: auth.head,
                status: head().status,
              },
            ],
      );
    }
    if (
      sql.includes("h.document->>'status' AS current_status") &&
      sql.includes('SELECT p.id,p.revoked')
    ) {
      const version = params[2] ? params[3] : 1;
      return rows(
        auth.deleted
          ? []
          : [
              {
                id: profileId,
                revoked: auth.revoked,
                current_status: head().status,
                sharing_policy:
                  auth.versions.get(version)?.document.sharingPolicy,
                selected_status: auth.versions.get(version)?.document.status,
              },
            ],
      );
    }
    if (sql.includes('SELECT l.lease_until,s.expires_at'))
      return rows([
        {
          lease_until: auth.leaseUntil,
          expires_at: auth.leaseUntil,
          now: new Date(),
        },
      ]);
    if (sql.includes('SELECT l.lease_until'))
      return rows([{ lease_until: auth.leaseUntil }]);
    if (sql.includes('SELECT event_seq FROM runs'))
      return rows([{ event_seq: String(auth.seq) }]);
    if (sql.includes('INSERT INTO run_events')) {
      assert.equal(params[2], ++auth.seq);
      auth.events.push({ type: params[3], payload: params[4] });
      state.events.push({ type: params[3], payload: params[4] });
      return rows();
    }
    if (
      sql.includes(
        'SELECT r.auth_profile_id, v.version AS auth_profile_version',
      )
    ) {
      const s = auth.sessions.get(params[3]);
      assert.match(sql, /ELSE r.auth_profile_version END/);
      const version = params[2] ? s?.auth_profile_version : 1;
      return rows(
        version
          ? [
              {
                auth_profile_id: profileId,
                auth_profile_version: version,
                document: auth.versions.get(version).document,
              },
            ]
          : [],
      );
    }
    if (sql.includes('SELECT auth_profile_id,auth_profile_version FROM runs'))
      return rows([{ auth_profile_id: profileId, auth_profile_version: 1 }]);
    if (
      sql.includes('SELECT v.document,v.secret_id,v.secret_version,p.revoked')
    ) {
      assert.match(sql, /v.version=\$3/);
      return rows(
        auth.deleted
          ? []
          : [
              {
                ...auth.versions.get(params[2]),
                revoked: auth.revoked,
                current_status: head().status,
              },
            ],
      );
    }
    if (
      sql.includes(
        'SELECT v.ciphertext,v.nonce,v.auth_tag,v.key_version,s.purpose',
      )
    ) {
      if (auth.missingSecrets.has(params[1])) return rows([]);
      const version = [...auth.versions.values()].find(
        (v) => v.secret_id === params[1] && v.secret_version === params[2],
      );
      return rows(
        version
          ? [
              {
                ciphertext: Buffer.from(
                  JSON.stringify(
                    version.material ?? {
                      username: 'old-user',
                      password: 'old-password',
                    },
                  ),
                ),
                purpose: 'auth',
              },
            ]
          : [],
      );
    }

    if (sql.includes('INSERT INTO action_intents')) {
      auth.intents.set(params[0], {
        id: params[0],
        auth_session_id: params[8],
        auth_epoch: params[9],
        fencing_token: String(params[4]),
        context_version: params[5],
        execution_state: 'issued',
      });
      return rows();
    }

    if (sql.includes('SELECT id, auth_session_id, auth_epoch'))
      return rows(
        auth.intents.has(params[0]) ? [auth.intents.get(params[0])] : [],
      );
    if (
      sql.includes('UPDATE action_intents') &&
      sql.includes("execution_state = 'started'")
    )
      return rows([{ started_at: new Date() }]);
    if (
      sql.includes('FROM auth_action_requests') ||
      sql.includes('INSERT INTO auth_action_requests') ||
      sql.includes('INSERT INTO steps')
    )
      return rows();
    if (sql.includes('SELECT count(*)::integer n FROM action_intents'))
      return rows([{ n: 0 }]);
    if (sql.includes('SELECT COALESCE(max(seq)')) return rows([{ n: 1 }]);
    if (sql.includes('AS frozen_version')) {
      const pinned = [...auth.sessions.values()].find(
        (s) =>
          s.task_id === task.id &&
          s.fencing_token === String(proof.fencingToken) &&
          s.context_version === run.contextVersion,
      );
      return rows([
        {
          auth_profile_id: auth.deleted ? null : profileId,
          frozen_version: 1,
          current_version: auth.deleted ? null : auth.head,
          task_version: pinned?.auth_profile_version ?? null,
        },
      ]);
    }
    if (
      sql.includes(
        'SELECT version,secret_id,secret_version FROM auth_profile_versions',
      )
    ) {
      const versions = Array.isArray(params[2]) ? params[2] : [];
      return rows(
        versions
          .filter((version) => auth.versions.has(version))
          .map((version) => ({
            version,
            ...auth.versions.get(version),
          })),
      );
    }
    if (sql.includes('SELECT document FROM page_snapshots')) {
      const snapshot = auth.snapshots.get(params[3]) ?? null;
      auth.lastSnapshot = snapshot;
      return rows(snapshot ? [{ document: snapshot }] : []);
    }
    if (sql.includes('FROM action_intents i JOIN steps s')) {
      // The last granted action's snapshot must be the one the caller now
      // cites, exactly as the real action ledger enforces it. A test may pin
      // `latestSnapshot` to simulate an action that already advanced it.
      const latest = auth.latestSnapshot ?? auth.lastSnapshot;
      return rows(
        latest
          ? [
              {
                result_hash: hashPayload({
                  status: 'succeeded',
                  snapshot: latest,
                  evidence: [],
                }),
              },
            ]
          : [],
      );
    }
    if (sql.includes('SELECT p.revoked,v.document,h.document')) {
      const version = versionFor(params[2]);
      return rows(
        auth.deleted
          ? []
          : [
              {
                revoked: auth.revoked,
                document: auth.versions.get(version).document,
                current_status: head().status,
                scope_status: auth.scope?.status,
                scope_context_version: auth.scope?.context_version,
                scope_auth_epoch: auth.scope?.auth_epoch,
                current_state_id: auth.scope?.current_state_id,
                scope_profile_version: auth.scope?.auth_profile_version,
              },
            ],
      );
    }
    if (sql.includes('FROM auth_success_gates g')) {
      const s = [...auth.sessions.values()].find((s) => s.task_id === task.id);
      return rows(
        auth.gate &&
          s?.status === 'ended' &&
          s.end_reason === 'signed_in' &&
          s.context_id === params[4] &&
          s.auth_profile_id === params[5] &&
          s.auth_profile_version === params[6] &&
          s.auth_epoch === params[7]
          ? [{}]
          : [],
      );
    }
    if (sql.includes('SELECT id FROM run_cases WHERE id=$1 FOR UPDATE'))
      return rows([{ id: params[0] }]);
    if (sql.includes('SELECT id,context_id FROM case_attempts'))
      return rows([
        { id: randomUUID(), context_id: task.result.authContextId },
      ]);
    if (sql.includes("'{authContextId}'")) {
      task.result.authContextId = params[2];
      return rows();
    }
    if (sql.includes('SELECT v.*,s.purpose FROM runs r JOIN secret_versions'))
      return rows();
    if (sql.includes('SELECT document FROM run_cases WHERE id='))
      return rows([{ document: state.cases.get(params[0]) }]);
    if (sql.includes('auth_profile_run_locks')) {
      if (sql.includes('SELECT l.id,l.run_id')) return rows();
      if (sql.includes('INSERT INTO auth_profile_run_locks')) {
        auth.heldSessionId = params[4];
        return rows();
      }
      if (sql.includes('SELECT auth_session_id'))
        return rows(
          auth.heldSessionId ? [{ auth_session_id: auth.heldSessionId }] : [],
        );
      if (sql.includes('SELECT 1'))
        return rows(auth.heldSessionId === params[3] ? [{}] : []);
    }
    if (sql.includes('SELECT j.* FROM jobs j JOIN task_leases'))
      return rows([task]);
    if (sql.includes('SELECT * FROM case_attempts WHERE task_id='))
      return rows([{ id: randomUUID() }]);
    if (sql.includes('INSERT INTO verdicts')) {
      const definition = state.cases.get(task.case_id);
      fixture.addAttempt(definition, { job: task, outcome: null }).verdict =
        parseContract('Verdict', params[4]);
      return rows();
    }
    if (sql.includes("UPDATE jobs SET status='succeeded'")) {
      Object.assign(task, { status: 'succeeded', result: params[1] });
      return rows();
    }
    if (
      sql.includes('UPDATE case_attempts SET status=') ||
      sql.includes('SELECT 1 FROM action_intents') ||
      sql.includes('SELECT id FROM artifacts') ||
      sql.includes('UPDATE auth_execution_sessions') ||
      sql.includes('UPDATE auth_profile_run_locks')
    )
      return rows();
    return query(sql, params);
  };
  return {
    ...fixture,
    auth,
    scope,
    selectTask,
    bindTask,
    get task() {
      return task;
    },
    get proof() {
      return proof;
    },
  };
}
