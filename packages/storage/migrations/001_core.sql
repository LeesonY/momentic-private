-- LocalQA P0 relational storage. Explicit migration, PostgreSQL 18.
-- Applied transactionally by the migration runner, never by ORM auto-sync.
DO $$ DECLARE role_name text; BEGIN
 FOREACH role_name IN ARRAY ARRAY['localqa_app','localqa_worker','localqa_auth'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN EXECUTE format('CREATE ROLE %I NOLOGIN NOBYPASSRLS',role_name);
  ELSIF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN RAISE EXCEPTION 'Unsafe existing server role: %',role_name;
  END IF;
 END LOOP;
END $$;
CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE,
 display_name text NOT NULL, password_hash text NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
 global_role text NOT NULL CHECK (global_role IN ('admin','member')), disabled boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1 CHECK (version>0), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_case_insensitive ON users(lower(email));
CREATE TABLE login_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
 token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
 expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE bootstrap_state (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), initialized boolean NOT NULL DEFAULT false);
INSERT INTO bootstrap_state VALUES(true,false);
CREATE TABLE platform_secrets (
 id uuid PRIMARY KEY, name text NOT NULL, purpose text NOT NULL,
 ciphertext bytea NOT NULL, nonce bytea NOT NULL CHECK(octet_length(nonce)=12),
 auth_tag bytea NOT NULL CHECK(octet_length(auth_tag)=16), key_version integer NOT NULL CHECK(key_version>0)
);
CREATE TABLE model_profiles (
 id uuid PRIMARY KEY, version integer NOT NULL DEFAULT 1 CHECK(version>0), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE model_profile_versions (
 profile_id uuid NOT NULL REFERENCES model_profiles(id), version integer NOT NULL CHECK(version>0),
 document jsonb NOT NULL, credential_id uuid REFERENCES platform_secrets(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(profile_id,version)
);
CREATE TABLE projects (
 id uuid PRIMARY KEY, name text NOT NULL, status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), default_model_profile_id uuid REFERENCES model_profiles(id),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,version)
);
CREATE TABLE project_members (
 project_id uuid NOT NULL REFERENCES projects(id), user_id uuid NOT NULL REFERENCES users(id),
 role text NOT NULL CHECK(role IN ('owner','operator','viewer')), PRIMARY KEY(project_id,user_id)
);
CREATE INDEX project_members_user_project ON project_members(user_id,project_id);
CREATE TABLE model_profile_grants (
 project_id uuid NOT NULL REFERENCES projects(id), profile_id uuid NOT NULL REFERENCES model_profiles(id), PRIMARY KEY(project_id,profile_id)
);
CREATE TABLE secrets (
 id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), name text NOT NULL, purpose text NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0), revoked boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,id)
);
CREATE TABLE secret_versions (
 id uuid PRIMARY KEY, project_id uuid NOT NULL, secret_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
 ciphertext bytea NOT NULL, nonce bytea NOT NULL CHECK(octet_length(nonce)=12), auth_tag bytea NOT NULL CHECK(octet_length(auth_tag)=16),
 key_version integer NOT NULL CHECK(key_version>0), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,secret_id) REFERENCES secrets(project_id,id), UNIQUE(project_id,secret_id,version), UNIQUE(project_id,id)
);
CREATE TABLE environments (
 id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), version integer NOT NULL DEFAULT 1 CHECK(version>0), UNIQUE(project_id,id)
);
CREATE TABLE auth_profiles (
 id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 revoked boolean NOT NULL DEFAULT false, UNIQUE(project_id,id)
);
CREATE TABLE environment_versions (
 project_id uuid NOT NULL, environment_id uuid NOT NULL, version integer NOT NULL CHECK(version>0), document jsonb NOT NULL,
 default_auth_profile_id uuid, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(project_id,environment_id,version),
 FOREIGN KEY(project_id,environment_id) REFERENCES environments(project_id,id),
 FOREIGN KEY(project_id,default_auth_profile_id) REFERENCES auth_profiles(project_id,id)
);
CREATE TABLE auth_profile_versions (
 project_id uuid NOT NULL, auth_profile_id uuid NOT NULL, version integer NOT NULL CHECK(version>0), document jsonb NOT NULL,
 environment_id uuid, secret_id uuid, secret_version integer,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(project_id,auth_profile_id,version),
 FOREIGN KEY(project_id,auth_profile_id) REFERENCES auth_profiles(project_id,id),
 FOREIGN KEY(project_id,environment_id) REFERENCES environments(project_id,id),
 FOREIGN KEY(project_id,secret_id,secret_version) REFERENCES secret_versions(project_id,secret_id,version),
 CHECK((secret_id IS NULL)=(secret_version IS NULL))
);
CREATE TABLE knowledge (
 id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), version integer NOT NULL DEFAULT 1 CHECK(version>0), UNIQUE(project_id,id)
);
CREATE TABLE knowledge_versions (
 id uuid PRIMARY KEY, project_id uuid NOT NULL, knowledge_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
 document jsonb NOT NULL, author_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,knowledge_id) REFERENCES knowledge(project_id,id), UNIQUE(project_id,knowledge_id,version), UNIQUE(project_id,id)
);
CREATE TABLE runs (
 id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), creator_id uuid NOT NULL REFERENCES users(id),
 display_url text NOT NULL CHECK(display_url ~ '^https?://' AND position('?' in display_url)=0 AND position('@' in split_part(display_url,'/',3))=0),
 raw_url_secret_id uuid, raw_url_secret_version integer,
 status text NOT NULL CHECK(status IN ('draft','queued','running','awaiting_input','cancelling','completed','cancelled','failed')),
 phase text NOT NULL CHECK(phase IN ('preflight','auth','explore','plan','execute','reproduce','finalize')),
 completion text NOT NULL CHECK(completion IN ('complete','partial','none')), termination_reason text,
 context_version integer NOT NULL DEFAULT 1 CHECK(context_version>0), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 effective_config jsonb NOT NULL, budget_used jsonb NOT NULL,
 environment_id uuid, environment_version integer, auth_profile_id uuid, auth_profile_version integer,
 event_seq bigint NOT NULL DEFAULT 0 CHECK(event_seq>=0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,id),
 FOREIGN KEY(project_id,raw_url_secret_id,raw_url_secret_version) REFERENCES secret_versions(project_id,secret_id,version),
 FOREIGN KEY(project_id,environment_id,environment_version) REFERENCES environment_versions(project_id,environment_id,version),
 FOREIGN KEY(project_id,auth_profile_id,auth_profile_version) REFERENCES auth_profile_versions(project_id,auth_profile_id,version),
 CHECK((environment_id IS NULL)=(environment_version IS NULL)), CHECK((auth_profile_id IS NULL)=(auth_profile_version IS NULL)),
 CHECK((raw_url_secret_id IS NULL)=(raw_url_secret_version IS NULL))
);
CREATE INDEX runs_project_created ON runs(project_id,created_at,id);
CREATE TABLE run_model_bindings (
 project_id uuid NOT NULL, run_id uuid NOT NULL, role text NOT NULL,
 profile_id uuid NOT NULL, version integer NOT NULL,
 PRIMARY KEY(run_id,role), FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id),
 FOREIGN KEY(project_id,profile_id) REFERENCES model_profile_grants(project_id,profile_id),
 FOREIGN KEY(profile_id,version) REFERENCES model_profile_versions(profile_id,version)
);
CREATE TABLE run_knowledge_bindings (
 project_id uuid NOT NULL, run_id uuid NOT NULL, knowledge_version_id uuid NOT NULL,
 PRIMARY KEY(run_id,knowledge_version_id), FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id),
 FOREIGN KEY(project_id,knowledge_version_id) REFERENCES knowledge_versions(project_id,id)
);
CREATE TABLE run_budgets (
 project_id uuid NOT NULL, run_id uuid PRIMARY KEY, limits jsonb NOT NULL, used jsonb NOT NULL, reserved jsonb NOT NULL DEFAULT '{}',
 FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id), UNIQUE(project_id,run_id)
);
CREATE TABLE run_cases (
 id uuid PRIMARY KEY, project_id uuid NOT NULL, run_id uuid NOT NULL, document jsonb NOT NULL, criteria_hash text NOT NULL,
 frozen boolean NOT NULL DEFAULT false, UNIQUE(project_id,id), UNIQUE(project_id,run_id,id),
 FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id)
);
CREATE INDEX run_cases_run ON run_cases(run_id,id);
CREATE TABLE jobs (
 id uuid PRIMARY KEY, project_id uuid NOT NULL, run_id uuid NOT NULL, case_id uuid,
 unique_key text NOT NULL UNIQUE, role text NOT NULL CHECK(role IN ('coordinator','explorer','executor','reproducer','finalizer')),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','waiting','succeeded','failed','cancelled','interrupted')),
 attempt integer NOT NULL DEFAULT 1 CHECK(attempt>0), document jsonb NOT NULL,
 worker_id text, lease_until timestamptz, fencing_token bigint NOT NULL DEFAULT 0 CHECK(fencing_token>=0),
 available_at timestamptz NOT NULL DEFAULT now(), result_hash text, UNIQUE(project_id,id), UNIQUE(project_id,run_id,id),
 FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id), FOREIGN KEY(project_id,run_id,case_id) REFERENCES run_cases(project_id,run_id,id)
);
CREATE INDEX jobs_claim ON jobs(status,available_at,lease_until);
CREATE TABLE task_leases (
 id uuid PRIMARY KEY, project_id uuid NOT NULL, task_id uuid NOT NULL, worker_id text NOT NULL,
 fencing_token bigint NOT NULL CHECK(fencing_token>0), token_hash text NOT NULL CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 lease_until timestamptz NOT NULL, released_at timestamptz, UNIQUE(task_id,fencing_token), UNIQUE(project_id,id),
 FOREIGN KEY(project_id,task_id) REFERENCES jobs(project_id,id)
);
CREATE TABLE budget_reservations (
 id uuid PRIMARY KEY, project_id uuid NOT NULL, run_id uuid NOT NULL, task_id uuid, request_id uuid NOT NULL UNIQUE,
 fencing_token bigint, kind text NOT NULL CHECK(kind IN ('action','model','reproduction','concurrency')),
 reserved jsonb NOT NULL, charged jsonb, status text NOT NULL CHECK(status IN ('reserved','settled','unknown','released')),
 FOREIGN KEY(project_id,run_id) REFERENCES run_budgets(project_id,run_id),
 FOREIGN KEY(project_id,run_id,task_id) REFERENCES jobs(project_id,run_id,id), UNIQUE(project_id,id)
);
CREATE TABLE case_attempts (
 id uuid PRIMARY KEY, project_id uuid NOT NULL, run_id uuid NOT NULL, case_id uuid NOT NULL, task_id uuid NOT NULL,
 attempt_number integer NOT NULL CHECK(attempt_number>0), status text NOT NULL, context_id uuid NOT NULL,
 started_at timestamptz, finished_at timestamptz, UNIQUE(case_id,attempt_number), UNIQUE(project_id,id), UNIQUE(project_id,case_id,id),
 FOREIGN KEY(project_id,run_id,case_id) REFERENCES run_cases(project_id,run_id,id), FOREIGN KEY(project_id,run_id,task_id) REFERENCES jobs(project_id,run_id,id)
);
CREATE INDEX case_attempts_case_no ON case_attempts(case_id,attempt_number);
CREATE TABLE verdicts (
 id uuid PRIMARY KEY, project_id uuid NOT NULL, case_id uuid NOT NULL, attempt_id uuid NOT NULL UNIQUE,
 document jsonb NOT NULL, payload_hash text NOT NULL, fencing_token bigint NOT NULL,
 valid boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,id),
 FOREIGN KEY(project_id,case_id,attempt_id) REFERENCES case_attempts(project_id,case_id,id)
);
CREATE TABLE page_snapshots (
 id uuid PRIMARY KEY, project_id uuid NOT NULL, run_id uuid NOT NULL, task_id uuid NOT NULL,
 document jsonb NOT NULL, UNIQUE(project_id,id), UNIQUE(project_id,run_id,id),
 FOREIGN KEY(project_id,run_id,task_id) REFERENCES jobs(project_id,run_id,id)
);
CREATE TABLE controls (
 id uuid PRIMARY KEY, project_id uuid NOT NULL, run_id uuid NOT NULL, snapshot_id uuid NOT NULL,
 fingerprint text NOT NULL, document jsonb NOT NULL, UNIQUE(snapshot_id,fingerprint),
 FOREIGN KEY(project_id,run_id,snapshot_id) REFERENCES page_snapshots(project_id,run_id,id)
);
CREATE TABLE action_intents (
 id uuid PRIMARY KEY, project_id uuid NOT NULL, run_id uuid NOT NULL, task_id uuid NOT NULL,
 fencing_token bigint NOT NULL, context_version integer NOT NULL, reservation_id uuid NOT NULL,
 tool_call jsonb NOT NULL, outcome text NOT NULL DEFAULT 'pending' CHECK(outcome IN ('pending','succeeded','failed','unknown','cancelled')),
 result_hash text, UNIQUE(project_id,id), UNIQUE(project_id,run_id,task_id,id),
 FOREIGN KEY(project_id,run_id,task_id) REFERENCES jobs(project_id,run_id,id),
 FOREIGN KEY(project_id,reservation_id) REFERENCES budget_reservations(project_id,id)
);
CREATE TABLE steps (
 id uuid PRIMARY KEY, project_id uuid NOT NULL, run_id uuid NOT NULL, task_id uuid NOT NULL, case_id uuid,
 action_id uuid NOT NULL, seq integer NOT NULL CHECK(seq>0), document jsonb NOT NULL,
 UNIQUE(task_id,seq), UNIQUE(project_id,id), UNIQUE(project_id,run_id,id),
 FOREIGN KEY(project_id,run_id,task_id,action_id) REFERENCES action_intents(project_id,run_id,task_id,id),
 FOREIGN KEY(project_id,run_id,case_id) REFERENCES run_cases(project_id,run_id,id)
);
CREATE TABLE findings (
 id uuid PRIMARY KEY, project_id uuid NOT NULL, run_id uuid NOT NULL, case_id uuid NOT NULL, original_attempt_id uuid NOT NULL,
 criteria_hash text NOT NULL, fingerprint text NOT NULL, kind text NOT NULL CHECK(kind IN ('functional','static')),
 status text NOT NULL CHECK(status IN ('suspected','confirmed','unconfirmed','blocked')),
 expected_source text NOT NULL, reproduction_id uuid, version integer NOT NULL DEFAULT 1 CHECK(version>0), document jsonb NOT NULL,
 UNIQUE(project_id,id), UNIQUE(project_id,run_id,id),
 FOREIGN KEY(project_id,run_id,case_id) REFERENCES run_cases(project_id,run_id,id),
 FOREIGN KEY(project_id,case_id,original_attempt_id) REFERENCES case_attempts(project_id,case_id,id)
);
CREATE INDEX findings_run_fingerprint ON findings(run_id,fingerprint);
CREATE TABLE reproductions (
 id uuid PRIMARY KEY, project_id uuid NOT NULL, run_id uuid NOT NULL, finding_id uuid NOT NULL, task_id uuid NOT NULL,
 attempt_id uuid NOT NULL, criteria_hash text NOT NULL, fresh_context boolean NOT NULL CHECK(fresh_context),
 outcome text NOT NULL CHECK(outcome IN ('reproduced','not_reproduced','blocked')), document jsonb NOT NULL, UNIQUE(project_id,id),
 FOREIGN KEY(project_id,run_id,finding_id) REFERENCES findings(project_id,run_id,id),
 FOREIGN KEY(project_id,run_id,task_id) REFERENCES jobs(project_id,run_id,id),
 FOREIGN KEY(project_id,attempt_id) REFERENCES case_attempts(project_id,id)
);
ALTER TABLE findings ADD FOREIGN KEY(project_id,reproduction_id) REFERENCES reproductions(project_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE artifacts (
 id uuid PRIMARY KEY, project_id uuid NOT NULL, run_id uuid NOT NULL, task_id uuid, step_id uuid, case_id uuid, snapshot_id uuid,
 document jsonb NOT NULL, retain_until timestamptz NOT NULL, held boolean NOT NULL DEFAULT false,
 UNIQUE(project_id,id), UNIQUE(project_id,run_id,id),
 FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id),
 FOREIGN KEY(project_id,run_id,task_id) REFERENCES jobs(project_id,run_id,id),
 FOREIGN KEY(project_id,run_id,step_id) REFERENCES steps(project_id,run_id,id),
 FOREIGN KEY(project_id,run_id,case_id) REFERENCES run_cases(project_id,run_id,id),
 FOREIGN KEY(project_id,run_id,snapshot_id) REFERENCES page_snapshots(project_id,run_id,id)
);
CREATE INDEX artifacts_run_step ON artifacts(run_id,step_id);
CREATE TABLE finding_evidence (
 project_id uuid NOT NULL, finding_id uuid NOT NULL, artifact_id uuid NOT NULL,
 PRIMARY KEY(finding_id,artifact_id), FOREIGN KEY(project_id,finding_id) REFERENCES findings(project_id,id),
 FOREIGN KEY(project_id,artifact_id) REFERENCES artifacts(project_id,id)
);
CREATE TABLE reproduction_evidence (
 project_id uuid NOT NULL, reproduction_id uuid NOT NULL, artifact_id uuid NOT NULL,
 PRIMARY KEY(reproduction_id,artifact_id), FOREIGN KEY(project_id,reproduction_id) REFERENCES reproductions(project_id,id),
 FOREIGN KEY(project_id,artifact_id) REFERENCES artifacts(project_id,id)
);
CREATE TABLE artifact_references (
 project_id uuid NOT NULL, artifact_id uuid NOT NULL, ref_kind text NOT NULL, ref_id uuid NOT NULL,
 PRIMARY KEY(artifact_id,ref_kind,ref_id), FOREIGN KEY(project_id,artifact_id) REFERENCES artifacts(project_id,id)
);
CREATE TABLE exports (
 id uuid PRIMARY KEY, project_id uuid NOT NULL, run_id uuid NOT NULL, status text NOT NULL,
 document jsonb NOT NULL, report_snapshot jsonb NOT NULL, artifact_id uuid, retain_until timestamptz NOT NULL, held boolean NOT NULL DEFAULT false,
 UNIQUE(project_id,id), FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id),
 FOREIGN KEY(project_id,run_id,artifact_id) REFERENCES artifacts(project_id,run_id,id)
);
CREATE TABLE input_requests (
 id uuid PRIMARY KEY, project_id uuid NOT NULL, run_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
 document jsonb NOT NULL, actor_id uuid REFERENCES users(id), UNIQUE(project_id,id), FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id)
);
CREATE TABLE run_messages (
 id uuid PRIMARY KEY, project_id uuid NOT NULL, run_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES users(id),
 context_version integer NOT NULL CHECK(context_version>0), redacted_text text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id)
);
CREATE TABLE run_events (
 project_id uuid NOT NULL, run_id uuid NOT NULL, seq bigint NOT NULL CHECK(seq>0), type text NOT NULL,
 payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(run_id,seq),
 FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id)
);
CREATE TABLE model_requests (
 request_id uuid PRIMARY KEY, project_id uuid NOT NULL, run_id uuid NOT NULL, task_id uuid NOT NULL,
 fencing_token bigint NOT NULL, reservation_id uuid NOT NULL, status text NOT NULL, redacted_diagnostic jsonb NOT NULL DEFAULT '{}',
 FOREIGN KEY(project_id,run_id,task_id) REFERENCES jobs(project_id,run_id,id), FOREIGN KEY(project_id,reservation_id) REFERENCES budget_reservations(project_id,id)
);
CREATE TABLE confirmation_previews (
 id uuid PRIMARY KEY, project_id uuid NOT NULL, finding_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES users(id),
 expected_version integer NOT NULL, body_hash text NOT NULL, token_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL, consumed_at timestamptz,
 FOREIGN KEY(project_id,finding_id) REFERENCES findings(project_id,id)
);
CREATE TABLE triage (
 id uuid PRIMARY KEY, project_id uuid NOT NULL, finding_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES users(id),
 preview_id uuid NOT NULL UNIQUE REFERENCES confirmation_previews(id), document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,finding_id) REFERENCES findings(project_id,id)
);
CREATE TABLE audit_log (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid REFERENCES projects(id), actor_id uuid REFERENCES users(id),
 action text NOT NULL, object_id uuid, object_version integer, result text NOT NULL, redacted_summary jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE request_idempotency (
 project_id uuid NOT NULL REFERENCES projects(id), actor_id uuid NOT NULL REFERENCES users(id), route text NOT NULL,
 key text NOT NULL, body_hash text NOT NULL, result_id uuid NOT NULL, expires_at timestamptz NOT NULL,
 PRIMARY KEY(project_id,actor_id,route,key)
);
-- P1 key-only allocation; scheduler implementation remains T11.
CREATE TABLE schedule_occurrences (
 id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), schedule_id uuid NOT NULL,
 occurrence_at timestamptz NOT NULL, run_id uuid, UNIQUE(schedule_id,occurrence_at),
 FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id)
);
