import {
  mkdir,
  open,
  rename,
  rm,
  readFile,
  readdir,
  stat,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, normalize } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Artifact } from '@localqa/contracts';
import { parseContract } from '@localqa/contracts';
import { StorageError } from '@localqa/storage';
import type { ArtifactStorageBackend, ArtifactPutInput } from './types.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_SINGLE_ARTIFACT_BYTES = 25 * 1024 * 1024; // 25 MiB
export const MAX_RUN_ARTIFACTS_QUOTA_BYTES = 250 * 1024 * 1024; // 250 MiB

export class LocalVolumeArtifactStore implements ArtifactStorageBackend {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private validateId(name: string, value: string): void {
    if (!value || typeof value !== 'string' || !UUID_REGEX.test(value)) {
      throw new StorageError('VALIDATION_ERROR');
    }
  }

  private resolveRunDir(projectId: string, runId: string): string {
    this.validateId('projectId', projectId);
    this.validateId('runId', runId);

    const dir = resolve(this.root, projectId, runId);
    const normalized = normalize(dir);
    if (!normalized.startsWith(this.root)) {
      throw new StorageError('VALIDATION_ERROR');
    }
    return normalized;
  }

  private resolveArtifactPath(
    projectId: string,
    runId: string,
    artifactId: string,
  ): string {
    this.validateId('artifactId', artifactId);
    const runDir = this.resolveRunDir(projectId, runId);
    const filePath = resolve(runDir, artifactId);
    const normalized = normalize(filePath);
    if (!normalized.startsWith(runDir)) {
      throw new StorageError('VALIDATION_ERROR');
    }
    return normalized;
  }

  checksum(data: Buffer | Uint8Array): string {
    return createHash('sha256').update(data).digest('hex');
  }

  async getRunTotalBytes(projectId: string, runId: string): Promise<number> {
    const runDir = this.resolveRunDir(projectId, runId);
    if (!existsSync(runDir)) return 0;

    let total = 0;
    try {
      const entries = await readdir(runDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && !entry.name.startsWith('.')) {
          const s = await stat(resolve(runDir, entry.name));
          total += s.size;
        }
      }
    } catch {
      // ignore
    }
    return total;
  }

  async put(
    metadata: ArtifactPutInput,
    data: Buffer | Uint8Array,
  ): Promise<Artifact> {
    this.validateId('projectId', metadata.projectId);
    this.validateId('runId', metadata.runId);
    this.validateId('artifactId', metadata.id);

    const byteLength = data.byteLength;
    if (byteLength > MAX_SINGLE_ARTIFACT_BYTES) {
      throw new StorageError('VALIDATION_ERROR');
    }

    if (metadata.bytes !== byteLength) {
      throw new StorageError('VALIDATION_ERROR');
    }

    const calculatedSha256 = this.checksum(data);
    if (metadata.sha256 !== calculatedSha256) {
      throw new StorageError('VALIDATION_ERROR');
    }

    if (!['applied', 'not_needed'].includes(metadata.redaction)) {
      throw new StorageError('VALIDATION_ERROR');
    }

    const runDir = this.resolveRunDir(metadata.projectId, metadata.runId);
    const currentRunTotal = await this.getRunTotalBytes(
      metadata.projectId,
      metadata.runId,
    );
    if (currentRunTotal + byteLength > MAX_RUN_ARTIFACTS_QUOTA_BYTES) {
      throw new StorageError('VALIDATION_ERROR');
    }

    await mkdir(runDir, { recursive: true, mode: 0o700 });
    const targetPath = resolve(runDir, metadata.id);
    const tempPath = resolve(runDir, `.${randomUUID()}`);

    const handle = await open(tempPath, 'wx', 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await rename(tempPath, targetPath);
    } catch (err) {
      await rm(tempPath, { force: true });
      throw err;
    }

    const contentUrl =
      metadata.contentUrl ??
      `/api/v1/projects/${metadata.projectId}/runs/${metadata.runId}/artifacts/${metadata.id}/content`;

    const artifact: Artifact = {
      id: metadata.id,
      projectId: metadata.projectId,
      runId: metadata.runId,
      kind: metadata.kind,
      status: 'available',
      bytes: byteLength,
      sha256: calculatedSha256,
      contentUrl,
      redaction: metadata.redaction,
      error: metadata.error ?? null,
      createdAt: metadata.createdAt ?? new Date().toISOString(),
      taskId: metadata.taskId ?? null,
      stepId: metadata.stepId ?? null,
      caseId: metadata.caseId ?? null,
      snapshotId: metadata.snapshotId ?? null,
    };

    return parseContract('Artifact', artifact);
  }

  async upload(
    coordinator: {
      work(scope: unknown, proof: unknown): Promise<{ run: { id: string } }>;
      saveArtifact(
        scope: unknown,
        proof: unknown,
        artifact: Artifact,
      ): Promise<Artifact>;
    },
    scope: { projectId: string; workerId: string },
    proof: unknown,
    metadata: Artifact,
    bytes: Uint8Array,
  ): Promise<Artifact> {
    const work = await coordinator.work(scope, proof);
    const input = parseContract('Artifact', metadata);
    const saved = await this.put(
      {
        id: input.id,
        projectId: scope.projectId,
        runId: work.run.id,
        kind: input.kind,
        redaction: input.redaction,
        bytes: bytes.byteLength,
        sha256: this.checksum(bytes),
        taskId: input.taskId,
        stepId: input.stepId,
        caseId: input.caseId,
        snapshotId: input.snapshotId,
        contentUrl: input.contentUrl,
        error: input.error,
        createdAt: input.createdAt,
      },
      bytes,
    );
    return coordinator.saveArtifact(scope, proof, saved);
  }

  async get(
    projectId: string,
    runId: string,
    artifactId: string,
  ): Promise<Buffer> {
    const filePath = this.resolveArtifactPath(projectId, runId, artifactId);
    if (!existsSync(filePath)) {
      throw new StorageError('NOT_FOUND');
    }
    return readFile(filePath);
  }

  async delete(
    projectId: string,
    runId: string,
    artifactId: string,
  ): Promise<void> {
    const filePath = this.resolveArtifactPath(projectId, runId, artifactId);
    await rm(filePath, { force: true });
  }

  async exists(
    projectId: string,
    runId: string,
    artifactId: string,
  ): Promise<boolean> {
    const filePath = this.resolveArtifactPath(projectId, runId, artifactId);
    return existsSync(filePath);
  }
}
