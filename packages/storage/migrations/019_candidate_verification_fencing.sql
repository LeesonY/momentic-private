-- T13: verification conclusions can only be written by the scoped worker.
-- Preserve the app role's ability to request (INSERT) and inspect (SELECT),
-- but not alter evidence or transition a verification to passed.
DROP POLICY candidate_verification_process ON repair_candidate_verifications;
REVOKE UPDATE ON repair_candidate_verifications FROM localqa_app;

ALTER TABLE repair_candidate_verifications
  ADD COLUMN worker_id text,
  ADD COLUMN fencing_token bigint NOT NULL DEFAULT 0 CHECK(fencing_token>=0),
  ADD COLUMN lease_until timestamptz,
  ADD COLUMN legacy_result jsonb;
-- Any conclusion produced before this migration was writable by an app
-- project owner. Preserve its original contents for audit but do NOT let a
-- legacy "passed" result satisfy the new approval gate.
UPDATE repair_candidate_verifications SET
  legacy_result=jsonb_build_object('outcome',outcome,'result',result),
  status='completed',outcome='inconclusive',
  result='{"fullyVerified":false,"reasonCode":"LEGACY_UNTRUSTED","observations":[]}'::jsonb,
  worker_id='t13-legacy-migration',fencing_token=1,lease_until=NULL,
  started_at=COALESCE(started_at,created_at),
  finished_at=COALESCE(finished_at,clock_timestamp())
WHERE status='completed';
-- Pre-T13 running records lack a fenced lease. They cannot be resumed safely.
UPDATE repair_candidate_verifications SET
  legacy_result=jsonb_build_object('outcome',outcome,'result',result),
  status='completed',outcome='inconclusive',
  result='{"fullyVerified":false,"reasonCode":"LEGACY_INTERRUPTED","observations":[]}'::jsonb,
  worker_id='t13-legacy-migration',fencing_token=1,lease_until=NULL,
  started_at=COALESCE(started_at,created_at),
  finished_at=clock_timestamp()
WHERE status='running';
ALTER TABLE repair_candidate_verifications ADD CONSTRAINT candidate_verification_lease_shape
  CHECK (
    (status='queued' AND worker_id IS NULL AND fencing_token=0 AND lease_until IS NULL)
    OR (status='running' AND worker_id IS NOT NULL AND fencing_token>0
        AND lease_until IS NOT NULL)
    OR (status='completed' AND worker_id IS NOT NULL AND fencing_token>0
        AND lease_until IS NULL)
  );

CREATE POLICY candidate_verification_worker_select ON repair_candidate_verifications
  FOR SELECT TO localqa_worker USING(worker_project(project_id));
CREATE POLICY candidate_verification_worker_update ON repair_candidate_verifications
  FOR UPDATE TO localqa_worker USING(worker_project(project_id))
  WITH CHECK(worker_project(project_id));
GRANT SELECT,UPDATE ON repair_candidate_verifications TO localqa_worker;
-- The worker must read the frozen candidate document to validate its hash.
-- Its existing forced RLS permits only the requested worker_project scope.
GRANT SELECT ON saved_case_versions TO localqa_worker;

