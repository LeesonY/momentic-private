-- A deleted project must not erase immutable audit history. Keep the historical
-- project UUID in audit_log even after the project row is gone. The audit table
-- remains append-only; its immutable trigger and RLS are unchanged.
ALTER TABLE audit_log DROP CONSTRAINT audit_log_project_id_fkey;

-- Only an enabled global administrator in an authenticated application
-- transaction may permanently delete an EMPTY project. Every currently
-- installed project-scoped base table is checked, including future tables
-- with a project_id column. This does not cascade through runs or secrets.
CREATE FUNCTION remove_empty_project(
  pid uuid, expected_version integer, confirmed_name text
) RETURNS text
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
  IF expected_version IS NULL OR expected_version < 1
     OR confirmed_name IS NULL OR length(confirmed_name) > 120
  THEN
    RETURN 'invalid_confirmation';
  END IF;

  -- The lock also blocks new FK-dependent inserts until commit. A stale tab
  -- cannot delete a modified project even when its name is unchanged.
  SELECT id, name, version, default_model_profile_id
    INTO existing
    FROM public.projects WHERE id=pid FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF existing.version <> expected_version THEN RETURN 'version_conflict'; END IF;
  IF existing.name <> confirmed_name THEN RETURN 'invalid_confirmation'; END IF;
  IF existing.default_model_profile_id IS NOT NULL THEN RETURN 'not_empty'; END IF;

  -- A fresh project contains exactly one creator/owner; existing member
  -- collaboration should not be silently erased.
  IF (SELECT count(*) FROM public.project_members WHERE project_id=pid) <> 1
  THEN RETURN 'not_empty'; END IF;

  -- Every project-scoped table except the immutable audit trail and the
  -- creator/owner link makes the project ineligible for hard deletion.
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
    IF has_data THEN RETURN 'not_empty'; END IF;
  END LOOP;

  DELETE FROM public.project_members WHERE project_id=pid;
  DELETE FROM public.projects WHERE id=pid;
  -- Preserve the action and UUID without a dangling FK. The audit row is
  -- immutable; do not attempt to UPDATE/DELETE it.
  INSERT INTO public.audit_log(
    project_id,actor_id,action,object_id,result,redacted_summary
  ) VALUES (
    NULL,public.actor_id(),'project.deleted',pid,'success',
    jsonb_build_object('empty_project',true)
  );
  RETURN 'deleted';
END $$;
REVOKE ALL ON FUNCTION remove_empty_project(uuid,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION remove_empty_project(uuid,integer,text) TO localqa_app;
