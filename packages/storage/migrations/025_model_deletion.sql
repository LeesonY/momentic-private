-- Keep immutable versions, credentials and run bindings for historical records.
ALTER TABLE model_profiles ADD COLUMN deleted_at timestamptz;

-- Serialize new references with deletion, including stale requests whose model
-- selection happened in a different transaction. Historical references remain.
CREATE FUNCTION require_live_model_reference() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $$
DECLARE
  pid uuid;
BEGIN
  IF TG_TABLE_NAME='projects' THEN
    pid := NEW.default_model_profile_id;
  ELSIF TG_TABLE_NAME='schedules' THEN
    IF NOT NEW.enabled THEN RETURN NEW; END IF;
    pid := NULLIF(NEW.run_template->>'modelProfileId','')::uuid;
    IF pid IS NULL THEN
      SELECT default_model_profile_id INTO pid FROM public.projects WHERE id=NEW.project_id;
    END IF;
    IF pid IS NULL THEN
      SELECT g.profile_id INTO pid FROM public.model_profile_grants g
      JOIN public.model_profiles m ON m.id=g.profile_id
      WHERE g.project_id=NEW.project_id AND m.deleted_at IS NULL
      ORDER BY g.profile_id LIMIT 1;
    END IF;
  ELSE
    pid := NEW.profile_id;
  END IF;
  IF pid IS NULL THEN RETURN NEW; END IF;
  PERFORM 1 FROM public.model_profiles WHERE id=pid AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MODEL_NOT_CONFIGURED' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION require_live_model_reference() FROM PUBLIC;
CREATE TRIGGER live_model_grant BEFORE INSERT ON model_profile_grants
  FOR EACH ROW EXECUTE FUNCTION require_live_model_reference();
CREATE TRIGGER live_run_model BEFORE INSERT ON run_model_bindings
  FOR EACH ROW EXECUTE FUNCTION require_live_model_reference();
CREATE TRIGGER live_project_model BEFORE INSERT OR UPDATE OF default_model_profile_id ON projects
  FOR EACH ROW EXECUTE FUNCTION require_live_model_reference();
CREATE TRIGGER live_schedule_model BEFORE INSERT OR UPDATE OF enabled,run_template ON schedules
  FOR EACH ROW EXECUTE FUNCTION require_live_model_reference();
