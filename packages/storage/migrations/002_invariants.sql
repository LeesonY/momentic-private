CREATE TABLE run_context_versions (
 project_id uuid NOT NULL, run_id uuid NOT NULL, context_version integer NOT NULL CHECK(context_version>0), config jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(run_id,context_version),
 FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id)
);
CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='IMMUTABLE_RECORD'; END $$;
CREATE FUNCTION version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='runs' AND (to_jsonb(NEW)-'event_seq')=(to_jsonb(OLD)-'event_seq') THEN RETURN NEW; END IF;
 IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VERSION_CONFLICT'; END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['users','projects','environments','auth_profiles','secrets','knowledge','model_profiles','runs','findings','input_requests'] LOOP
  EXECUTE format('CREATE TRIGGER version_guard BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION version_guard()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['environment_versions','auth_profile_versions','secret_versions','knowledge_versions','model_profile_versions','run_context_versions','run_model_bindings','run_knowledge_bindings','verdicts','reproductions','triage','audit_log','run_events'] LOOP
  EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_mutation()',t);
 END LOOP;
END $$;
CREATE FUNCTION guard_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status IN ('completed','cancelled','failed') AND (to_jsonb(NEW)-'event_seq')<>(to_jsonb(OLD)-'event_seq') THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='TERMINAL_RUN';
 END IF;
 IF NEW.context_version<OLD.context_version OR NEW.context_version>OLD.context_version+1 THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='CONTEXT_VERSION';
 END IF;
 IF NEW.effective_config<>OLD.effective_config AND NEW.context_version<>OLD.context_version+1 THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='IMMUTABLE_SNAPSHOT';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER run_guard BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION guard_run();
CREATE FUNCTION save_run_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' OR NEW.context_version<>OLD.context_version THEN
  INSERT INTO run_context_versions(project_id,run_id,context_version,config) VALUES(NEW.project_id,NEW.id,NEW.context_version,NEW.effective_config);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER run_context AFTER INSERT OR UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION save_run_context();
CREATE FUNCTION guard_case() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.frozen OR EXISTS(SELECT 1 FROM runs WHERE id=OLD.run_id AND status<>'draft') THEN
  IF TG_OP='DELETE' OR NEW.document<>OLD.document OR NEW.criteria_hash<>OLD.criteria_hash OR NEW.run_id<>OLD.run_id OR NEW.project_id<>OLD.project_id OR (OLD.frozen AND NOT NEW.frozen) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='IMMUTABLE_CASE';
  END IF;
 END IF;
 RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER case_guard BEFORE UPDATE OR DELETE ON run_cases FOR EACH ROW EXECUTE FUNCTION guard_case();
CREATE FUNCTION guard_task_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status IN ('succeeded','failed','cancelled','interrupted') AND NEW<>OLD THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='TERMINAL_TASK'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER job_terminal BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION guard_task_terminal();
CREATE FUNCTION guard_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.status IN ('completed','interrupted','cancelled') AND NEW<>OLD THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='TERMINAL_ATTEMPT'; END IF;
 IF TG_OP='UPDATE' AND (NEW.context_id<>OLD.context_id OR NEW.case_id<>OLD.case_id OR NEW.task_id<>OLD.task_id) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='IMMUTABLE_ATTEMPT'; END IF;
 UPDATE run_cases SET frozen=true WHERE id=NEW.case_id AND NOT frozen;
 RETURN NEW;
END $$;
CREATE TRIGGER attempt_guard BEFORE INSERT OR UPDATE ON case_attempts FOR EACH ROW EXECUTE FUNCTION guard_attempt();
CREATE FUNCTION guard_verdict() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j jobs; a case_attempts;
BEGIN
 SELECT * INTO a FROM case_attempts WHERE id=NEW.attempt_id;
 SELECT * INTO j FROM jobs WHERE id=a.task_id FOR UPDATE;
 IF j.status<>'running' OR j.fencing_token<>NEW.fencing_token OR j.lease_until<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM runs WHERE id=j.run_id AND status='running') THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='LEASE_EXPIRED';
 END IF;
 IF (NEW.document->>'attemptId')::uuid IS DISTINCT FROM NEW.attempt_id OR (NEW.document->>'caseId')::uuid IS DISTINCT FROM NEW.case_id OR (NEW.document->>'id')::uuid IS DISTINCT FROM NEW.id THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='VERDICT_ID_MISMATCH';
 END IF;
 IF NEW.document->>'status'='passed' AND EXISTS(
  SELECT 1 FROM run_cases c, jsonb_array_elements(c.document->'criteria') criterion
  WHERE c.id=NEW.case_id AND NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(NEW.document->'criterionResults') result
   WHERE result->>'criterionId'=criterion->>'id' AND result->>'result'='passed' AND jsonb_array_length(result->'evidenceRefs')>0
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(result->'evidenceRefs') eid WHERE NOT EXISTS(
       SELECT 1 FROM artifacts ar WHERE ar.id::text=eid AND ar.project_id=NEW.project_id AND ar.run_id=j.run_id AND ar.task_id=j.id
       AND ar.document->>'status' IN ('available','degraded') AND ar.document->>'redaction' IN ('applied','not_needed')
     ))
  )
 ) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PASSED_REQUIRES_VALID_CRITERIA'; END IF;
 IF NEW.document->>'status'='issue_found' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.document->'criterionResults') result WHERE result->>'result'='failed') THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ISSUE_REQUIRES_FAILED_CRITERION';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER verdict_guard BEFORE INSERT ON verdicts FOR EACH ROW EXECUTE FUNCTION guard_verdict();
