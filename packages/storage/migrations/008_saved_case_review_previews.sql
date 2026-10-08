-- Dedicated preview table for saved-case version review, typed to the real
-- target (saved_case_versions) instead of reusing confirmation_previews
-- (whose FK points at findings). Keeps P0 findings/triage FK semantics intact.
CREATE TABLE saved_case_review_previews (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  version_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id),
  expected_version integer NOT NULL,
  body_hash text NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  approved_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, version_id) REFERENCES saved_case_versions(project_id, id)
);

ALTER TABLE saved_case_review_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_case_review_previews FORCE ROW LEVEL SECURITY;
CREATE POLICY member_read ON saved_case_review_previews FOR SELECT TO localqa_app USING(can_project(project_id));
CREATE POLICY member_insert ON saved_case_review_previews FOR INSERT TO localqa_app WITH CHECK(can_project(project_id, 'owner'));
CREATE POLICY member_update ON saved_case_review_previews FOR UPDATE TO localqa_app USING(can_project(project_id, 'owner')) WITH CHECK(can_project(project_id, 'owner'));
GRANT SELECT,INSERT,UPDATE,DELETE ON saved_case_review_previews TO localqa_app;

CREATE FUNCTION guard_saved_case_review_preview() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'consumed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'consumed_at')
     OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at) THEN
    RAISE check_violation USING MESSAGE = 'saved-case review preview is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER saved_case_review_preview_immutable
  BEFORE UPDATE ON saved_case_review_previews FOR EACH ROW
  EXECUTE FUNCTION guard_saved_case_review_preview();
