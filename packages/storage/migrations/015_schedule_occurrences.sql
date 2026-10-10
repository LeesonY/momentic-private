-- T11: upgrade the placeholder table from 001_core, preserving its rows,
-- composite run FK, and existing 003_access row-level security policies.
ALTER TABLE schedules ADD COLUMN created_by uuid REFERENCES users(id);
ALTER TABLE schedules ADD COLUMN last_checked_at timestamptz;
ALTER TABLE schedules ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp();

ALTER TABLE schedule_occurrences RENAME COLUMN occurrence_at TO scheduled_at;
ALTER TABLE schedule_occurrences ADD COLUMN schedule_version integer NOT NULL DEFAULT 1
  CHECK(schedule_version>0);
ALTER TABLE schedule_occurrences ADD COLUMN scheduled_local text;
-- Historical records have no local-clock context. Preserve them under a
-- distinguishable UTC key; do not pretend those runs were local schedule hits.
UPDATE schedule_occurrences SET scheduled_local =
  'legacy:' || to_char(scheduled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI');
ALTER TABLE schedule_occurrences ALTER COLUMN scheduled_local SET NOT NULL;
ALTER TABLE schedule_occurrences ADD CONSTRAINT schedule_occurrences_local_length
  CHECK(length(scheduled_local) BETWEEN 1 AND 100);
ALTER TABLE schedule_occurrences ADD COLUMN status text NOT NULL DEFAULT 'failed'
  CHECK(status IN ('pending','dispatching','started','skipped','failed'));
UPDATE schedule_occurrences SET status='started' WHERE run_id IS NOT NULL;
ALTER TABLE schedule_occurrences ADD COLUMN template_kind_snapshot text
  CHECK(template_kind_snapshot IN ('smoke','regression'));
ALTER TABLE schedule_occurrences ADD COLUMN run_template_snapshot jsonb;
ALTER TABLE schedule_occurrences ADD COLUMN overlap_policy_snapshot text
  CHECK(overlap_policy_snapshot IN ('skip','queue'));
-- Keep the original configuration for a queued occurrence even if a user
-- later modifies the Schedule. Historic pre-T11 rows need not have a snapshot.
ALTER TABLE schedule_occurrences ADD CONSTRAINT schedule_pending_snapshot
  CHECK(status NOT IN ('pending','dispatching') OR
    (template_kind_snapshot IS NOT NULL AND run_template_snapshot IS NOT NULL
     AND overlap_policy_snapshot IS NOT NULL));
ALTER TABLE schedule_occurrences ADD COLUMN processing_at timestamptz;
ALTER TABLE schedule_occurrences ADD COLUMN created_at timestamptz NOT NULL
  DEFAULT clock_timestamp();
ALTER TABLE schedule_occurrences ADD COLUMN updated_at timestamptz NOT NULL
  DEFAULT clock_timestamp();
ALTER TABLE schedule_occurrences ADD CONSTRAINT schedule_occurrences_local_unique
  UNIQUE(schedule_id,scheduled_local);
-- Do not invalidate historical placeholder rows whose schedule was deleted.
-- New inserts must reference an existing schedule; NOT VALID is intentional.
ALTER TABLE schedule_occurrences ADD CONSTRAINT schedule_occurrences_schedule_fk
  FOREIGN KEY(schedule_id) REFERENCES schedules(id) ON DELETE CASCADE NOT VALID;
CREATE INDEX schedule_occurrences_dispatch
  ON schedule_occurrences(status,processing_at,created_at);
CREATE INDEX schedule_occurrences_history
  ON schedule_occurrences(project_id,schedule_id,created_at DESC);
-- RLS and grants were already installed in migration 003.
