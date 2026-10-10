-- Private, one-use OTP exchange. API/Worker share PostgreSQL, never an
-- ordinary InputRequest document, run event, action or model prompt.
CREATE TABLE auth_otp_challenges (
  input_id uuid PRIMARY KEY REFERENCES input_requests(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  task_id uuid NOT NULL,
  auth_session_id uuid NOT NULL UNIQUE REFERENCES auth_execution_sessions(id) ON DELETE CASCADE,
  fencing_token bigint NOT NULL,
  context_version integer NOT NULL,
  auth_epoch integer NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','submitted','consumed','rejected','expired')),
  expires_at timestamptz NOT NULL,
  ciphertext bytea,
  nonce bytea,
  auth_tag bytea,
  key_version integer,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consumed_at timestamptz,
  FOREIGN KEY (project_id,run_id,task_id) REFERENCES jobs(project_id,run_id,id) ON DELETE CASCADE,
  CHECK (
    (status='submitted' AND ciphertext IS NOT NULL AND nonce IS NOT NULL
      AND auth_tag IS NOT NULL AND key_version IS NOT NULL)
    OR (status<>'submitted' AND ciphertext IS NULL AND nonce IS NULL
      AND auth_tag IS NULL AND key_version IS NULL)
  )
);

ALTER TABLE auth_otp_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_otp_challenges FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_otp_admin_all ON auth_otp_challenges FOR ALL TO localqa_app
  USING (is_admin()) WITH CHECK (is_admin());
GRANT SELECT,INSERT,UPDATE,DELETE ON auth_otp_challenges TO localqa_app;
