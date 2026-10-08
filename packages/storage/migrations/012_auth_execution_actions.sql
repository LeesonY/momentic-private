-- 012_auth_execution_actions.sql
-- AUTH-6 private auth action ledger, session snapshots, request idempotency, and exclusive profile run locks.
-- Strictly internal service tables protected by RLS; localqa_app admin only.

-- 1. Extend action_intents with auth session binding and CAS execution states
ALTER TABLE action_intents
  ADD COLUMN IF NOT EXISTS auth_session_id uuid REFERENCES auth_execution_sessions(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS auth_epoch integer,
  ADD COLUMN IF NOT EXISTS execution_state text NOT NULL DEFAULT 'issued' CHECK (execution_state IN ('issued', 'started', 'completed')),
  ADD COLUMN IF NOT EXISTS execution_id uuid,
  ADD COLUMN IF NOT EXISTS started_at timestamptz;

CREATE INDEX IF NOT EXISTS action_intents_auth_session ON action_intents(auth_session_id) WHERE auth_session_id IS NOT NULL;

-- Tighten action_intents RLS: private auth intents are visible only to service admin.
-- Project members (viewer/operator/owner) and localqa_worker cannot read private auth intents.
DROP POLICY IF EXISTS member_read ON action_intents;
CREATE POLICY member_read ON action_intents FOR SELECT TO localqa_app
  USING (
    is_admin() OR (can_project(project_id, 'viewer') AND auth_session_id IS NULL)
  );

DROP POLICY IF EXISTS worker_scope ON action_intents;
CREATE POLICY worker_scope ON action_intents FOR ALL TO localqa_worker
  USING (worker_project(project_id) AND auth_session_id IS NULL)
  WITH CHECK (worker_project(project_id) AND auth_session_id IS NULL);

-- 2. Extend page_snapshots with auth session and epoch provenance
ALTER TABLE page_snapshots
  ADD COLUMN IF NOT EXISTS auth_session_id uuid REFERENCES auth_execution_sessions(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS auth_epoch integer;

CREATE INDEX IF NOT EXISTS page_snapshots_auth_session ON page_snapshots(auth_session_id) WHERE auth_session_id IS NOT NULL;

-- 3. Request idempotency ledger for grantAuth
CREATE TABLE auth_action_requests (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  task_id uuid NOT NULL,
  auth_session_id uuid NOT NULL REFERENCES auth_execution_sessions(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  request_hash text NOT NULL,
  action text NOT NULL,
  slot text NOT NULL,
  grant_id uuid NOT NULL REFERENCES action_intents(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (auth_session_id, request_id),
  FOREIGN KEY (project_id, run_id) REFERENCES runs(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, run_id, task_id) REFERENCES jobs(project_id, run_id, id) ON DELETE CASCADE
);

ALTER TABLE auth_action_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_action_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY auth_action_requests_admin_all ON auth_action_requests
  FOR ALL TO localqa_app
  USING (is_admin())
  WITH CHECK (is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON auth_action_requests TO localqa_app;

-- 4. Exclusive profile run locks
CREATE TABLE auth_profile_run_locks (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  auth_profile_id uuid NOT NULL,
  run_id uuid NOT NULL,
  auth_session_id uuid NOT NULL REFERENCES auth_execution_sessions(id) ON DELETE CASCADE,
  auth_epoch integer NOT NULL CHECK (auth_epoch >= 1),
  status text NOT NULL CHECK (status IN ('held', 'released')),
  phase text NOT NULL CHECK (phase IN ('initializing', 'granted')),
  held_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  release_reason text,
  FOREIGN KEY (project_id, run_id) REFERENCES runs(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, auth_profile_id) REFERENCES auth_profiles(project_id, id)
);

CREATE UNIQUE INDEX auth_profile_run_locks_held_profile ON auth_profile_run_locks(project_id, auth_profile_id) WHERE status = 'held';
CREATE UNIQUE INDEX auth_profile_run_locks_held_run ON auth_profile_run_locks(project_id, run_id) WHERE status = 'held';

ALTER TABLE auth_profile_run_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_profile_run_locks FORCE ROW LEVEL SECURITY;

CREATE POLICY auth_profile_run_locks_admin_all ON auth_profile_run_locks
  FOR ALL TO localqa_app
  USING (is_admin())
  WITH CHECK (is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON auth_profile_run_locks TO localqa_app;
