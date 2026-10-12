-- Retain frozen versions and run history while removing current configuration.
ALTER TABLE environments ADD COLUMN deleted_at timestamptz;
ALTER TABLE auth_profiles ADD COLUMN deleted_at timestamptz;

-- New references lock the live head, serializing with deletion checks.
CREATE FUNCTION require_live_config_reference() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE eid uuid; aid uuid;
BEGIN
 IF TG_TABLE_NAME='runs' THEN
  eid:=NEW.environment_id; aid:=NEW.auth_profile_id;
 ELSIF TG_TABLE_NAME='schedules' THEN
  IF NOT NEW.enabled THEN RETURN NEW; END IF;
  eid:=NULLIF(NEW.run_template->>'environmentId','')::uuid;
  aid:=NULLIF(NEW.run_template->>'authProfileId','')::uuid;
  IF aid IS NULL AND eid IS NOT NULL THEN
   SELECT v.default_auth_profile_id INTO aid FROM public.environments e
   JOIN public.environment_versions v ON v.project_id=e.project_id AND v.environment_id=e.id AND v.version=e.version
   WHERE e.project_id=NEW.project_id AND e.id=eid;
  END IF;
 ELSIF TG_TABLE_NAME='auth_profile_versions' THEN
  eid:=NEW.environment_id;
 ELSE
  aid:=NEW.default_auth_profile_id;
 END IF;
 IF eid IS NOT NULL THEN
  PERFORM 1 FROM public.environments WHERE project_id=NEW.project_id AND id=eid AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TARGET_NOT_ALLOWED' USING ERRCODE='P0001'; END IF;
 END IF;
 IF aid IS NOT NULL THEN
  PERFORM 1 FROM public.auth_profiles WHERE project_id=NEW.project_id AND id=aid AND deleted_at IS NULL AND NOT revoked FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_REVOKED' USING ERRCODE='P0001'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION require_live_config_reference() FROM PUBLIC;
CREATE TRIGGER live_run_config BEFORE INSERT ON runs FOR EACH ROW EXECUTE FUNCTION require_live_config_reference();
CREATE TRIGGER live_schedule_config BEFORE INSERT OR UPDATE OF enabled,run_template ON schedules FOR EACH ROW EXECUTE FUNCTION require_live_config_reference();
CREATE TRIGGER live_auth_environment BEFORE INSERT ON auth_profile_versions FOR EACH ROW EXECUTE FUNCTION require_live_config_reference();
CREATE TRIGGER live_environment_auth BEFORE INSERT ON environment_versions FOR EACH ROW EXECUTE FUNCTION require_live_config_reference();
