-- T12: independent, never-auto-approved draft verification queue.
-- A verification is not a normal regression Run and cannot inherit its authority.
CREATE TABLE repair_candidate_verifications (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  case_id uuid NOT NULL,
  case_version_id uuid NOT NULL,
  candidate_sha256 text NOT NULL CHECK(candidate_sha256 ~ '^[a-f0-9]{64}$'),
  requested_by uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','completed')),
  outcome text CHECK(outcome IN ('passed','failed','inconclusive')),
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  FOREIGN KEY(project_id,proposal_id) REFERENCES repair_proposals(project_id,id),
  FOREIGN KEY(project_id,case_id,case_version_id)
    REFERENCES saved_case_versions(project_id,case_id,id),
  CHECK(
    (status='queued' AND outcome IS NULL AND started_at IS NULL AND finished_at IS NULL)
    OR
    (status='running' AND outcome IS NULL AND started_at IS NOT NULL AND finished_at IS NULL)
    OR
    (status='completed' AND outcome IS NOT NULL AND started_at IS NOT NULL AND finished_at IS NOT NULL)
  )
);
CREATE INDEX repair_candidate_verification_queue
  ON repair_candidate_verifications(status,created_at,id);
CREATE UNIQUE INDEX repair_candidate_verification_one_active
  ON repair_candidate_verifications(project_id,case_version_id)
  WHERE status IN ('queued','running');
CREATE INDEX repair_candidate_verification_history
  ON repair_candidate_verifications(project_id,case_version_id,created_at DESC);

ALTER TABLE repair_candidate_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE repair_candidate_verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY candidate_verification_read ON repair_candidate_verifications
  FOR SELECT TO localqa_app USING(can_project(project_id));
CREATE POLICY candidate_verification_create ON repair_candidate_verifications
  FOR INSERT TO localqa_app WITH CHECK(can_project(project_id,'operator'));
CREATE POLICY candidate_verification_process ON repair_candidate_verifications
  FOR UPDATE TO localqa_app USING(can_project(project_id,'owner'))
  WITH CHECK(can_project(project_id,'owner'));
GRANT SELECT,INSERT,UPDATE ON repair_candidate_verifications TO localqa_app;

-- Approving a repair candidate requires a *completed, source-hash-bound,
-- independent* successful verification. The preexisting owner/preview
-- approval checks still apply; this trigger only adds a mandatory gate.
CREATE FUNCTION guard_candidate_verification_before_approval()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.review_status='approved' AND OLD.review_status='draft'
     AND EXISTS (
       SELECT 1 FROM repair_candidate_drafts d
       WHERE d.project_id=NEW.project_id AND d.case_version_id=NEW.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM repair_candidate_verifications v
       WHERE v.project_id=NEW.project_id AND v.case_version_id=NEW.id
         AND v.candidate_sha256=NEW.sha256
         AND v.status='completed' AND v.outcome='passed'
         AND v.result->>'fullyVerified'='true'
         AND jsonb_array_length(COALESCE(v.result->'observations','[]'::jsonb))>0
     )
  THEN
    RAISE check_violation USING MESSAGE='candidate requires successful independent verification';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER candidate_approval_requires_verification
  BEFORE UPDATE OF review_status ON saved_case_versions FOR EACH ROW
  EXECUTE FUNCTION guard_candidate_verification_before_approval();
