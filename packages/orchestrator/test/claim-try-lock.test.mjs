// A worker launches BROWSER_SLOTS+1 concurrent claim flights. A blocking
// advisory lock made them hold pooled connections while queued, starving
// heartbeats/model reservations of already-running tasks (66 saw 13 tasks fail
// with SERVICE_UNAVAILABLE in the same 10 ms window). The claim must try-lock.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Coordinator } from '../dist/index.js';

const scope = {
  projectId: 'aaaa0000-0000-4000-8000-000000000001',
  workerId: 'w',
};

function fixture(locked) {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes('is_admin()')) return { rows: [{ allowed: true }] };
      if (sql.includes('pg_try_advisory_xact_lock'))
        return { rows: [{ locked }] };
      if (sql.includes('budget_reservations'))
        return { rows: [{ children: 0, project: 0, control: 0 }] };
      if (sql.includes('FROM jobs j JOIN runs r'))
        return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  };
  const coordinator = new Coordinator({
    db: { actor: async (_actor, work) => work(client) },
    serviceActor: { userId: 'aaaa0000-0000-4000-8000-000000000002' },
    vault: {},
    platformSlots: 25,
    projectSlots: 25,
  });
  return { coordinator, queries };
}

test('a busy claim lock returns null immediately instead of holding a connection', async () => {
  const { coordinator, queries } = fixture(false);
  const started = Date.now();
  const lease = await coordinator.claim(scope);
  assert.equal(lease, null);
  assert.ok(Date.now() - started < 1000, 'claim must not wait for the lock');
  assert.equal(
    queries.filter((sql) => sql.includes('pg_advisory_xact_lock')).length,
    0,
    'the waiting lock form must not be used',
  );
  assert.equal(
    queries.filter((sql) => sql.includes('pg_try_advisory_xact_lock')).length,
    1,
  );
  // Nothing after the failed try-lock: the connection is released at once.
  assert.equal(queries.length, 2, queries.join('\n'));
});

test('a free claim lock still runs the slot check and job claim', async () => {
  const { coordinator, queries } = fixture(true);
  const lease = await coordinator.claim(scope);
  assert.equal(lease, null);
  assert.ok(
    queries.some((sql) => sql.includes('budget_reservations')),
    'slot accounting still happens under the lock',
  );
  assert.ok(
    queries.some((sql) => sql.includes('FROM jobs j JOIN runs r')),
    'job claim is attempted',
  );
});
