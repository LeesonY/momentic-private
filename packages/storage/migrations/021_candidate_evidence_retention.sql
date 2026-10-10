-- T13 evidence lifecycle: retain raw screenshot + redacted step snapshots for
-- 90 days, preserve only the hash/ownership receipt afterwards. This is an
-- explicit privacy tradeoff: an expired draft requires a new verification
-- before approval. No actor/worker receives DELETE privilege on raw evidence.
CREATE TABLE repair_candidate_evidence_receipts (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  verification_id uuid NOT NULL,
  case_version_id uuid NOT NULL,
  step_index integer NOT NULL,
  step_kind text NOT NULL,
  criterion_id text,
  criterion_passed boolean,
  snapshot_id uuid NOT NULL,
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  screenshot_sha256 text CHECK (screenshot_sha256 ~ '^[a-f0-9]{64}$'),
  screenshot_bytes integer,
  display_url text NOT NULL,
  created_at timestamptz NOT NULL,
  purged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (project_id,verification_id)
    REFERENCES repair_candidate_verifications(project_id,id),
  UNIQUE(project_id,verification_id,step_index)
);
CREATE INDEX candidate_receipts_by_verification
  ON repair_candidate_evidence_receipts(project_id,verification_id,step_index);
ALTER TABLE repair_candidate_evidence_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE repair_candidate_evidence_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY candidate_receipt_owner_read ON repair_candidate_evidence_receipts
  FOR SELECT TO localqa_app USING(can_project(project_id,'owner'));
GRANT SELECT ON repair_candidate_evidence_receipts TO localqa_app;

-- Check the invoker's database role BEFORE entering a SECURITY DEFINER body.
-- Only a project-scoped worker may run maintenance; all eligibility, age and
-- selection limits are hard-coded server-side, not caller-controlled SQL.
CREATE FUNCTION prune_candidate_evidence(
  pid uuid, requested_limit integer DEFAULT 100
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE removed_count integer;
BEGIN
  IF current_setting('role',true) <> 'localqa_worker'
     OR nullif(current_setting('localqa.worker_id',true),'') IS NULL
     OR NOT public.worker_project(pid)
  THEN RAISE insufficient_privilege USING MESSAGE='scoped maintenance worker required';
  END IF;
  IF requested_limit<1 OR requested_limit>100 OR requested_limit IS NULL
  THEN RAISE check_violation USING MESSAGE='invalid maintenance batch size';
  END IF;
  WITH eligible AS (
    SELECT e.* FROM public.repair_candidate_evidence e
    JOIN public.repair_candidate_verifications v
      ON v.id=e.verification_id AND v.project_id=e.project_id
    WHERE e.project_id=pid
      AND v.status='completed'
      AND v.finished_at < clock_timestamp()-interval '90 days'
    ORDER BY e.created_at,e.id
    FOR UPDATE OF e SKIP LOCKED LIMIT requested_limit
  ),
  retained AS (
    INSERT INTO public.repair_candidate_evidence_receipts(
      id,project_id,verification_id,case_version_id,step_index,
      step_kind,criterion_id,criterion_passed,snapshot_id,snapshot_sha256,
      screenshot_sha256,screenshot_bytes,display_url,created_at
    )
    SELECT id,project_id,verification_id,case_version_id,step_index,
      step_kind,criterion_id,criterion_passed,snapshot_id,snapshot_sha256,
      screenshot_sha256,screenshot_bytes,
      left(COALESCE(snapshot_document->>'displayUrl',''),8192),created_at
    FROM eligible
    RETURNING id
  ),
  deleted AS (
    DELETE FROM public.repair_candidate_evidence e
    USING retained r WHERE e.id=r.id RETURNING e.id
  )
  SELECT count(*)::integer INTO removed_count FROM deleted;
  RETURN removed_count;
END $$;
REVOKE ALL ON FUNCTION prune_candidate_evidence(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION prune_candidate_evidence(uuid,integer)
  TO localqa_worker;
