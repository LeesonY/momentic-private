-- Locator drift is not a confirmed product defect. Give approved-source
-- locator maintenance its own immutable provenance, while reusing the
-- fenced, credential-free, screenshot-backed verifier lane.
CREATE TABLE locator_maintenance_drafts (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  case_id uuid NOT NULL,
  case_version_id uuid NOT NULL,
  source_version_id uuid NOT NULL,
  source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
  candidate_sha256 text NOT NULL CHECK(candidate_sha256 ~ '^[a-f0-9]{64}$'),
  task_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(project_id,id),
  UNIQUE(project_id,case_version_id),
  UNIQUE(project_id,case_id,task_id),
  FOREIGN KEY(project_id,case_id,case_version_id)
    REFERENCES saved_case_versions(project_id,case_id,id),
  FOREIGN KEY(project_id,case_id,source_version_id)
    REFERENCES saved_case_versions(project_id,case_id,id)
);
ALTER TABLE locator_maintenance_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE locator_maintenance_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY locator_maintenance_app_read ON locator_maintenance_drafts
  FOR SELECT TO localqa_app USING(can_project(project_id));
CREATE POLICY locator_maintenance_app_insert ON locator_maintenance_drafts
  FOR INSERT TO localqa_app WITH CHECK(can_project(project_id,'operator'));
CREATE POLICY locator_maintenance_worker_read ON locator_maintenance_drafts
  FOR SELECT TO localqa_worker USING(worker_project(project_id));
GRANT SELECT,INSERT ON locator_maintenance_drafts TO localqa_app;
GRANT SELECT ON locator_maintenance_drafts TO localqa_worker;

CREATE FUNCTION guard_locator_maintenance_draft()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user<>'localqa_app'
     OR NEW.created_by IS DISTINCT FROM actor_id()
     OR NOT can_project(NEW.project_id,'operator')
     OR NOT EXISTS(
       SELECT 1 FROM saved_cases c
       JOIN saved_case_versions src
         ON src.project_id=c.project_id AND src.case_id=c.id
         AND src.id=NEW.source_version_id
       JOIN saved_case_versions dest
         ON dest.project_id=c.project_id AND dest.case_id=c.id
         AND dest.id=NEW.case_version_id
       JOIN jobs j ON j.project_id=c.project_id AND j.id=NEW.task_id
       JOIN run_case_regression_bindings b
         ON b.project_id=j.project_id AND b.run_id=j.run_id
         AND b.case_id=j.case_id
       WHERE c.project_id=NEW.project_id AND c.id=NEW.case_id
         AND c.status='active'
         AND c.current_approved_version_id=src.id
         AND src.review_status='approved' AND src.sha256=NEW.source_sha256
         AND dest.review_status='draft' AND dest.sha256=NEW.candidate_sha256
         AND j.role='executor' AND j.status='succeeded'
         AND j.result->'regressionReplay'->>'status'='failed'
         AND j.result->'regressionReplay'->>'reasonCode'='LOCATOR_NOT_FOUND'
         AND b.source_version_id=src.id AND b.source_sha256=src.sha256
         AND j.result->>'sourceVersionId'=src.id::text
         AND j.result->>'sourceDocumentSha256'=src.sha256
     )
  THEN RAISE check_violation USING MESSAGE='untrusted locator maintenance provenance';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER locator_maintenance_draft_guard
  BEFORE INSERT ON locator_maintenance_drafts FOR EACH ROW
  EXECUTE FUNCTION guard_locator_maintenance_draft();

ALTER TABLE repair_candidate_verifications
  ALTER COLUMN proposal_id DROP NOT NULL,
  ADD COLUMN maintenance_id uuid,
  ADD CONSTRAINT verification_proposal_xor_locator_maintenance
    CHECK ((proposal_id IS NOT NULL) <> (maintenance_id IS NOT NULL)),
  ADD CONSTRAINT maintenance_verification_source
    FOREIGN KEY(project_id,maintenance_id)
    REFERENCES locator_maintenance_drafts(project_id,id);
CREATE INDEX locator_maintenance_verification_history
  ON repair_candidate_verifications(project_id,maintenance_id,created_at DESC)
  WHERE maintenance_id IS NOT NULL;

