CREATE FUNCTION patch_user(uid uuid,expected integer,new_name text,new_disabled boolean,new_role text,new_hash text)
 RETURNS TABLE(id uuid,email text,display_name text,global_role text,disabled boolean,version integer)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT public.is_admin() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='FORBIDDEN'; END IF;
 RETURN QUERY UPDATE public.users u SET display_name=COALESCE(new_name,u.display_name),disabled=COALESCE(new_disabled,u.disabled),
  global_role=COALESCE(new_role,u.global_role),password_hash=COALESCE(new_hash,u.password_hash),version=u.version+1
  WHERE u.id=uid AND u.version=expected RETURNING u.id,u.email,u.display_name,u.global_role,u.disabled,u.version;
END $$;
REVOKE ALL ON FUNCTION patch_user(uuid,integer,text,boolean,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION patch_user(uuid,integer,text,boolean,text,text) TO localqa_app;
CREATE FUNCTION guard_run_project() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE state text;
BEGIN
 SELECT status INTO state FROM public.projects WHERE id=NEW.project_id FOR SHARE;
 IF state='archived' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='PROJECT_ARCHIVED'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_run_project() FROM PUBLIC;
CREATE TRIGGER run_project BEFORE INSERT ON runs FOR EACH ROW EXECUTE FUNCTION guard_run_project();
ALTER TABLE environments ADD FOREIGN KEY(project_id,id,version) REFERENCES environment_versions(project_id,environment_id,version) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE auth_profiles ADD FOREIGN KEY(project_id,id,version) REFERENCES auth_profile_versions(project_id,auth_profile_id,version) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge ADD FOREIGN KEY(project_id,id,version) REFERENCES knowledge_versions(project_id,knowledge_id,version) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE secrets ADD FOREIGN KEY(project_id,id,version) REFERENCES secret_versions(project_id,secret_id,version) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE model_profiles ADD FOREIGN KEY(id,version) REFERENCES model_profile_versions(profile_id,version) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE request_idempotency ADD FOREIGN KEY(project_id,result_id) REFERENCES runs(project_id,id);
ALTER TABLE budget_reservations ADD UNIQUE(project_id,run_id,task_id,id);
ALTER TABLE action_intents ADD FOREIGN KEY(project_id,run_id,task_id,reservation_id) REFERENCES budget_reservations(project_id,run_id,task_id,id);
ALTER TABLE model_requests ADD FOREIGN KEY(project_id,run_id,task_id,reservation_id) REFERENCES budget_reservations(project_id,run_id,task_id,id);
ALTER TABLE steps ADD UNIQUE(project_id,run_id,task_id,id);
ALTER TABLE page_snapshots ADD UNIQUE(project_id,run_id,task_id,id);
ALTER TABLE artifacts ADD CHECK(step_id IS NULL OR task_id IS NOT NULL);
ALTER TABLE artifacts ADD CHECK(snapshot_id IS NULL OR task_id IS NOT NULL);
ALTER TABLE artifacts ADD FOREIGN KEY(project_id,run_id,task_id,step_id) REFERENCES steps(project_id,run_id,task_id,id);
ALTER TABLE artifacts ADD FOREIGN KEY(project_id,run_id,task_id,snapshot_id) REFERENCES page_snapshots(project_id,run_id,task_id,id);
ALTER TABLE jobs ADD COLUMN result jsonb;
ALTER TABLE jobs ADD CHECK(result IS NULL OR reject_secret_keys(result));
CREATE TRIGGER finding_evidence_immutable BEFORE UPDATE OR DELETE ON finding_evidence FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER reproduction_evidence_immutable BEFORE UPDATE OR DELETE ON reproduction_evidence FOR EACH ROW EXECUTE FUNCTION reject_mutation();
-- Operator-created URL secrets are write-only; raw queries never enter Run/SSE DTOs.
DROP POLICY member_insert ON model_profile_grants;
DROP POLICY member_update ON model_profile_grants;
DROP POLICY member_delete ON model_profile_grants;
CREATE POLICY grant_insert ON model_profile_grants FOR INSERT TO localqa_app WITH CHECK(is_admin());
CREATE POLICY grant_update ON model_profile_grants FOR UPDATE TO localqa_app USING(is_admin()) WITH CHECK(is_admin());
CREATE POLICY grant_delete ON model_profile_grants FOR DELETE TO localqa_app USING(is_admin());
DROP POLICY member_insert ON secrets;
CREATE POLICY member_insert ON secrets FOR INSERT TO localqa_app WITH CHECK(can_project(project_id,'owner') OR (purpose='run_url' AND can_project(project_id,'operator')));
DROP POLICY member_insert ON secret_versions;
CREATE POLICY member_insert ON secret_versions FOR INSERT TO localqa_app WITH CHECK(can_project(project_id,'owner') OR (can_project(project_id,'operator') AND EXISTS(SELECT 1 FROM secrets WHERE id=secret_id AND project_id=secret_versions.project_id AND purpose='run_url')));
CREATE FUNCTION guard_knowledge_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.document->>'approved'='true' AND current_user='localqa_app' AND NOT can_project(NEW.project_id,'owner') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='FORBIDDEN'; END IF; RETURN NEW; END $$;
CREATE TRIGGER knowledge_approval BEFORE INSERT ON knowledge_versions FOR EACH ROW EXECUTE FUNCTION guard_knowledge_approval();
CREATE FUNCTION guard_finding_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM run_cases WHERE id=NEW.case_id AND criteria_hash=NEW.criteria_hash) OR
 (NEW.document->>'id') IS DISTINCT FROM NEW.id::text OR (NEW.document->>'runId') IS DISTINCT FROM NEW.run_id::text OR (NEW.document->>'kind') IS DISTINCT FROM NEW.kind OR
 (NEW.document->>'status') IS DISTINCT FROM NEW.status OR (NEW.document->>'expectedSource') IS DISTINCT FROM NEW.expected_source OR (NEW.document->>'version')::integer IS DISTINCT FROM NEW.version OR NOT COALESCE((NEW.document->'caseIds') @> jsonb_build_array(NEW.case_id::text),false) OR
 (NEW.document->>'reproductionRef') IS DISTINCT FROM NEW.reproduction_id::text THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='FINDING_BINDING';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER finding_binding BEFORE INSERT OR UPDATE ON findings FOR EACH ROW EXECUTE FUNCTION guard_finding_binding();
