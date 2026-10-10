# T45 · Safe empty-project deletion (2026-10-10)

## Product behavior

- Global administrator can **permanently delete an empty project** from
  Members & Operations. Archive stays available for nonempty projects.
- The page requires the exact project name, a checkbox, and a separate
  native confirmation dialogue containing the full project UUID.
- Duplicate project names display their 8-character UUID prefixes in the
  project selector. After a successful HTTP 204, the deleted project is
  removed from the client's selector and a remaining project is selected.
- Mock mode never sends a real project deletion.

## Backend safety

- Added `DELETE /api/v1/projects/{projectId}` (platform administrator only).
  Exact confirmation name and optimistic version are required.
- Migration `024_empty_project_deletion.sql` enforces authorization and
  deletion eligibility inside a SECURITY DEFINER function. It locks the
  project and checks every base table with a project_id column before
  deleting only the creator's membership and the project row.
- If ANY run, case, environment, model grant, schedule, credential,
  additional member, or other project-scoped record exists, deletion is
  rejected without changes.
- The immutable audit log preserves the historical project UUID and appends
  `project.deleted`; its foreign key is intentionally removed to permit
  historic references after project deletion. Audit row mutation
  remains prohibited.

## Validation and rollout

- Isolated Docker PostgreSQL 18 integration:
  unauthorized user (401/403), wrong name (422), stale version (409),
  successful empty-project deletion (204), read after delete (404), preserved
  audit rows, and nonempty project blocked (422): **PASS**.
- Web Vite/TypeScript build: PASS.
- Chromium fixture acceptance: duplicate-name selector disambiguation,
  typed confirmation, checkbox, cancel-without-request, successful API
  response, and switching to another project: **PASS**.
- Existing T43 web product-flow regression: PASS.
- Full API suite: 16/17 PASS; separate pre-existing model capability-probe
  test expected one outbound call but observed three. Project deletion test
  itself passed. A model-only filtered rerun cannot reproduce faithfully
  without its preceding authentication fixture.
- Live Docker API image rebuilt and PostgreSQL migration 024 applied
  successfully. API readiness returned HTTP 200.
- Isolated database backup retained in Docker volume
  `localqa-dev-backups`: `pre-project-delete-20261010.dump`.
- The two real user projects named DCP (IDs beginning `75ccdb9d` and
  `7a24544e`) remain in the database and were **not** deleted.

No paid model inference, load testing, Git commits, Git resets, or external
deployments were performed.
