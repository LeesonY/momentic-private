-- T12: untrusted locator hints only. No historical pass/verdict is cached.
CREATE TABLE regression_locator_hints (
  project_id uuid NOT NULL REFERENCES projects(id),
  cache_key text NOT NULL CHECK(cache_key ~ '^[a-f0-9]{64}$'),
  hint jsonb NOT NULL,
  source_version_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '7 days',
  PRIMARY KEY (project_id, cache_key),
  FOREIGN KEY (project_id, source_version_id)
    REFERENCES saved_case_versions(project_id,id)
);
CREATE INDEX regression_locator_hints_expiry
  ON regression_locator_hints(project_id, expires_at);

CREATE TABLE run_locator_cache_stats (
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  hits integer NOT NULL DEFAULT 0 CHECK (hits >= 0),
  misses integer NOT NULL DEFAULT 0 CHECK (misses >= 0),
  invalidated integer NOT NULL DEFAULT 0 CHECK (invalidated >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, run_id),
  FOREIGN KEY (project_id,run_id) REFERENCES runs(project_id,id)
);

ALTER TABLE regression_locator_hints ENABLE ROW LEVEL SECURITY;
ALTER TABLE regression_locator_hints FORCE ROW LEVEL SECURITY;
CREATE POLICY regression_locator_hints_app ON regression_locator_hints
  FOR ALL TO localqa_app USING(can_project(project_id,'operator'))
  WITH CHECK(can_project(project_id,'operator'));
CREATE POLICY regression_locator_hints_worker ON regression_locator_hints
  FOR ALL TO localqa_worker USING(worker_project(project_id))
  WITH CHECK(worker_project(project_id));
GRANT SELECT,INSERT,UPDATE,DELETE ON regression_locator_hints TO localqa_app;

ALTER TABLE run_locator_cache_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_locator_cache_stats FORCE ROW LEVEL SECURITY;
CREATE POLICY run_locator_cache_stats_read ON run_locator_cache_stats
  FOR SELECT TO localqa_app USING(can_project(project_id));
CREATE POLICY run_locator_cache_stats_write ON run_locator_cache_stats
  FOR INSERT TO localqa_app WITH CHECK(can_project(project_id,'operator'));
CREATE POLICY run_locator_cache_stats_update ON run_locator_cache_stats
  FOR UPDATE TO localqa_app USING(can_project(project_id,'operator'))
  WITH CHECK(can_project(project_id,'operator'));
GRANT SELECT,INSERT,UPDATE ON run_locator_cache_stats TO localqa_app;

-- The current proposal contract deliberately stores text diffs as inert
-- suggestions, not executable DSL. Review never modifies approved baselines.
ALTER TABLE repair_proposals
  ADD COLUMN review_reason text,
  ADD COLUMN reviewed_by uuid REFERENCES users(id),
  ADD COLUMN reviewed_at timestamptz;
ALTER TABLE repair_proposals ADD CONSTRAINT repair_review_consistent CHECK (
  (status = 'draft' AND reviewed_at IS NULL AND reviewed_by IS NULL AND review_reason IS NULL)
  OR
  (status IN ('approved','rejected') AND reviewed_at IS NOT NULL
    AND reviewed_by IS NOT NULL AND length(trim(review_reason)) >= 1)
);
CREATE FUNCTION guard_repair_proposal_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.case_id,NEW.project_id,NEW.finding_id,NEW.proposed_version,
         NEW.diff,NEW.verification_run_id,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.case_id,OLD.project_id,OLD.finding_id,OLD.proposed_version,
         OLD.diff,OLD.verification_run_id,OLD.created_at)
  THEN RAISE check_violation USING MESSAGE='repair suggestion is immutable';
  END IF;
  IF OLD.status <> 'draft' OR NEW.status NOT IN ('approved','rejected')
     OR NOT can_project(NEW.project_id,'owner')
     OR NEW.reviewed_by IS DISTINCT FROM actor_id()
     OR NEW.reviewed_at IS NULL OR length(trim(NEW.review_reason)) < 10
  THEN RAISE check_violation USING MESSAGE='repair review requires owner approval';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER repair_proposal_review_guard
  BEFORE UPDATE ON repair_proposals FOR EACH ROW
  EXECUTE FUNCTION guard_repair_proposal_review();
