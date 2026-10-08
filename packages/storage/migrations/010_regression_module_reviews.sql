-- 010_regression_module_reviews.sql
-- Incremental migration for regression module reviews, audit columns, and RLS.

-- 1. Add nullable audit columns to regression_module_versions without volatile defaults
-- to avoid backfilling current timestamps into historical rows.
ALTER TABLE regression_module_versions
  ADD COLUMN created_by uuid REFERENCES users(id),
  ADD COLUMN created_at timestamptz,
  ADD COLUMN reviewed_by uuid REFERENCES users(id),
  ADD COLUMN reviewed_at timestamptz;

ALTER TABLE regression_module_versions
  ALTER COLUMN created_at SET DEFAULT clock_timestamp();

-- 2. Decouple regression_module_versions from the blanket immutable trigger
-- and attach a dedicated trigger guarding state transitions and metadata immutability.
DROP TRIGGER regression_module_immutable ON regression_module_versions;

CREATE FUNCTION guard_regression_module_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE check_violation USING MESSAGE = 'regression module version is immutable';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF actor_id() IS NOT NULL AND NEW.review_status <> 'draft' THEN
      RAISE check_violation USING MESSAGE = 'new regression module version must be draft';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Core immutable columns must never be altered
    IF ROW(NEW.project_id, NEW.name, NEW.version, NEW.sha256, NEW.document)
       IS DISTINCT FROM ROW(OLD.project_id, OLD.name, OLD.version, OLD.sha256, OLD.document) THEN
      RAISE check_violation USING MESSAGE = 'regression module document and identity are immutable';
    END IF;

    -- Creation metadata must never be altered
    IF ROW(NEW.created_by, NEW.created_at) IS DISTINCT FROM ROW(OLD.created_by, OLD.created_at) THEN
      RAISE check_violation USING MESSAGE = 'regression module creation metadata is immutable';
    END IF;

    -- Review status transition: only draft -> approved / rejected by project owner
    IF NEW.review_status IS DISTINCT FROM OLD.review_status THEN
      IF OLD.review_status <> 'draft' OR NEW.review_status NOT IN ('approved', 'rejected')
         OR NOT can_project(NEW.project_id, 'owner')
         OR NEW.reviewed_by IS DISTINCT FROM actor_id()
         OR NEW.reviewed_at IS NULL THEN
        RAISE check_violation USING MESSAGE = 'regression module review transition is invalid';
      END IF;
    ELSIF ROW(NEW.reviewed_by, NEW.reviewed_at) IS DISTINCT FROM ROW(OLD.reviewed_by, OLD.reviewed_at) THEN
      RAISE check_violation USING MESSAGE = 'regression module review metadata is immutable';
    ELSE
      RAISE check_violation USING MESSAGE = 'regression module review status is immutable';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER regression_module_version_guard
  BEFORE INSERT OR UPDATE OR DELETE ON regression_module_versions
  FOR EACH ROW EXECUTE FUNCTION guard_regression_module_version();

-- 3. Adjust RLS policies and grants on regression_module_versions:
-- Operators can insert drafts, but review_status must be 'draft' and created_by must match actor.
DROP POLICY module_register ON regression_module_versions;
CREATE POLICY module_register ON regression_module_versions
  FOR INSERT TO localqa_app
  WITH CHECK(
    can_project(project_id, 'operator')
    AND review_status = 'draft'
    AND created_by = actor_id()
    AND created_at IS NOT NULL
    AND reviewed_by IS NULL
    AND reviewed_at IS NULL
  );

CREATE POLICY module_review_update ON regression_module_versions
  FOR UPDATE TO localqa_app
  USING(can_project(project_id, 'owner'))
  WITH CHECK(can_project(project_id, 'owner'));

GRANT UPDATE ON regression_module_versions TO localqa_app;

-- 4. Dedicated composite-key module review preview table
CREATE TABLE regression_module_review_previews (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  module_name text NOT NULL,
  version integer NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id),
  expected_version integer NOT NULL,
  body_hash text NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  decision text NOT NULL CHECK (decision IN ('approve', 'reject')),
  reason text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  approved_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, module_name, version)
    REFERENCES regression_module_versions(project_id, name, version)
);

ALTER TABLE regression_module_review_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE regression_module_review_previews FORCE ROW LEVEL SECURITY;

CREATE POLICY module_preview_read ON regression_module_review_previews
  FOR SELECT TO localqa_app
  USING(can_project(project_id, 'owner') AND actor_id = actor_id());

CREATE POLICY module_preview_insert ON regression_module_review_previews
  FOR INSERT TO localqa_app
  WITH CHECK(can_project(project_id, 'owner') AND actor_id = actor_id());

CREATE POLICY module_preview_update ON regression_module_review_previews
  FOR UPDATE TO localqa_app
  USING(can_project(project_id, 'owner') AND actor_id = actor_id())
  WITH CHECK(can_project(project_id, 'owner') AND actor_id = actor_id());

GRANT SELECT, INSERT, UPDATE ON regression_module_review_previews TO localqa_app;

CREATE FUNCTION guard_module_review_preview() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE check_violation USING MESSAGE = 'module review preview cannot be deleted';
  END IF;

  IF (to_jsonb(NEW) - 'consumed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'consumed_at')
     OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at)
     OR (OLD.consumed_at IS NULL AND NEW.consumed_at IS NULL) THEN
    RAISE check_violation USING MESSAGE = 'module review preview is immutable except single consumption';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER module_review_preview_immutable
  BEFORE UPDATE OR DELETE ON regression_module_review_previews
  FOR EACH ROW EXECUTE FUNCTION guard_module_review_preview();
