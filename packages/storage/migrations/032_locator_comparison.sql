-- Multiple independently verifiable locator candidates from ONE immutable
-- executor witness. Preserve historical drafts (unknown legacy index = NULL).
-- Do not change or backfill old evidence/provenance.
ALTER TABLE locator_maintenance_drafts
  DROP CONSTRAINT locator_maintenance_drafts_project_id_case_id_task_id_key;
ALTER TABLE locator_maintenance_drafts
  ADD COLUMN suggestion_index smallint,
  ADD CONSTRAINT locator_maintenance_suggestion_index_bounds
    CHECK (suggestion_index BETWEEN 0 AND 2);
CREATE UNIQUE INDEX locator_maintenance_witness_candidate_unique
  ON locator_maintenance_drafts(project_id,case_id,task_id,suggestion_index)
  WHERE suggestion_index IS NOT NULL;
