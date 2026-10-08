-- 011_auth_execution_sessions.sql
-- AUTH-5 server-side auth execution sessions and run auth scopes.
-- Strictly internal service tables protected by RLS; localqa_app admin only.

-- 1. Run auth scope table: exactly one scope row per run requiring authentication
CREATE TABLE run_auth_scopes (
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  auth_profile_id uuid NOT NULL,
  auth_profile_version integer NOT NULL CHECK (auth_profile_version >= 1),
  context_version integer NOT NULL CHECK (context_version >= 1),
  auth_epoch integer NOT NULL DEFAULT 1 CHECK (auth_epoch >= 1),
  status text NOT NULL CHECK (status IN ('initializing', 'granted', 'revoked')),
  current_state_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, run_id),
  FOREIGN KEY (project_id, run_id) REFERENCES runs(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, auth_profile_id) REFERENCES auth_profiles(project_id, id),
  FOREIGN KEY (project_id, auth_profile_id, auth_profile_version)
    REFERENCES auth_profile_versions(project_id, auth_profile_id, version)
);

ALTER TABLE run_auth_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_auth_scopes FORCE ROW LEVEL SECURITY;

CREATE POLICY run_auth_scopes_admin_all ON run_auth_scopes
  FOR ALL TO localqa_app
  USING (is_admin())
  WITH CHECK (is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON run_auth_scopes TO localqa_app;

-- 2. Auth execution sessions table: exactly one session allocated per (task_id, fencing_token)
CREATE TABLE auth_execution_sessions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  task_id uuid NOT NULL,
  worker_id text NOT NULL CHECK (length(worker_id) <= 200),
  fencing_token bigint NOT NULL CHECK (fencing_token >= 1),
  context_version integer NOT NULL CHECK (context_version >= 1),
  context_id uuid NOT NULL,
  auth_profile_id uuid NOT NULL,
  auth_profile_version integer NOT NULL CHECK (auth_profile_version >= 1),
  auth_epoch integer NOT NULL CHECK (auth_epoch >= 1),
  purpose text NOT NULL CHECK (purpose IN ('initializer', 'importer')),
  status text NOT NULL CHECK (status IN ('allocated', 'active', 'ended', 'revoked')),
  activation_ticket_hash text CHECK (activation_ticket_hash IS NULL OR activation_ticket_hash ~ '^[0-9a-f]{64}$'),
  activation_ticket_issued_at timestamptz,
  activated_at timestamptz,
  ended_at timestamptz,
  end_reason text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, fencing_token),
  FOREIGN KEY (project_id, run_id) REFERENCES runs(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, run_id, task_id) REFERENCES jobs(project_id, run_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, auth_profile_id) REFERENCES auth_profiles(project_id, id),
  FOREIGN KEY (project_id, auth_profile_id, auth_profile_version)
    REFERENCES auth_profile_versions(project_id, auth_profile_id, version),
  FOREIGN KEY (project_id, run_id) REFERENCES run_auth_scopes(project_id, run_id)
);

CREATE INDEX auth_sessions_run_epoch ON auth_execution_sessions(project_id, run_id, auth_epoch);

ALTER TABLE auth_execution_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_execution_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY auth_sessions_admin_all ON auth_execution_sessions
  FOR ALL TO localqa_app
  USING (is_admin())
  WITH CHECK (is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON auth_execution_sessions TO localqa_app;
