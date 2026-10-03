-- Project owners may bind an existing platform model as their project's default.
-- The profile FK verifies existence without granting global model enumeration.
-- Model writes remain admin-only; grants remain project-scoped under forced RLS.
DROP POLICY grant_insert ON model_profile_grants;
CREATE POLICY grant_insert ON model_profile_grants FOR INSERT TO localqa_app
  WITH CHECK(can_project(project_id, 'owner'));