CREATE FUNCTION guard_reproduction_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.document->>'id') IS DISTINCT FROM NEW.id::text OR (NEW.document->>'findingId') IS DISTINCT FROM NEW.finding_id::text OR (NEW.document->>'taskId') IS DISTINCT FROM NEW.task_id::text OR (NEW.document->>'outcome') IS DISTINCT FROM NEW.outcome OR (NEW.document->>'freshContext') IS DISTINCT FROM 'true' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='REPRODUCTION_BINDING'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reproduction_binding BEFORE INSERT ON reproductions FOR EACH ROW EXECUTE FUNCTION guard_reproduction_document();
CREATE FUNCTION guard_artifact_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.document->>'id') IS DISTINCT FROM NEW.id::text OR (NEW.document->>'projectId') IS DISTINCT FROM NEW.project_id::text OR (NEW.document->>'runId') IS DISTINCT FROM NEW.run_id::text OR
 (NEW.document->>'taskId') IS DISTINCT FROM NEW.task_id::text OR (NEW.document->>'stepId') IS DISTINCT FROM NEW.step_id::text OR
 (NEW.document->>'caseId') IS DISTINCT FROM NEW.case_id::text OR (NEW.document->>'snapshotId') IS DISTINCT FROM NEW.snapshot_id::text THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ARTIFACT_BINDING'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER artifact_binding BEFORE INSERT OR UPDATE ON artifacts FOR EACH ROW EXECUTE FUNCTION guard_artifact_document();
CREATE TABLE verdict_invalidations (
 project_id uuid NOT NULL, verdict_id uuid PRIMARY KEY, reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(project_id,verdict_id) REFERENCES verdicts(project_id,id)
);
ALTER TABLE verdict_invalidations ENABLE ROW LEVEL SECURITY;
ALTER TABLE verdict_invalidations FORCE ROW LEVEL SECURITY;
CREATE POLICY invalidation_read ON verdict_invalidations FOR SELECT TO localqa_app USING(can_project(project_id));
CREATE POLICY invalidation_write ON verdict_invalidations FOR INSERT TO localqa_app WITH CHECK(can_project(project_id,'operator'));
CREATE POLICY invalidation_worker ON verdict_invalidations FOR SELECT TO localqa_worker USING(worker_project(project_id));
GRANT SELECT,INSERT ON verdict_invalidations TO localqa_app;
GRANT SELECT ON verdict_invalidations TO localqa_worker;
CREATE FUNCTION guard_invalidation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM findings f JOIN verdicts v ON v.attempt_id=f.original_attempt_id WHERE v.id=NEW.verdict_id AND f.kind='functional' AND f.status='confirmed')
 OR EXISTS(SELECT 1 FROM findings f JOIN reproductions r ON r.id=f.reproduction_id JOIN verdicts v ON v.attempt_id=r.attempt_id WHERE v.id=NEW.verdict_id AND f.kind='functional' AND f.status='confirmed') THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='DOWNGRADE_CONFIRMATION_BEFORE_INVALIDATION';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER invalidation_guard BEFORE INSERT ON verdict_invalidations FOR EACH ROW EXECUTE FUNCTION guard_invalidation();
