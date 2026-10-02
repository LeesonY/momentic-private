import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Report, Export } from '@localqa/contracts';
import { parseContract } from '@localqa/contracts';
import { StorageError } from '@localqa/storage';
import type {
  ArtifactStorageBackend,
  ManifestMap,
} from '../artifacts/types.js';
import { renderMarkdownReport } from './markdown.js';
import { createOfflineZipArchive, type ManifestDocument } from './zip.js';

export interface ExportServiceOptions {
  artifactStore: ArtifactStorageBackend;
}

export class ExportService {
  readonly artifactStore: ArtifactStorageBackend;

  constructor(options: ExportServiceOptions) {
    this.artifactStore = options.artifactStore;
  }

  exportJson(report: Report): { content: string; filename: string } {
    const isSnapshot = !['completed', 'cancelled', 'failed'].includes(
      report.run.status,
    );
    const suffix = isSnapshot ? '-snapshot' : '';
    const filename = `localqa-report-${report.run.id}${suffix}.json`;
    return {
      content: JSON.stringify(report, null, 2),
      filename,
    };
  }

  exportMarkdown(
    report: Report,
    manifest?: ManifestMap,
  ): { content: string; filename: string } {
    const isSnapshot = !['completed', 'cancelled', 'failed'].includes(
      report.run.status,
    );
    const suffix = isSnapshot ? '-snapshot' : '';
    const filename = `localqa-report-${report.run.id}${suffix}.md`;
    return {
      content: renderMarkdownReport(report, manifest),
      filename,
    };
  }

  async exportZip(
    client: PoolClient,
    report: Report,
    manifest: ManifestMap,
    options?: { retainDays?: number },
  ): Promise<{
    exportRecord: Export;
    zipBuffer: Buffer;
    filename: string;
    manifestDocument: ManifestDocument;
  }> {
    const isSnapshot = !['completed', 'cancelled', 'failed'].includes(
      report.run.status,
    );
    const suffix = isSnapshot ? '-snapshot' : '';
    const filename = `localqa-export-${report.run.id}${suffix}.zip`;

    const { zipBuffer, manifestDocument } = await createOfflineZipArchive(
      report,
      manifest,
      this.artifactStore,
    );

    const artifactId = randomUUID();
    const retainDays = options?.retainDays ?? 30;

    // 1. Put ZIP into ArtifactStore
    const zipArtifact = await this.artifactStore.put(
      {
        id: artifactId,
        projectId: report.run.projectId,
        runId: report.run.id,
        kind: 'export',
        redaction: 'not_needed',
        bytes: zipBuffer.byteLength,
        sha256: this.artifactStore.checksum(zipBuffer),
        error: null,
      },
      zipBuffer,
    );

    // 2. Persist artifact record in DB
    await client.query(
      `INSERT INTO artifacts(id, project_id, run_id, document, retain_until, held)
       VALUES($1, $2, $3, $4, clock_timestamp() + ($5 || ' days')::interval, false)`,
      [
        artifactId,
        report.run.projectId,
        report.run.id,
        zipArtifact,
        retainDays,
      ],
    );

    // 3. Create Export record
    const exportId = randomUUID();
    const exportRecord: Export = {
      id: exportId,
      runId: report.run.id,
      status: 'ready',
      format: 'zip',
      artifactId,
      snapshotAt: new Date().toISOString(),
      error: null,
    };

    const validatedExport = parseContract('Export', exportRecord);

    await client.query(
      `INSERT INTO exports(id, project_id, run_id, status, document, report_snapshot, artifact_id, retain_until, held)
       VALUES($1, $2, $3, 'ready', $4, $5, $6, clock_timestamp() + ($7 || ' days')::interval, false)`,
      [
        exportId,
        report.run.projectId,
        report.run.id,
        validatedExport,
        report,
        artifactId,
        retainDays,
      ],
    );

    return {
      exportRecord: validatedExport,
      zipBuffer,
      filename,
      manifestDocument,
    };
  }

  async getExport(
    client: PoolClient,
    projectId: string,
    exportId: string,
  ): Promise<{ exportRecord: Export; zipBuffer: Buffer }> {
    const row = (
      await client.query<{
        id: string;
        project_id: string;
        run_id: string;
        document: Export;
        artifact_id: string;
      }>('SELECT * FROM exports WHERE project_id = $1 AND id = $2', [
        projectId,
        exportId,
      ])
    ).rows[0];

    if (!row) {
      throw new StorageError('NOT_FOUND');
    }

    const zipBuffer = await this.artifactStore.get(
      projectId,
      row.run_id,
      row.artifact_id,
    );

    return {
      exportRecord: row.document,
      zipBuffer,
    };
  }
}
