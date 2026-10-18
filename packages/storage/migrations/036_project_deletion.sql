-- 036_project_deletion.sql
-- A project can be deleted even when it holds data. Empty projects keep the
-- original physical deletion; non-empty projects are soft-deleted: every
-- project-scoped read is hidden through can_project, enabled schedules stop,
-- API keys are revoked and the default model is cleared. Data stays in place
-- for audit and is not restorable from the UI.

ALTER TABLE projects ADD COLUMN deleted_at timestamptz;

-- A deleted project is invisible to everyone, including platform admins, so
-- every member_read policy that calls can_project hides the project and all of
-- its child rows. The projects table itself uses this function through its
-- project_read policy.
--
-- We check deleted_at only when the project row exists. If no row exists (such
-- as a newly inserted row being checked under RLS before commit or inside an
-- INSERT ... RETURNING statement), deleted_at IS NOT NULL is false, so it falls
-- through to the normal admin/member check.
CREATE OR REPLACE FUNCTION can_project(pid uuid,minimum text DEFAULT 'viewer') RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  del timestamptz;
BEGIN
  SELECT deleted_at INTO del FROM public.projects WHERE id=pid;
  IF FOUND AND del IS NOT NULL THEN
    RETURN false;
  END IF;
  RETURN public.is_admin() OR CASE minimum WHEN 'owner' THEN public.project_role(pid)='owner' WHEN 'operator' THEN public.project_role(pid) IN ('owner','operator') ELSE public.project_role(pid) IN ('owner','operator','viewer') END;
END $$;

-- A deleted project must not accept new runs. Deleted is reported as
-- NOT_FOUND (42501) so the project does not leak; archived keeps 409.
CREATE OR REPLACE FUNCTION guard_run_project() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE state text; deleted timestamptz;
BEGIN
 SELECT status,deleted_at INTO state,deleted FROM public.projects WHERE id=NEW.project_id FOR SHARE;
 IF deleted IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='NOT_FOUND'; END IF;
 IF state='archived' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='PROJECT_ARCHIVED'; END IF;
 RETURN NEW;
END $$;

-- The original empty-project condition, without deleting anything. Kept in
-- sync with remove_empty_project so the preview's `empty` flag predicts the
-- hard-delete path exactly.
CREATE FUNCTION project_is_empty(pid uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  existing record;
  scoped record;
  has_data boolean;
BEGIN
  IF current_setting('role', true) IS DISTINCT FROM 'localqa_app'
     OR NOT public.is_admin()
  THEN
    RAISE insufficient_privilege USING MESSAGE='platform admin required';
  END IF;

  SELECT default_model_profile_id INTO existing
    FROM public.projects WHERE id=pid AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  IF existing.default_model_profile_id IS NOT NULL THEN RETURN false; END IF;
  IF (SELECT count(*) FROM public.project_members WHERE project_id=pid) <> 1
  THEN RETURN false; END IF;

  FOR scoped IN
    SELECT c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
     WHERE c.relnamespace='public'::regnamespace
       AND c.relkind IN ('r','p')
       AND NOT c.relispartition
       AND a.attname='project_id' AND NOT a.attisdropped
       AND c.relname NOT IN ('projects','project_members','audit_log')
  LOOP
    EXECUTE format(
      'SELECT EXISTS(SELECT 1 FROM public.%I WHERE project_id=$1)',
      scoped.relname
    ) INTO has_data USING pid;
    IF has_data THEN RETURN false; END IF;
  END LOOP;

  RETURN true;
END $$;

-- Delete a project under a row lock after exact name/version confirmation.
-- Empty projects are physically removed by remove_empty_project; non-empty
-- projects are hidden, their schedules disabled, their API keys revoked and
-- their default model cleared. Active runs refuse the whole operation.
CREATE FUNCTION delete_project(
  pid uuid, expected_version integer, confirmed_name text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  existing record;
  active_runs integer;
  run_count integer;
BEGIN
  IF current_setting('role', true) IS DISTINCT FROM 'localqa_app'
     OR NOT public.is_admin()
  THEN
    RAISE insufficient_privilege USING MESSAGE='platform admin required';
  END IF;
  IF expected_version IS NULL OR expected_version < 1
     OR confirmed_name IS NULL OR length(confirmed_name) > 120
  THEN
    RETURN 'invalid_confirmation';
  END IF;

  SELECT id,name,version,status,deleted_at INTO existing
    FROM public.projects WHERE id=pid FOR UPDATE;
  IF NOT FOUND OR existing.deleted_at IS NOT NULL THEN RETURN 'not_found'; END IF;
  IF existing.version <> expected_version THEN RETURN 'version_conflict'; END IF;
  IF existing.name <> confirmed_name THEN RETURN 'invalid_confirmation'; END IF;

  IF public.project_is_empty(pid) THEN
    RETURN public.remove_empty_project(pid, expected_version, confirmed_name);
  END IF;

  SELECT count(*) INTO active_runs
    FROM public.runs
   WHERE project_id=pid AND status NOT IN ('completed','cancelled','failed');
  IF active_runs > 0 THEN RETURN 'active_runs'; END IF;

  SELECT count(*) INTO run_count FROM public.runs WHERE project_id=pid;

  UPDATE public.projects
     SET deleted_at=clock_timestamp(),default_model_profile_id=NULL,version=version+1
   WHERE id=pid AND version=expected_version;
  UPDATE public.schedules
     SET enabled=false,version=version+1
   WHERE project_id=pid AND enabled;
  UPDATE public.api_keys
     SET revoked_at=clock_timestamp()
   WHERE project_id=pid AND revoked_at IS NULL;

  INSERT INTO public.audit_log(
    project_id,actor_id,action,object_id,result,redacted_summary
  ) VALUES (
    pid,public.actor_id(),'project.deleted',pid,'success',
    jsonb_build_object('empty',false,'runs',run_count)
  );
  RETURN 'deleted';
END $$;

REVOKE ALL ON FUNCTION project_is_empty(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION delete_project(uuid,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION project_is_empty(uuid) TO localqa_app;
GRANT EXECUTE ON FUNCTION delete_project(uuid,integer,text) TO localqa_app;
