-- T12: an approved *suggestion* may be converted into a distinct immutable
-- saved-case draft, but it is never a published baseline or a verified fix.
CREATE TABLE repair_candidate_drafts (
  project_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  case_id uuid NOT NULL,
  case_version_id uuid NOT NULL,
  verification_status text NOT NULL DEFAULT 'pending'
    CHECK (verification_status='pending'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(project_id,proposal_id),
  UNIQUE(project_id,case_version_id),
  FOREIGN KEY(project_id,proposal_id)
    REFERENCES repair_proposals(project_id,id),
  FOREIGN KEY(project_id,case_id,case_version_id)
    REFERENCES saved_case_versions(project_id,case_id,id)
);
ALTER TABLE repair_candidate_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE repair_candidate_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY repair_candidate_read ON repair_candidate_drafts
  FOR SELECT TO localqa_app USING(can_project(project_id));
CREATE POLICY repair_candidate_create ON repair_candidate_drafts
  FOR INSERT TO localqa_app WITH CHECK(can_project(project_id,'operator'));
GRANT SELECT,INSERT ON repair_candidate_drafts TO localqa_app;
