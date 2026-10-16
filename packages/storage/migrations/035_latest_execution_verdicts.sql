-- A retry supersedes an earlier execution even when the newer attempt has no
-- valid verdict (running, interrupted, or invalidated). Consumers then project
-- it as inconclusive instead of presenting a stale pass/block/report. Independent
-- reproductions remain confirmation evidence, never the case's execution result.
-- Keep immutable verdict history, RLS and the confirmation guard from 034 intact.
CREATE OR REPLACE VIEW final_valid_verdicts WITH (security_invoker=true) AS
 SELECT DISTINCT ON (v.project_id,v.case_id) v.*
 FROM verdicts v
 JOIN case_attempts a ON a.id=v.attempt_id AND a.project_id=v.project_id
 JOIN jobs j ON j.id=a.task_id AND j.project_id=a.project_id
 WHERE v.valid AND j.role<>'reproducer'
   AND NOT EXISTS(SELECT 1 FROM verdict_invalidations i WHERE i.verdict_id=v.id)
   AND NOT EXISTS(
     SELECT 1 FROM case_attempts newer
     JOIN jobs newer_job ON newer_job.id=newer.task_id AND newer_job.project_id=newer.project_id
     WHERE newer.project_id=a.project_id AND newer.case_id=a.case_id
       AND newer.attempt_number>a.attempt_number AND newer_job.role<>'reproducer'
   )
 ORDER BY v.project_id,v.case_id,a.attempt_number DESC;