CREATE VIEW final_valid_verdicts WITH (security_invoker=true) AS
 SELECT DISTINCT ON (v.project_id,v.case_id) v.* FROM verdicts v JOIN case_attempts a ON a.id=v.attempt_id
 WHERE v.valid ORDER BY v.project_id,v.case_id,a.attempt_number DESC;
CREATE FUNCTION guard_reproduction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f findings; original case_attempts; repeated case_attempts; j jobs;
BEGIN
 SELECT * INTO f FROM findings WHERE id=NEW.finding_id;
 SELECT * INTO original FROM case_attempts WHERE id=f.original_attempt_id;
 SELECT * INTO repeated FROM case_attempts WHERE id=NEW.attempt_id;
 SELECT * INTO j FROM jobs WHERE id=NEW.task_id;
 IF repeated.case_id<>f.case_id OR repeated.task_id<>NEW.task_id OR repeated.id=original.id OR repeated.context_id=original.context_id OR NEW.criteria_hash<>f.criteria_hash OR j.role<>'reproducer' THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='INVALID_REPRODUCTION';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM verdicts v WHERE v.attempt_id=NEW.attempt_id AND v.valid AND NOT EXISTS(SELECT 1 FROM verdict_invalidations i WHERE i.verdict_id=v.id) AND (NEW.outcome<>'reproduced' OR v.document->>'status'='issue_found')) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='REPRODUCTION_VERDICT_MISSING';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reproduction_guard BEFORE INSERT ON reproductions FOR EACH ROW EXECUTE FUNCTION guard_reproduction();
