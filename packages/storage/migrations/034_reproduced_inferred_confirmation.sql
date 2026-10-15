-- Mo-style sessions: a functional bug is confirmed once an independent agent
-- reproduces it from a clean start, whatever the expectation's source. The
-- remaining evidence requirements of 002 are unchanged.
CREATE OR REPLACE FUNCTION guard_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='functional' AND NEW.status='confirmed' AND (
  NEW.reproduction_id IS NULL OR NOT EXISTS(SELECT 1 FROM verdicts ov WHERE ov.attempt_id=NEW.original_attempt_id AND ov.valid AND ov.document->>'status'='issue_found' AND NOT EXISTS(SELECT 1 FROM verdict_invalidations i WHERE i.verdict_id=ov.id)) OR NOT EXISTS(
   SELECT 1 FROM reproductions r JOIN reproduction_evidence e ON e.reproduction_id=r.id JOIN artifacts a ON a.id=e.artifact_id
   JOIN case_attempts ca ON ca.id=r.attempt_id
   WHERE r.id=NEW.reproduction_id AND r.finding_id=NEW.id AND r.outcome='reproduced' AND r.fresh_context
     AND r.criteria_hash=NEW.criteria_hash AND a.task_id=r.task_id AND a.run_id=NEW.run_id
     AND EXISTS(SELECT 1 FROM verdicts rv WHERE rv.attempt_id=r.attempt_id AND rv.valid AND rv.document->>'status'='issue_found' AND NOT EXISTS(SELECT 1 FROM verdict_invalidations i WHERE i.verdict_id=rv.id))
     AND a.document->>'status' IN ('available','degraded') AND a.document->>'redaction' IN ('applied','not_needed')
     AND EXISTS(SELECT 1 FROM finding_evidence fe WHERE fe.finding_id=NEW.id)
  )
 ) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='CONFIRMATION_REQUIRES_INDEPENDENT_EVIDENCE'; END IF;
 RETURN NEW;
END $$;
