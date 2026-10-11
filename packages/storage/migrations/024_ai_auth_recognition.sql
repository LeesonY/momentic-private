-- AI success evidence stays bound to the active private auth session.
-- Existing manual profiles keep their frozen profile criterion.
ALTER TABLE auth_execution_sessions
  ADD COLUMN ai_success_criterion jsonb,
  ADD COLUMN ai_success_snapshot_id uuid;
