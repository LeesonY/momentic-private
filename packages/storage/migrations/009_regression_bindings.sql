ALTER TABLE runs ADD COLUMN execution_mode text NOT NULL DEFAULT 'smoke' CHECK(execution_mode IN ('smoke','regression'));
CREATE FUNCTION guard_run_execution_mode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.execution_mode IS DISTINCT FROM OLD.execution_mode THEN RAISE check_violation USING MESSAGE='run mode immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER run_execution_mode_immutable BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION guard_run_execution_mode();

CREATE TABLE regression_module_versions (
 project_id uuid NOT NULL REFERENCES projects(id), name text NOT NULL,
 version integer NOT NULL CHECK(version>0), sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 document jsonb NOT NULL, review_status text NOT NULL CHECK(review_status IN ('draft','approved','rejected')),
 PRIMARY KEY(project_id,name,version)
);
CREATE TABLE run_case_regression_bindings (
 project_id uuid NOT NULL, run_id uuid NOT NULL, case_id uuid PRIMARY KEY,
 source_version_id uuid NOT NULL, source_sha256 text NOT NULL,
 binding jsonb NOT NULL,
 FOREIGN KEY(project_id,case_id) REFERENCES run_cases(project_id,id),
 FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id),
 FOREIGN KEY(project_id,source_version_id) REFERENCES saved_case_versions(project_id,id)
);
CREATE FUNCTION guard_regression_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source saved_case_versions; module jsonb;
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE check_violation USING MESSAGE='regression snapshot immutable'; END IF;
 IF TG_TABLE_NAME='run_case_regression_bindings' THEN
  SELECT * INTO source FROM saved_case_versions WHERE project_id=NEW.project_id AND id=NEW.source_version_id FOR SHARE;
  IF source.id IS NULL OR source.review_status<>'approved' OR source.sha256<>NEW.source_sha256
    OR (NEW.binding->>'sourceVersionId') IS DISTINCT FROM NEW.source_version_id::text
    OR (NEW.binding->>'sourceDocumentSha256') IS DISTINCT FROM source.sha256
    OR jsonb_typeof(NEW.binding->'moduleSnapshots') IS DISTINCT FROM 'array'
    OR NEW.binding->'document' IS DISTINCT FROM source.document
    OR NOT EXISTS(SELECT 1 FROM run_cases WHERE id=NEW.case_id AND project_id=NEW.project_id AND run_id=NEW.run_id AND document->'regression'=NEW.binding)
    OR NOT EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND execution_mode='regression') THEN
   RAISE check_violation USING MESSAGE='invalid approved regression source';
  END IF;
  FOR module IN SELECT value FROM jsonb_array_elements(NEW.binding->'moduleSnapshots') LOOP
   IF NOT EXISTS(SELECT 1 FROM regression_module_versions m WHERE m.project_id=NEW.project_id
    AND m.name=module->>'name' AND m.version=(module->>'version')::integer AND m.review_status='approved'
    AND m.sha256=module->>'sha256' AND m.document=module->'document' AND module->>'projectId'=NEW.project_id::text
    AND module->>'reviewStatus'='approved') THEN RAISE check_violation USING MESSAGE='invalid module snapshot'; END IF;
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER regression_binding_guard BEFORE INSERT OR UPDATE OR DELETE ON run_case_regression_bindings FOR EACH ROW EXECUTE FUNCTION guard_regression_snapshot();
CREATE TRIGGER regression_module_immutable BEFORE UPDATE OR DELETE ON regression_module_versions FOR EACH ROW EXECUTE FUNCTION guard_regression_snapshot();
CREATE FUNCTION guard_run_case_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.document IS DISTINCT FROM OLD.document OR NEW.criteria_hash IS DISTINCT FROM OLD.criteria_hash)
 AND EXISTS(SELECT 1 FROM run_case_regression_bindings WHERE case_id=OLD.id) THEN RAISE check_violation USING MESSAGE='regression case immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER regression_case_immutable BEFORE UPDATE ON run_cases FOR EACH ROW EXECUTE FUNCTION guard_run_case_snapshot();
ALTER TABLE regression_module_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE regression_module_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY module_read ON regression_module_versions FOR SELECT TO localqa_app USING(can_project(project_id));
CREATE POLICY module_register ON regression_module_versions FOR INSERT TO localqa_app WITH CHECK(can_project(project_id,'owner'));
CREATE POLICY module_worker ON regression_module_versions FOR SELECT TO localqa_worker USING(worker_project(project_id));
ALTER TABLE run_case_regression_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_case_regression_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY binding_read ON run_case_regression_bindings FOR SELECT TO localqa_app USING(can_project(project_id));
CREATE POLICY binding_insert ON run_case_regression_bindings FOR INSERT TO localqa_app WITH CHECK(can_project(project_id,'operator'));
CREATE POLICY binding_worker ON run_case_regression_bindings FOR SELECT TO localqa_worker USING(worker_project(project_id));
GRANT SELECT,INSERT ON regression_module_versions,run_case_regression_bindings TO localqa_app;
GRANT SELECT ON regression_module_versions,run_case_regression_bindings TO localqa_worker;
