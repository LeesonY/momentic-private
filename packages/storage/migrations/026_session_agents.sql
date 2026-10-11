-- Frozen instructions and the authoritative session-agent planning history.
-- Existing runs without this row keep their original execution behavior.
CREATE TABLE run_sessions (
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  document jsonb NOT NULL,
  PRIMARY KEY(project_id,run_id),
  FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id)
);
ALTER TABLE run_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY member_read ON run_sessions FOR SELECT TO localqa_app USING(can_project(project_id));
CREATE POLICY admin_write ON run_sessions FOR ALL TO localqa_app USING(is_admin()) WITH CHECK(is_admin());
CREATE POLICY worker_scope ON run_sessions FOR ALL TO localqa_worker USING(worker_project(project_id)) WITH CHECK(worker_project(project_id));
GRANT SELECT,INSERT,UPDATE ON run_sessions TO localqa_app;
GRANT SELECT ON run_sessions TO localqa_worker;