CREATE TRIGGER invalidation_immutable BEFORE UPDATE OR DELETE ON verdict_invalidations FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE OR REPLACE VIEW final_valid_verdicts WITH (security_invoker=true) AS
 SELECT DISTINCT ON (v.project_id,v.case_id) v.* FROM verdicts v JOIN case_attempts a ON a.id=v.attempt_id JOIN jobs j ON j.id=a.task_id
 WHERE v.valid AND j.role<>'reproducer' AND NOT EXISTS(SELECT 1 FROM verdict_invalidations i WHERE i.verdict_id=v.id)
 ORDER BY v.project_id,v.case_id,a.attempt_number DESC;
ALTER TABLE runs ADD CHECK(reject_secret_keys(effective_config));
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['environment_versions','auth_profile_versions','model_profile_versions','knowledge_versions','run_cases','jobs','page_snapshots','steps','findings','reproductions','artifacts','exports','input_requests'] LOOP
  EXECUTE format('ALTER TABLE %I ADD CHECK(reject_secret_keys(document))',t);
 END LOOP;
END $$;
CREATE FUNCTION guard_case_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.document->>'id') IS DISTINCT FROM NEW.id::text OR (NEW.document->>'projectId') IS DISTINCT FROM NEW.project_id::text OR (NEW.document->>'runId') IS DISTINCT FROM NEW.run_id::text OR
 (SELECT count(*) FROM jsonb_array_elements(NEW.document->'criteria'))<>(SELECT count(DISTINCT c->>'id') FROM jsonb_array_elements(NEW.document->'criteria') c) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='CASE_BINDING';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER case_binding BEFORE INSERT OR UPDATE ON run_cases FOR EACH ROW EXECUTE FUNCTION guard_case_binding();
CREATE FUNCTION guard_version_document() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE data jsonb; expected_id text; id_key text;
BEGIN
 data:=to_jsonb(NEW);
 id_key:=CASE TG_TABLE_NAME WHEN 'environment_versions' THEN 'environment_id' WHEN 'auth_profile_versions' THEN 'auth_profile_id' WHEN 'knowledge_versions' THEN 'knowledge_id' ELSE 'profile_id' END;
 expected_id:=data->>id_key;
 IF (NEW.document->>'id') IS DISTINCT FROM expected_id OR (NEW.document->>'version')::integer IS DISTINCT FROM NEW.version
 OR (TG_TABLE_NAME<>'model_profile_versions' AND (NEW.document->>'projectId') IS DISTINCT FROM (data->>'project_id')) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='VERSION_DOCUMENT_BINDING';
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['environment_versions','auth_profile_versions','knowledge_versions','model_profile_versions'] LOOP
  EXECUTE format('CREATE TRIGGER version_document BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION guard_version_document()',t);
 END LOOP;
END $$;
ALTER TABLE confirmation_previews ADD COLUMN approved_body jsonb NOT NULL;
CREATE FUNCTION guard_preview_immutability() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF (to_jsonb(NEW)-'consumed_at')<>(to_jsonb(OLD)-'consumed_at') OR OLD.consumed_at IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='IMMUTABLE_PREVIEW'; END IF; RETURN NEW; END $$;
CREATE TRIGGER preview_immutable BEFORE UPDATE ON confirmation_previews FOR EACH ROW EXECUTE FUNCTION guard_preview_immutability();
CREATE OR REPLACE FUNCTION guard_triage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE preview confirmation_previews;
BEGIN
 SELECT * INTO preview FROM confirmation_previews WHERE id=NEW.preview_id FOR UPDATE;
 IF preview.project_id<>NEW.project_id OR preview.finding_id<>NEW.finding_id OR preview.actor_id<>NEW.actor_id OR preview.expires_at<=clock_timestamp() OR preview.consumed_at IS NULL
 OR preview.expected_version<>(NEW.document->>'expectedVersion')::integer OR preview.approved_body<>(NEW.document-'confirmationToken') THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='CONFIRMATION_REQUIRED';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION require_owner(),revoke_disabled_sessions() FROM PUBLIC;
