import { createHash } from 'node:crypto';
import type { Artifact } from '@localqa/contracts';
import { StorageError } from '@localqa/storage';
import type {
  ArtifactStorageBackend,
  ArtifactPutInput,
  S3CompatibleOptions,
} from './types.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Interface definition and placeholder implementation for S3-compatible object stores
 * (AWS S3, Cloudflare R2, MinIO, Ceph) for cluster and multi-tenant deployments.
 */
export class S3CompatibleArtifactStore implements ArtifactStorageBackend {
  readonly options: S3CompatibleOptions;

  constructor(options: S3CompatibleOptions) {
    if (!options.bucket || !options.endpoint) {
      throw new StorageError('VALIDATION_ERROR');
    }
    this.options = { ...options };
  }

  private validateId(value: string): void {
    if (!value || typeof value !== 'string' || !UUID_REGEX.test(value)) {
      throw new StorageError('VALIDATION_ERROR');
    }
  }

  getObjectKey(projectId: string, runId: string, artifactId: string): string {
    this.validateId(projectId);
    this.validateId(runId);
    this.validateId(artifactId);
    const prefix = this.options.prefix
      ? `${this.options.prefix.replace(/\/+$/, '')}/`
      : '';
    return `${prefix}${projectId}/${runId}/${artifactId}`;
  }

  checksum(data: Buffer | Uint8Array): string {
    return createHash('sha256').update(data).digest('hex');
  }

  async getRunTotalBytes(_projectId: string, _runId: string): Promise<number> {
    // S3 ListObjectsV2 summary
    return 0;
  }

  async put(
    metadata: ArtifactPutInput,
    _data: Buffer | Uint8Array,
  ): Promise<Artifact> {
    this.validateId(metadata.projectId);
    this.validateId(metadata.runId);
    this.validateId(metadata.id);

    throw new StorageError('SERVICE_UNAVAILABLE');
  }

  async get(
    projectId: string,
    runId: string,
    artifactId: string,
  ): Promise<Buffer> {
    this.validateId(projectId);
    this.validateId(runId);
    this.validateId(artifactId);
    throw new StorageError('SERVICE_UNAVAILABLE');
  }

  async delete(
    projectId: string,
    runId: string,
    artifactId: string,
  ): Promise<void> {
    this.validateId(projectId);
    this.validateId(runId);
    this.validateId(artifactId);
    throw new StorageError('SERVICE_UNAVAILABLE');
  }

  async exists(
    projectId: string,
    runId: string,
    artifactId: string,
  ): Promise<boolean> {
    this.validateId(projectId);
    this.validateId(runId);
    this.validateId(artifactId);
    return false;
  }
}
