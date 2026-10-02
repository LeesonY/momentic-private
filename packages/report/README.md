# @localqa/report — T08

ArtifactStore, deterministic fact-based report builder, evidence reference validation, offline export (JSON, Markdown, ZIP), replay degradation, and retention / GC.

## Architecture

- `src/artifacts/`: `ArtifactStorageBackend`, `LocalVolumeArtifactStore` (25MiB artifact limit, 250MiB run quota, defensive path traversal validation), and `S3CompatibleArtifactStore` abstract options.
- `src/builder/`: Fact-based deterministic summary calculation and `ReportBuilder` adhering strictly to `report.schema.json`.
- `src/validation/`: Evidence reference validation; ensures no broken links; maps missing/oversized/redacted materials to manifest status.
- `src/replay/`: Replay materials degradation assessment (trace / rrweb degradation to screenshots and step events).
- `src/export/`: Offline export services:
  - JSON report export.
  - Markdown report (zero external CDNs, relative artifact paths).
  - Offline ZIP archive packaging (report.json, report.md, manifest.json, artifacts/) with automated unpack & checksum verification.
- `src/gc/`: Retention policy enforcement (90d report, 30d binary, 180d audit log) with active-run protection, manual retention (held/pinned) protection, export reference protection, and multi-tenant isolation.
