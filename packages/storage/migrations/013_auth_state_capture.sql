-- 013_auth_state_capture.sql
-- AUTH-7A real auth material, success gates, capture grants, and encrypted run auth state ledger.
-- Strictly internal service tables protected by RLS; localqa_app admin only.

-- Extend page_snapshots and action_intents with created_at for gate currency tracking
ALTER TABLE page_snapshots
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT clock_timestamp();

ALTER TABLE action_intents
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT clock_timestamp();

-- 1. Auth success gates: verified and immutable criterion results gating state capture
CREATE TABLE auth_success_gates (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  task_id uuid NOT NULL,
  auth_session_id uuid NOT NULL REFERENCES auth_execution_sessions(id) ON DELETE CASCADE,
  auth_epoch integer NOT NULL CHECK (auth_epoch >= 1),
  criterion_id text NOT NULL,
  snapshot_id uuid NOT NULL,
  snapshot_hash text NOT NULL,
  criterion_hash text NOT NULL,
  intent_fingerprint text NOT NULL,
  result text NOT NULL CHECK (result = 'passed'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (project_id, run_id) REFERENCES runs(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, run_id, snapshot_id) REFERENCES page_snapshots(project_id, run_id, id)
);

ALTER TABLE auth_success_gates ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_success_gates FORCE ROW LEVEL SECURITY;

CREATE POLICY auth_success_gates_admin_all ON auth_success_gates
  FOR ALL TO localqa_app
  USING (is_admin())
  WITH CHECK (is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON auth_success_gates TO localqa_app;

-- 2. Auth capture grants: ticketed export grants for approved state capture
CREATE TABLE auth_capture_grants (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  task_id uuid NOT NULL,
  auth_session_id uuid NOT NULL REFERENCES auth_execution_sessions(id) ON DELETE CASCADE,
  auth_epoch integer NOT NULL CHECK (auth_epoch >= 1),
  UNIQUE (auth_session_id),
  ticket_hash text NOT NULL CHECK (ticket_hash ~ '^[0-9a-f]{64}$'),
  success_gate_id uuid NOT NULL REFERENCES auth_success_gates(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('issued', 'started', 'consumed', 'revoked')),
  deadline timestamptz NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  consumed_at timestamptz,
  FOREIGN KEY (project_id, run_id) REFERENCES runs(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, run_id, task_id) REFERENCES jobs(project_id, run_id, id) ON DELETE CASCADE
);

ALTER TABLE auth_capture_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_capture_grants FORCE ROW LEVEL SECURITY;

CREATE POLICY auth_capture_grants_admin_all ON auth_capture_grants
  FOR ALL TO localqa_app
  USING (is_admin())
  WITH CHECK (is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON auth_capture_grants TO localqa_app;

-- 3. Run auth states: encrypted authoritative state storage per run
CREATE TABLE run_auth_states (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  auth_profile_id uuid NOT NULL,
  auth_profile_version integer NOT NULL CHECK (auth_profile_version >= 1),
  context_version integer NOT NULL CHECK (context_version >= 1),
  capturing_context_id uuid NOT NULL,
  capturing_session_id uuid NOT NULL REFERENCES auth_execution_sessions(id),
  capturing_task_id uuid NOT NULL,
  capturing_worker_id text NOT NULL CHECK (length(capturing_worker_id) <= 200),
  capturing_fencing_token bigint NOT NULL CHECK (capturing_fencing_token >= 1),
  capturing_grant_id uuid NOT NULL REFERENCES auth_capture_grants(id) ON DELETE CASCADE,
  auth_epoch integer NOT NULL CHECK (auth_epoch >= 1),
  status text NOT NULL CHECK (status IN ('granted', 'revoked')),
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  auth_tag bytea NOT NULL,
  key_version integer NOT NULL CHECK (key_version >= 1),
  state_hmac text NOT NULL CHECK (state_hmac ~ '^[0-9a-f]{64}$'),
  hmac_key_version integer NOT NULL CHECK (hmac_key_version >= 1),
  origin_fingerprint text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  UNIQUE (project_id, run_id),
  FOREIGN KEY (project_id, run_id) REFERENCES runs(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, auth_profile_id) REFERENCES auth_profiles(project_id, id),
  FOREIGN KEY (project_id, auth_profile_id, auth_profile_version)
    REFERENCES auth_profile_versions(project_id, auth_profile_id, version),
  FOREIGN KEY (project_id, run_id) REFERENCES run_auth_scopes(project_id, run_id)
);

ALTER TABLE run_auth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_auth_states FORCE ROW LEVEL SECURITY;

CREATE POLICY run_auth_states_admin_all ON run_auth_states
  FOR ALL TO localqa_app
  USING (is_admin())
  WITH CHECK (is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON run_auth_states TO localqa_app;
