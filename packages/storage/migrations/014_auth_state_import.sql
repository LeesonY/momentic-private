-- AUTH-9A private, one-shot importer state preparation/execution ledger.
ALTER TABLE auth_execution_sessions ADD COLUMN import_auth_state_id uuid REFERENCES run_auth_states(id);

CREATE TABLE auth_import_grants (
  id uuid PRIMARY KEY REFERENCES action_intents(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  task_id uuid NOT NULL,
  auth_session_id uuid NOT NULL UNIQUE REFERENCES auth_execution_sessions(id) ON DELETE CASCADE,
  auth_state_id uuid NOT NULL REFERENCES run_auth_states(id),
  state_fingerprint text NOT NULL CHECK (state_fingerprint ~ '^[0-9a-f]{64}$'),
  worker_id text NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token >= 1),
  context_version integer NOT NULL CHECK (context_version >= 1),
  context_id uuid NOT NULL,
  auth_profile_id uuid NOT NULL,
  auth_profile_version integer NOT NULL CHECK (auth_profile_version >= 1),
  auth_epoch integer NOT NULL CHECK (auth_epoch >= 1),
  status text NOT NULL CHECK (status IN ('issued','prepared','started','completed','ended')),
  deadline timestamptz NOT NULL,
  receipt_hash text CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
  result_hash text CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  prepared_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  ended_at timestamptz,
  FOREIGN KEY (project_id,run_id) REFERENCES runs(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY (project_id,run_id,task_id) REFERENCES jobs(project_id,run_id,id) ON DELETE CASCADE,
  FOREIGN KEY (project_id,auth_profile_id,auth_profile_version) REFERENCES auth_profile_versions(project_id,auth_profile_id,version)
);
ALTER TABLE auth_import_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_import_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_import_grants_admin ON auth_import_grants FOR ALL TO localqa_app
  USING (is_admin()) WITH CHECK (is_admin());
GRANT SELECT,INSERT,UPDATE,DELETE ON auth_import_grants TO localqa_app;

-- Existing service-admin interruption/recovery ends each task's sessions and
-- settles its reservations conservatively. Mirror ONLY that session lifecycle;
-- never revoke the run's state, sibling sessions, or granted exclusive run lock.
CREATE FUNCTION end_auth_import_grants() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.purpose='importer' AND NEW.status IN ('ended','revoked') THEN
    UPDATE auth_import_grants SET status='ended',ended_at=clock_timestamp()
      WHERE auth_session_id=NEW.id AND status<>'ended';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER auth_import_session_ended AFTER UPDATE OF status ON auth_execution_sessions
  FOR EACH ROW EXECUTE FUNCTION end_auth_import_grants();
