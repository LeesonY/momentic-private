-- 037_stopped_recording.sql
-- A browser task stopped by cancellation, budget, context change or lease loss
-- still owns the rrweb/console/network evidence captured before the abort. The
-- last fenced worker may attach one TaskRecording snapshot to the terminal job.
-- This is deliberately narrower than a general terminal-job update: only the
-- result key 'taskRecording' may be added, once, and every other column stays
-- byte-for-byte unchanged.
CREATE OR REPLACE FUNCTION guard_task_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status IN ('succeeded','failed','cancelled','interrupted') AND NEW<>OLD THEN
  IF (to_jsonb(NEW) - 'result') = (to_jsonb(OLD) - 'result')
     AND (OLD.result IS NULL OR NOT (OLD.result ? 'taskRecording'))
     AND NEW.result IS NOT NULL
     AND NEW.result ? 'taskRecording'
     AND NEW.result = (COALESCE(OLD.result,'{}'::jsonb) || jsonb_build_object('taskRecording', NEW.result->'taskRecording'))
  THEN
   RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='TERMINAL_TASK';
 END IF;
 RETURN NEW;
END $$;
