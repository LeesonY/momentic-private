-- Project operators may initialize and update their test session state.
CREATE POLICY session_insert ON run_sessions FOR INSERT TO localqa_app WITH CHECK(can_project(project_id,'operator'));
CREATE POLICY session_update ON run_sessions FOR UPDATE TO localqa_app USING(can_project(project_id,'operator') AND run_visible(project_id,run_id)) WITH CHECK(can_project(project_id,'operator') AND run_visible(project_id,run_id));
