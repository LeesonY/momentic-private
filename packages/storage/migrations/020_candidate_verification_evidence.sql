-- T13: immutable, lease-owned step evidence. Candidate screenshots are
-- encrypted by the worker with the protected KEK before database insertion.
-- Ordinary application actors can neither write nor read the ciphertext.
ALTER TABLE repair_candidate_verifications
  ADD CONSTRAINT candidate_verification_scoped_id UNIQUE(project_id,id);

CREATE TABLE repair_candidate_evidence (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  verification_id uuid NOT NULL,
  case_version_id uuid NOT NULL,
  fencing_token bigint NOT NULL CHECK(fencing_token>0),
  step_index integer NOT NULL CHECK(step_index>=0 AND step_index<30),
  step_kind text NOT NULL CHECK(step_kind IN ('navigate','click','type_text','assert')),
  criterion_id text,
  criterion_passed boolean,
  snapshot_id uuid NOT NULL,
  snapshot_document jsonb NOT NULL,
  snapshot_sha256 text NOT NULL CHECK(snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  screenshot_sha256 text CHECK(screenshot_sha256 ~ '^[a-f0-9]{64}$'),
  screenshot_bytes integer CHECK(screenshot_bytes>0 AND screenshot_bytes<=1048576),
  screenshot_ciphertext bytea,
  screenshot_nonce bytea,
  screenshot_tag bytea,
  screenshot_key_version integer CHECK(screenshot_key_version>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(project_id,verification_id,step_index),
  FOREIGN KEY(project_id,verification_id)
    REFERENCES repair_candidate_verifications(project_id,id),
  FOREIGN KEY(project_id,case_version_id)
    REFERENCES saved_case_versions(project_id,id),
  CHECK ((criterion_id IS NULL AND criterion_passed IS NULL AND step_kind<>'assert')
     OR (criterion_id IS NOT NULL AND criterion_passed IS NOT NULL AND step_kind='assert')),
  CHECK ((screenshot_sha256 IS NULL AND screenshot_bytes IS NULL
           AND screenshot_ciphertext IS NULL AND screenshot_nonce IS NULL
           AND screenshot_tag IS NULL AND screenshot_key_version IS NULL)
      OR (screenshot_sha256 IS NOT NULL AND screenshot_bytes IS NOT NULL
           AND screenshot_ciphertext IS NOT NULL AND screenshot_nonce IS NOT NULL
           AND screenshot_tag IS NOT NULL AND screenshot_key_version IS NOT NULL
           AND octet_length(screenshot_nonce)=12
           AND octet_length(screenshot_tag)=16
           AND octet_length(screenshot_ciphertext)<=1400000))
);
CREATE INDEX candidate_evidence_by_verification
  ON repair_candidate_evidence(project_id,verification_id,step_index);
ALTER TABLE repair_candidate_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE repair_candidate_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY candidate_evidence_worker_read ON repair_candidate_evidence
  FOR SELECT TO localqa_worker USING(worker_project(project_id));
CREATE POLICY candidate_evidence_worker_insert ON repair_candidate_evidence
  FOR INSERT TO localqa_worker WITH CHECK(worker_project(project_id));
CREATE POLICY candidate_evidence_owner_read ON repair_candidate_evidence
  FOR SELECT TO localqa_app USING(can_project(project_id,'owner'));
GRANT SELECT,INSERT ON repair_candidate_evidence TO localqa_worker;
GRANT SELECT ON repair_candidate_evidence TO localqa_app;

CREATE FUNCTION guard_candidate_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v repair_candidate_verifications%ROWTYPE;
BEGIN
  IF current_user<>'localqa_worker' OR NOT worker_project(NEW.project_id)
  THEN RAISE insufficient_privilege USING MESSAGE='candidate evidence worker only';
  END IF;
  SELECT * INTO v FROM repair_candidate_verifications
    WHERE id=NEW.verification_id AND project_id=NEW.project_id FOR UPDATE;
  IF NOT FOUND OR v.status<>'running'
     OR v.lease_until<=clock_timestamp()
     OR v.worker_id IS DISTINCT FROM nullif(current_setting('localqa.worker_id',true),'')
     OR v.fencing_token<>NEW.fencing_token
     OR v.case_version_id<>NEW.case_version_id
     OR NEW.snapshot_document->>'snapshotId' IS DISTINCT FROM NEW.snapshot_id::text
     OR NEW.snapshot_document->>'redacted'<>'true'
     OR NEW.snapshot_document->>'truncated'<>'false'
     OR length(NEW.snapshot_document::text)>262144
     OR (NEW.criterion_id IS NOT NULL AND NEW.screenshot_sha256 IS NULL
          AND NEW.criterion_passed=true)
  THEN RAISE check_violation USING MESSAGE='candidate evidence ownership or completeness invalid';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER candidate_evidence_insert_guard
  BEFORE INSERT ON repair_candidate_evidence FOR EACH ROW
  EXECUTE FUNCTION guard_candidate_evidence();

CREATE FUNCTION guard_candidate_pass_has_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE steps integer; assertions integer;
BEGIN
  IF OLD.status='running' AND NEW.status='completed' AND NEW.outcome='passed' THEN
    SELECT count(*)::integer,
      count(*) FILTER (
        WHERE criterion_id IS NOT NULL AND criterion_passed=true
          AND screenshot_sha256 IS NOT NULL
      )::integer INTO steps,assertions
    FROM repair_candidate_evidence
    WHERE project_id=NEW.project_id AND verification_id=NEW.id
      AND case_version_id=NEW.case_version_id
      AND fencing_token=NEW.fencing_token;
    IF steps<>COALESCE((NEW.result->>'observedSteps')::integer,-1)
       OR assertions<>COALESCE((NEW.result->>'verifiedCriteria')::integer,-1)
       OR assertions=0
       OR jsonb_array_length(COALESCE(NEW.result->'observations','[]'::jsonb))<>assertions
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(NEW.result->'observations') AS obs
         WHERE NOT EXISTS (
           SELECT 1 FROM repair_candidate_evidence e
           WHERE e.project_id=NEW.project_id AND e.verification_id=NEW.id
             AND e.step_index=(obs->>'stepIndex')::integer
             AND e.criterion_id=obs->>'criterionId'
             AND e.snapshot_id=(obs->>'snapshotId')::uuid
             AND e.snapshot_sha256=obs->>'snapshotDigest'
             AND e.criterion_passed=true
         )
       )
    THEN RAISE check_violation USING MESSAGE='candidate pass lacks durable owned evidence';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER candidate_pass_requires_evidence
  BEFORE UPDATE ON repair_candidate_verifications FOR EACH ROW
  EXECUTE FUNCTION guard_candidate_pass_has_evidence();

-- The preceding immutability and fencing checks remain in force. Strengthen
-- approval by requiring durable screenshot-backed positive oracle evidence.
CREATE OR REPLACE FUNCTION guard_candidate_verification_before_approval()
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
         AND v.worker_id NOT LIKE 't13-legacy-%'
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
