-- These roles are server-only. Never grant role membership to browser users.
-- actor/worker scope settings are installed by trusted repository transactions.
CREATE FUNCTION actor_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('localqa.actor_id',true),'')::uuid $$;
CREATE FUNCTION is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.users WHERE id=public.actor_id() AND global_role='admin' AND NOT disabled)
$$;
CREATE FUNCTION project_role(pid uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT pm.role FROM public.project_members pm JOIN public.users u ON u.id=pm.user_id WHERE pm.project_id=pid AND u.id=public.actor_id() AND NOT u.disabled
$$;
CREATE FUNCTION can_project(pid uuid,minimum text DEFAULT 'viewer') RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.is_admin() OR CASE minimum WHEN 'owner' THEN public.project_role(pid)='owner' WHEN 'operator' THEN public.project_role(pid) IN ('owner','operator') ELSE public.project_role(pid) IN ('owner','operator','viewer') END
$$;
CREATE FUNCTION can_model(mid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.is_admin() OR EXISTS(SELECT 1 FROM public.model_profile_grants g WHERE g.profile_id=mid AND public.can_project(g.project_id))
$$;
CREATE FUNCTION worker_project(pid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT pid=nullif(current_setting('localqa.worker_project',true),'')::uuid
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON FUNCTION actor_id(),is_admin(),project_role(uuid),can_project(uuid,text),can_model(uuid),worker_project(uuid),reject_secret_keys(jsonb) TO localqa_app,localqa_auth,localqa_worker;
GRANT USAGE ON SCHEMA public TO localqa_app,localqa_auth,localqa_worker;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE login_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY user_read ON users FOR SELECT TO localqa_app USING(is_admin() OR (id=actor_id() AND NOT disabled));
CREATE POLICY user_admin_write ON users FOR ALL TO localqa_app USING(is_admin()) WITH CHECK(is_admin());
CREATE POLICY user_auth ON users FOR ALL TO localqa_auth USING(true) WITH CHECK(true);
CREATE POLICY session_auth ON login_sessions FOR ALL TO localqa_auth USING(true) WITH CHECK(true);
CREATE POLICY session_self ON login_sessions FOR SELECT TO localqa_app USING(user_id=actor_id() OR is_admin());
GRANT SELECT(id,email,display_name,global_role,disabled,version),INSERT,UPDATE ON users TO localqa_app;
GRANT SELECT,INSERT,UPDATE ON users,login_sessions TO localqa_auth;
GRANT SELECT,UPDATE ON bootstrap_state TO localqa_auth;
GRANT SELECT ON login_sessions TO localqa_app;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
CREATE POLICY project_read ON projects FOR SELECT TO localqa_app USING(can_project(id));
CREATE POLICY project_insert ON projects FOR INSERT TO localqa_app WITH CHECK(is_admin());
CREATE POLICY project_update ON projects FOR UPDATE TO localqa_app USING(can_project(id,'owner')) WITH CHECK(can_project(id,'owner'));
CREATE POLICY project_worker ON projects FOR SELECT TO localqa_worker USING(worker_project(id));
GRANT SELECT,INSERT,UPDATE ON projects TO localqa_app;
GRANT SELECT ON projects TO localqa_worker;
DO $$ DECLARE t text; level text; BEGIN
 FOREACH t IN ARRAY ARRAY['project_members','model_profile_grants','secrets','secret_versions','environments','environment_versions','auth_profiles','auth_profile_versions','knowledge','knowledge_versions','runs','run_context_versions','run_model_bindings','run_knowledge_bindings','run_budgets','budget_reservations','run_cases','jobs','task_leases','case_attempts','verdicts','page_snapshots','controls','action_intents','steps','findings','reproductions','artifacts','finding_evidence','reproduction_evidence','artifact_references','exports','input_requests','run_messages','run_events','model_requests','confirmation_previews','triage','request_idempotency','schedule_occurrences'] LOOP
  level:=CASE WHEN t IN ('project_members','model_profile_grants','secrets','secret_versions','environments','environment_versions','auth_profiles','auth_profile_versions') THEN 'owner' ELSE 'operator' END;
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY member_read ON %I FOR SELECT TO localqa_app USING(can_project(project_id,%L))',t,CASE WHEN t='secret_versions' THEN 'owner' ELSE 'viewer' END);
  EXECUTE format('CREATE POLICY member_insert ON %I FOR INSERT TO localqa_app WITH CHECK(can_project(project_id,%L))',t,level);
  EXECUTE format('CREATE POLICY member_update ON %I FOR UPDATE TO localqa_app USING(can_project(project_id,%L)) WITH CHECK(can_project(project_id,%L))',t,level,level);
  EXECUTE format('CREATE POLICY member_delete ON %I FOR DELETE TO localqa_app USING(can_project(project_id,%L))',t,level);
  EXECUTE format('CREATE POLICY worker_scope ON %I FOR ALL TO localqa_worker USING(worker_project(project_id)) WITH CHECK(worker_project(project_id))',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO localqa_app',t);
  -- Worker grants are narrowed below; scope policies never grant privilege themselves.
 END LOOP;
END $$;
GRANT SELECT ON runs,run_cases,run_budgets,budget_reservations,run_context_versions,auth_profiles,auth_profile_versions,secrets,secret_versions,artifacts,findings,reproductions,verdicts,case_attempts,action_intents TO localqa_worker;
GRANT SELECT,INSERT,UPDATE ON jobs,task_leases TO localqa_worker;
GRANT INSERT,UPDATE ON action_intents,budget_reservations,run_budgets TO localqa_worker;
GRANT INSERT ON case_attempts,verdicts,run_events TO localqa_worker;
GRANT UPDATE ON case_attempts,run_cases TO localqa_worker;
GRANT UPDATE(event_seq) ON runs TO localqa_worker;
GRANT SELECT ON final_valid_verdicts TO localqa_app,localqa_worker;
ALTER TABLE model_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE model_profile_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_profile_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY model_read ON model_profiles FOR SELECT TO localqa_app USING(can_model(id));
CREATE POLICY model_admin ON model_profiles FOR ALL TO localqa_app USING(is_admin()) WITH CHECK(is_admin());
CREATE POLICY model_version_read ON model_profile_versions FOR SELECT TO localqa_app USING(can_model(profile_id));
CREATE POLICY model_version_admin ON model_profile_versions FOR ALL TO localqa_app USING(is_admin()) WITH CHECK(is_admin());
CREATE POLICY platform_secret_admin ON platform_secrets FOR ALL TO localqa_app USING(is_admin()) WITH CHECK(is_admin());
GRANT SELECT,INSERT,UPDATE ON model_profiles TO localqa_app;
GRANT SELECT,INSERT ON model_profile_versions TO localqa_app;
GRANT SELECT,INSERT ON platform_secrets TO localqa_app;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON audit_log FOR SELECT TO localqa_app USING(is_admin() OR (project_id IS NOT NULL AND can_project(project_id,'owner')));
CREATE POLICY audit_insert ON audit_log FOR INSERT TO localqa_app WITH CHECK(actor_id=public.actor_id() AND (is_admin() OR (project_id IS NOT NULL AND can_project(project_id))));
CREATE POLICY audit_auth ON audit_log FOR INSERT TO localqa_auth WITH CHECK(project_id IS NULL);
CREATE POLICY audit_worker ON audit_log FOR INSERT TO localqa_worker WITH CHECK(worker_project(project_id));
GRANT SELECT,INSERT ON audit_log TO localqa_app;
GRANT INSERT ON audit_log TO localqa_auth,localqa_worker;
-- An owner must remain. Deferred check supports replacing the full list atomically.
CREATE FUNCTION require_owner() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE pid uuid;
BEGIN
 pid:=COALESCE(NEW.project_id,OLD.project_id);
 IF EXISTS(SELECT 1 FROM public.projects WHERE id=pid) AND NOT EXISTS(SELECT 1 FROM public.project_members WHERE project_id=pid AND role='owner') THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='LAST_OWNER';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER owner_remains AFTER INSERT OR UPDATE OR DELETE ON project_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_owner();
CREATE FUNCTION revoke_disabled_sessions() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.disabled OR NEW.password_hash<>OLD.password_hash THEN UPDATE public.login_sessions SET revoked_at=clock_timestamp() WHERE user_id=NEW.id AND revoked_at IS NULL; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER user_revoke AFTER UPDATE ON users FOR EACH ROW EXECUTE FUNCTION revoke_disabled_sessions();