CREATE FUNCTION guard_maintenance_verification_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.maintenance_id IS DISTINCT FROM OLD.maintenance_id
  THEN RAISE check_violation USING MESSAGE='maintenance verification identity immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER maintenance_verification_identity
  BEFORE UPDATE ON repair_candidate_verifications FOR EACH ROW
  EXECUTE FUNCTION guard_maintenance_verification_identity();

CREATE OR REPLACE FUNCTION guard_candidate_verification_request()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user<>'localqa_app' OR NEW.requested_by IS DISTINCT FROM actor_id()
     OR NOT can_project(NEW.project_id,'operator')
     OR NEW.status<>'queued' OR NEW.outcome IS NOT NULL
     OR NEW.result<>'{}'::jsonb
     OR NOT (
       (NEW.proposal_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM repair_candidate_drafts d
         JOIN saved_case_versions v ON v.project_id=d.project_id
           AND v.case_id=d.case_id AND v.id=d.case_version_id
         JOIN repair_proposals p ON p.project_id=d.project_id AND p.id=d.proposal_id
         WHERE d.project_id=NEW.project_id AND d.proposal_id=NEW.proposal_id
           AND d.case_id=NEW.case_id AND d.case_version_id=NEW.case_version_id
           AND v.sha256=NEW.candidate_sha256 AND v.review_status='draft'
           AND p.status='approved'
       ))
       OR
       (NEW.maintenance_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM locator_maintenance_drafts d
         JOIN saved_case_versions v ON v.project_id=d.project_id
           AND v.case_id=d.case_id AND v.id=d.case_version_id
         JOIN saved_cases c ON c.project_id=d.project_id AND c.id=d.case_id
         JOIN saved_case_versions src
           ON src.project_id=d.project_id AND src.id=d.source_version_id
         WHERE d.project_id=NEW.project_id AND d.id=NEW.maintenance_id
           AND d.case_id=NEW.case_id AND d.case_version_id=NEW.case_version_id
           AND v.sha256=NEW.candidate_sha256 AND v.review_status='draft'
           AND d.candidate_sha256=v.sha256
           AND c.current_approved_version_id=d.source_version_id
           AND src.review_status='approved' AND src.sha256=d.source_sha256
           AND c.status='active'
       ))
     )
  THEN RAISE check_violation USING MESSAGE='invalid candidate verification request';
  END IF;
  RETURN NEW;
END $$;

-- Approval of a locator-maintenance candidate is never valid without fresh,
-- immutable, screenshot-backed worker evidence of its actual frozen oracles.
CREATE OR REPLACE FUNCTION guard_candidate_verification_before_approval()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.review_status='approved' AND OLD.review_status='draft'
     AND (
       EXISTS (SELECT 1 FROM repair_candidate_drafts d
               WHERE d.project_id=NEW.project_id AND d.case_version_id=NEW.id)
       OR EXISTS (SELECT 1 FROM locator_maintenance_drafts d
                  WHERE d.project_id=NEW.project_id AND d.case_version_id=NEW.id)
     )
     AND NOT EXISTS (
       SELECT 1 FROM repair_candidate_verifications v
       WHERE v.project_id=NEW.project_id AND v.case_version_id=NEW.id
         AND v.candidate_sha256=NEW.sha256
         AND v.status='completed' AND v.outcome='passed'
         AND v.result->>'fullyVerified'='true'
         AND jsonb_array_length(COALESCE(v.result->'observations','[]'::jsonb))>0
         AND v.worker_id NOT LIKE 't13-legacy-%'
         AND (
           (v.proposal_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM repair_candidate_drafts d
             WHERE d.project_id=v.project_id AND d.case_version_id=NEW.id
               AND d.proposal_id=v.proposal_id
           ))
           OR
           (v.maintenance_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM locator_maintenance_drafts d
             JOIN saved_cases c ON c.project_id=d.project_id AND c.id=d.case_id
             WHERE d.project_id=v.project_id AND d.case_version_id=NEW.id
               AND d.id=v.maintenance_id
               AND c.current_approved_version_id=d.source_version_id
           ))
         )
         AND EXISTS (
           SELECT 1 FROM repair_candidate_evidence e
           WHERE e.project_id=v.project_id AND e.verification_id=v.id
             AND e.case_version_id=v.case_version_id
             AND e.fencing_token=v.fencing_token
             AND e.criterion_passed=true AND e.screenshot_sha256 IS NOT NULL
         )
     )
  THEN RAISE check_violation USING MESSAGE='candidate requires screenshot-backed independent verification';
  END IF;
  RETURN NEW;
END $$;