CREATE FUNCTION guard_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='functional' AND NEW.status='confirmed' AND (
  NEW.expected_source='inferred' OR NEW.reproduction_id IS NULL OR NOT EXISTS(SELECT 1 FROM verdicts ov WHERE ov.attempt_id=NEW.original_attempt_id AND ov.valid AND ov.document->>'status'='issue_found' AND NOT EXISTS(SELECT 1 FROM verdict_invalidations i WHERE i.verdict_id=ov.id)) OR NOT EXISTS(
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
CREATE TRIGGER confirmation_guard BEFORE INSERT OR UPDATE ON findings FOR EACH ROW EXECUTE FUNCTION guard_confirmation();
CREATE FUNCTION guard_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_run uuid; expected_task uuid; material artifacts;
BEGIN
 SELECT * INTO material FROM artifacts WHERE id=NEW.artifact_id;
 IF TG_TABLE_NAME='finding_evidence' THEN SELECT f.run_id,a.task_id INTO expected_run,expected_task FROM findings f JOIN case_attempts a ON a.id=f.original_attempt_id WHERE f.id=NEW.finding_id;
 ELSE SELECT run_id,task_id INTO expected_run,expected_task FROM reproductions WHERE id=NEW.reproduction_id; END IF;
 IF material.run_id<>expected_run OR (expected_task IS NOT NULL AND material.task_id<>expected_task) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='EVIDENCE_OWNERSHIP'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER finding_evidence_guard BEFORE INSERT ON finding_evidence FOR EACH ROW EXECUTE FUNCTION guard_evidence();
CREATE TRIGGER reproduction_evidence_guard BEFORE INSERT ON reproduction_evidence FOR EACH ROW EXECUTE FUNCTION guard_evidence();
CREATE FUNCTION allocate_event_seq() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last_seq bigint;
BEGIN
 SELECT event_seq INTO last_seq FROM runs WHERE id=NEW.run_id AND project_id=NEW.project_id FOR UPDATE;
 IF NEW.seq<>last_seq+1 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='EVENT_SEQUENCE'; END IF;
 UPDATE runs SET event_seq=NEW.seq WHERE id=NEW.run_id;
 PERFORM pg_notify('localqa_runs',NEW.run_id::text||':'||NEW.seq::text);
 RETURN NEW;
END $$;
CREATE TRIGGER event_seq BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION allocate_event_seq();
CREATE FUNCTION guard_gc() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.held OR OLD.retain_until>clock_timestamp() OR EXISTS(SELECT 1 FROM runs WHERE id=OLD.run_id AND status NOT IN ('completed','cancelled','failed')) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='RETENTION_PROTECTED'; END IF;
 IF TG_TABLE_NAME='artifacts' AND (
  EXISTS(SELECT 1 FROM artifact_references WHERE artifact_id=OLD.id) OR EXISTS(SELECT 1 FROM finding_evidence WHERE artifact_id=OLD.id) OR
  EXISTS(SELECT 1 FROM reproduction_evidence WHERE artifact_id=OLD.id) OR EXISTS(SELECT 1 FROM exports WHERE artifact_id=OLD.id)
 ) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ARTIFACT_REFERENCED'; END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER artifact_gc BEFORE DELETE ON artifacts FOR EACH ROW EXECUTE FUNCTION guard_gc();
CREATE TRIGGER export_gc BEFORE DELETE ON exports FOR EACH ROW EXECUTE FUNCTION guard_gc();
CREATE FUNCTION guard_export_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.report_snapshot<>OLD.report_snapshot THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='IMMUTABLE_EXPORT_SNAPSHOT'; END IF; RETURN NEW; END $$;
CREATE TRIGGER export_snapshot BEFORE UPDATE ON exports FOR EACH ROW EXECUTE FUNCTION guard_export_snapshot();
CREATE FUNCTION reject_secret_keys(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k text; v jsonb;
BEGIN
 IF jsonb_typeof(value)='object' THEN
  FOR k,v IN SELECT * FROM jsonb_each(value) LOOP
   IF lower(k) IN ('password','apikey','cookie','authorization','onetimecode','storagestate','secretinput','rawurl','rawprompt','token','leasetoken') OR NOT reject_secret_keys(v) THEN RETURN false; END IF;
  END LOOP;
 ELSIF jsonb_typeof(value)='array' THEN
  FOR v IN SELECT * FROM jsonb_array_elements(value) LOOP IF NOT reject_secret_keys(v) THEN RETURN false; END IF; END LOOP;
 END IF;
 RETURN true;
END $$;
ALTER TABLE run_events ADD CHECK(reject_secret_keys(payload));
ALTER TABLE audit_log ADD CHECK(reject_secret_keys(redacted_summary));
ALTER TABLE model_requests ADD CHECK(reject_secret_keys(redacted_diagnostic));
-- Values in free-form text still require upstream RedactionPolicy; key filtering is defense in depth.
CREATE FUNCTION guard_triage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE preview confirmation_previews;
BEGIN
 SELECT * INTO preview FROM confirmation_previews WHERE id=NEW.preview_id FOR UPDATE;
 IF preview.project_id<>NEW.project_id OR preview.finding_id<>NEW.finding_id OR preview.actor_id<>NEW.actor_id OR preview.expires_at<=clock_timestamp() OR preview.consumed_at IS NULL THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='CONFIRMATION_REQUIRED';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER triage_guard BEFORE INSERT ON triage FOR EACH ROW EXECUTE FUNCTION guard_triage();