-- Only a server-authenticated, project-scoped worker can claim or conclude.
-- Only the current lease holder may report a result, and expired attempts
-- are inconclusive (never retried automatically after possible side effects).
CREATE FUNCTION guard_candidate_verification_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wid text := nullif(current_setting('localqa.worker_id', true),'');
BEGIN
  IF current_user <> 'localqa_worker' OR wid IS NULL
     OR NOT worker_project(NEW.project_id)
  THEN RAISE insufficient_privilege USING MESSAGE='candidate verification worker required';
  END IF;
  IF ROW(NEW.id,NEW.project_id,NEW.proposal_id,NEW.case_id,
         NEW.case_version_id,NEW.candidate_sha256,NEW.requested_by,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.project_id,OLD.proposal_id,OLD.case_id,
         OLD.case_version_id,OLD.candidate_sha256,OLD.requested_by,OLD.created_at)
     OR NEW.legacy_result IS DISTINCT FROM OLD.legacy_result
  THEN RAISE check_violation USING MESSAGE='verification identity immutable';
  END IF;
  IF OLD.status='queued' AND NEW.status='running' THEN
    IF NEW.worker_id IS DISTINCT FROM wid
       OR NEW.fencing_token<>OLD.fencing_token+1
       OR NEW.started_at IS NULL OR NEW.finished_at IS NOT NULL
       OR NEW.outcome IS NOT NULL OR NEW.result IS DISTINCT FROM OLD.result
       OR NEW.lease_until IS NULL OR NEW.lease_until<=clock_timestamp()
       OR NEW.lease_until>clock_timestamp()+interval '120 seconds'
    THEN RAISE check_violation USING MESSAGE='invalid candidate claim';
    END IF;
  ELSIF OLD.status='running' AND NEW.status='completed' THEN
    IF NEW.lease_until IS NOT NULL OR NEW.finished_at IS NULL
       OR NEW.started_at IS DISTINCT FROM OLD.started_at
       OR NEW.outcome IS NULL
       OR jsonb_typeof(NEW.result)<>'object'
       OR jsonb_typeof(NEW.result->'observations')<>'array'
    THEN RAISE check_violation USING MESSAGE='invalid candidate conclusion';
    END IF;
    IF OLD.lease_until>clock_timestamp()
       AND OLD.worker_id=wid
       AND NEW.worker_id=OLD.worker_id
       AND NEW.fencing_token=OLD.fencing_token
    THEN
      IF NEW.outcome='passed' AND (
         NEW.result->>'fullyVerified' IS DISTINCT FROM 'true'
         OR NEW.result->>'reasonCode' IS NOT NULL
         OR jsonb_array_length(NEW.result->'observations')=0
         OR COALESCE((NEW.result->>'verifiedCriteria')::integer,0)<=0
         OR COALESCE((NEW.result->>'observedSteps')::integer,0)<=0
      ) THEN RAISE check_violation USING MESSAGE='candidate pass lacks evidence';
      END IF;
    ELSIF OLD.lease_until<=clock_timestamp()
       AND NEW.worker_id=wid AND NEW.fencing_token=OLD.fencing_token+1
       AND NEW.outcome='inconclusive'
       AND NEW.result->>'fullyVerified'='false'
       AND NEW.result->>'reasonCode'='VERIFIER_INTERRUPTED'
       AND jsonb_array_length(NEW.result->'observations')=0
    THEN
      NULL; -- An expired attempt cannot be rescued as passed.
    ELSE
      RAISE check_violation USING MESSAGE='stale candidate verification lease';
    END IF;
  ELSE
    RAISE check_violation USING MESSAGE='invalid candidate verification state transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER candidate_verification_transition
  BEFORE UPDATE ON repair_candidate_verifications FOR EACH ROW
  EXECUTE FUNCTION guard_candidate_verification_transition();

-- Extra defense: requests cannot impersonate a different user or hash.
CREATE FUNCTION guard_candidate_verification_request()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user<>'localqa_app' OR NEW.requested_by IS DISTINCT FROM actor_id()
     OR NOT can_project(NEW.project_id,'operator')
     OR NEW.status<>'queued' OR NEW.outcome IS NOT NULL
     OR NEW.result<>'{}'::jsonb
     OR NOT EXISTS(
       SELECT 1 FROM repair_candidate_drafts d
       JOIN saved_case_versions v ON v.project_id=d.project_id
         AND v.case_id=d.case_id AND v.id=d.case_version_id
       JOIN repair_proposals p ON p.project_id=d.project_id
         AND p.id=d.proposal_id
       WHERE d.project_id=NEW.project_id AND d.proposal_id=NEW.proposal_id
         AND d.case_id=NEW.case_id AND d.case_version_id=NEW.case_version_id
         AND v.sha256=NEW.candidate_sha256 AND v.review_status='draft'
         AND p.status='approved'
     )
  THEN RAISE check_violation USING MESSAGE='invalid candidate verification request';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER candidate_verification_request
  BEFORE INSERT ON repair_candidate_verifications FOR EACH ROW
  EXECUTE FUNCTION guard_candidate_verification_request();
