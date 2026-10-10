-- T13 privacy hardening: retention receipts must never retain page paths,
-- query strings, embedded account IDs or tokens after evidence expires.
-- Hashes and opaque UUID ownership remain sufficient for audit.
UPDATE repair_candidate_evidence_receipts
SET display_url='',criterion_id=NULL
WHERE display_url<>'' OR criterion_id IS NOT NULL;
ALTER TABLE repair_candidate_evidence_receipts
  ADD CONSTRAINT candidate_receipt_no_sensitive_strings
  CHECK(display_url='' AND criterion_id IS NULL);

CREATE OR REPLACE FUNCTION prune_candidate_evidence(
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
      step_kind,NULL::text,criterion_passed,snapshot_id,snapshot_sha256,
      screenshot_sha256,screenshot_bytes,
      ''::text,created_at
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
