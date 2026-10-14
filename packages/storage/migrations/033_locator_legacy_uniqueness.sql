-- Preserve the original one-draft-per-task invariant for legacy callers.
-- Pre-032 rows have unknown suggestion_index and cannot be backfilled safely.
-- A rollback to the old API still cannot duplicate a legacy draft.
CREATE UNIQUE INDEX locator_maintenance_legacy_witness_unique
  ON locator_maintenance_drafts(project_id,case_id,task_id)
  WHERE suggestion_index IS NULL;
