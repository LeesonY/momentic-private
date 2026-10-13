-- A separate tombstone preserves immutable terminal runs and saved baselines.
CREATE TABLE run_deletions (
 project_id uuid NOT NULL,
 run_id uuid NOT NULL,
 deleted_by uuid NOT NULL REFERENCES users(id),
 deleted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(project_id,run_id),
 FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id)
);
ALTER TABLE run_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_deletions FORCE ROW LEVEL SECURITY;
CREATE POLICY deletion_read ON run_deletions FOR SELECT TO localqa_app USING(can_project(project_id));
CREATE POLICY deletion_write ON run_deletions FOR INSERT TO localqa_app WITH CHECK(can_project(project_id,'owner') AND deleted_by=actor_id() AND EXISTS(SELECT 1 FROM runs r WHERE r.project_id=run_deletions.project_id AND r.id=run_deletions.run_id AND r.status IN ('completed','cancelled','failed')));
GRANT SELECT,INSERT ON run_deletions TO localqa_app;
CREATE TRIGGER deletion_immutable BEFORE UPDATE OR DELETE ON run_deletions FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE FUNCTION run_visible(pid uuid,rid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.can_project(pid) AND NOT EXISTS(
  SELECT 1 FROM public.run_deletions WHERE project_id=pid AND run_id=rid
 );
$$;
REVOKE ALL ON FUNCTION run_visible(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION run_visible(uuid,uuid) TO localqa_app;

-- Preserve each existing read policy, including private auth exclusions, while
-- hiding removed runs and public child resources (reports, steps, artifacts).
DO $$
DECLARE item record; run_column text;
BEGIN
 FOR item IN
  SELECT c.relname AS table_name,pg_get_expr(p.polqual,p.polrelid) AS rule
  FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND p.polname='member_read'
   AND (c.relname='runs' OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='run_id' AND NOT a.attisdropped))
 LOOP
  run_column:=CASE WHEN item.table_name='runs' THEN 'id' ELSE 'run_id' END;
  EXECUTE format('ALTER POLICY member_read ON public.%I USING ((%s) AND public.run_visible(project_id,%I))',item.table_name,item.rule,run_column);
 END LOOP;
END $$;
