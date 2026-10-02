import type { Artifact } from '@localqa/contracts';

export type ArtifactKind =
  'screenshot' | 'trace' | 'rrweb' | 'network' | 'console' | 'export' | 'other';

export type ArtifactRedaction = 'applied' | 'not_needed' | 'failed';

export type ArtifactStatus = 'available' | 'degraded' | 'missing' | 'failed';

// Same enum as Artifact.status. too_large and redacted are not contract values.
export type ManifestArtifactStatus = ArtifactStatus;

export interface ArtifactPutInput {
  id: string;
  projectId: string;
  runId: string;
  kind: ArtifactKind;
  redaction: ArtifactRedaction;
  bytes: number;
  sha256: string;
  taskId?: string | null;
  stepId?: string | null;
  caseId?: string | null;
  snapshotId?: string | null;
  contentUrl?: string | null;
  error?: string | null;
  createdAt?: string;
  retainUntil?: Date | string;
  held?: boolean;
}

export interface ArtifactManifestEntry {
  id: string;
  kind: ArtifactKind;
  status: ManifestArtifactStatus;
  bytes: number | null;
  sha256: string | null;
  relativePath: string | null;
  error: string | null;
}

export type ManifestMap = Map<string, ArtifactManifestEntry>;

export interface S3CompatibleOptions {
  bucket: string;
  endpoint: string;
  region?: string;
  prefix?: string;
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export interface ArtifactStorageBackend {
  put(metadata: ArtifactPutInput, data: Buffer | Uint8Array): Promise<Artifact>;
  get(projectId: string, runId: string, artifactId: string): Promise<Buffer>;
  delete(projectId: string, runId: string, artifactId: string): Promise<void>;
  exists(
    projectId: string,
    runId: string,
    artifactId: string,
  ): Promise<boolean>;
  checksum(data: Buffer | Uint8Array): string;
  getRunTotalBytes(projectId: string, runId: string): Promise<number>;
}
