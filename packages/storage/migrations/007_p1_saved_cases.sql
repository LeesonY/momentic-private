-- P1 T10: saved cases, immutable versions, review, schedules, api-keys, repair proposals.
-- Contracts: docs/contracts/*.json (SavedCase, SavedCaseVersion, Schedule, ApiKey, RepairProposal).

CREATE TABLE saved_cases (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  slug text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  current_approved_version_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, slug),
  UNIQUE (project_id, id)
);

CREATE TABLE saved_case_versions (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL,
  project_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  document jsonb NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  review_status text NOT NULL DEFAULT 'draft' CHECK (review_status IN ('draft','approved','rejected')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  UNIQUE (case_id, version),
  UNIQUE (project_id, id),
  UNIQUE (project_id, case_id, id),
  FOREIGN KEY (project_id, case_id) REFERENCES saved_cases(project_id, id)
);

ALTER TABLE saved_cases
  ADD CONSTRAINT saved_cases_current_version_fk
  FOREIGN KEY (project_id, id, current_approved_version_id)
  REFERENCES saved_case_versions(project_id, case_id, id) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION guard_saved_case_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.case_id, NEW.project_id, NEW.version, NEW.document, NEW.sha256, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.case_id, OLD.project_id, OLD.version, OLD.document, OLD.sha256, OLD.created_by, OLD.created_at) THEN
    RAISE check_violation USING MESSAGE = 'saved-case version document is immutable';
  END IF;
  IF NEW.review_status IS DISTINCT FROM OLD.review_status THEN
    IF OLD.review_status <> 'draft' OR NEW.review_status NOT IN ('approved', 'rejected')
       OR NOT can_project(NEW.project_id, 'owner')
       OR NEW.reviewed_by IS DISTINCT FROM actor_id() OR NEW.reviewed_at IS NULL THEN
      RAISE check_violation USING MESSAGE = 'saved-case review transition is invalid';
    END IF;
  ELSIF ROW(NEW.reviewed_by, NEW.reviewed_at) IS DISTINCT FROM ROW(OLD.reviewed_by, OLD.reviewed_at) THEN
    RAISE check_violation USING MESSAGE = 'saved-case review metadata is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER saved_case_version_immutable BEFORE UPDATE ON saved_case_versions
  FOR EACH ROW EXECUTE FUNCTION guard_saved_case_version();

CREATE FUNCTION guard_saved_case_baseline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_approved_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM saved_case_versions v WHERE v.id = NEW.current_approved_version_id
      AND v.project_id = NEW.project_id AND v.case_id = NEW.id AND v.review_status = 'approved'
  ) THEN
    RAISE check_violation USING MESSAGE = 'saved-case baseline must be its approved version';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER saved_case_baseline_check BEFORE INSERT OR UPDATE OF current_approved_version_id ON saved_cases
  FOR EACH ROW EXECUTE FUNCTION guard_saved_case_baseline();

CREATE TABLE schedules (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL,
  cron text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Taipei',
  template_kind text NOT NULL CHECK (template_kind IN ('smoke','regression')),
  run_template jsonb NOT NULL,
  overlap_policy text NOT NULL DEFAULT 'skip' CHECK (overlap_policy IN ('skip','queue')),
  missed_policy text NOT NULL DEFAULT 'skip' CHECK (missed_policy IN ('skip','catchup_one')),
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL,
  scope jsonb NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE repair_proposals (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL,
  project_id uuid NOT NULL,
  finding_id uuid NOT NULL REFERENCES findings(id),
  proposed_version integer NOT NULL CHECK (proposed_version > 0),
  diff text NOT NULL,
  verification_run_id uuid REFERENCES runs(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, case_id) REFERENCES saved_cases(project_id, id)
);

-- RLS: reuse the generic member_read/member_write pattern from 003_access.sql.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['saved_cases','saved_case_versions','schedules','api_keys','repair_proposals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY member_read ON %I FOR SELECT TO localqa_app USING(can_project(project_id))', t);
    EXECUTE format('CREATE POLICY member_insert ON %I FOR INSERT TO localqa_app WITH CHECK(can_project(project_id, ''operator''))', t);
    EXECUTE format('CREATE POLICY member_update ON %I FOR UPDATE TO localqa_app USING(can_project(project_id, ''operator'')) WITH CHECK(can_project(project_id, ''operator''))', t);
    EXECUTE format('CREATE POLICY worker_scope ON %I FOR ALL TO localqa_worker USING(worker_project(project_id)) WITH CHECK(worker_project(project_id))', t);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO localqa_app', t);
  END LOOP;
END $$;
