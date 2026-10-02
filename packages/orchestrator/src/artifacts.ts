import { mkdir, open, rename, rm, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Artifact } from '@localqa/contracts';
import { parseContract } from '@localqa/contracts';
import {
  StorageError,
  type WorkerScope,
  type LeaseProof,
} from '@localqa/storage';
import type { Coordinator } from './core.js';
/** Server-owned durable directory. Worker supplies bytes, never a server path. */
export class ArtifactStore {
  constructor(readonly root: string) {
    this.root = resolve(root);
  }
  async upload(
    coordinator: Coordinator,
    scope: WorkerScope,
    proof: LeaseProof,
    metadata: Artifact,
    bytes: Uint8Array,
  ): Promise<Artifact> {
    const input = parseContract('Artifact', metadata);
    if (
      bytes.byteLength > 25 * 1024 * 1024 ||
      input.bytes !== bytes.byteLength ||
      createHash('sha256').update(bytes).digest('hex') !== input.sha256 ||
      !['applied', 'not_needed'].includes(input.redaction)
    )
      throw new StorageError('VALIDATION_ERROR');
    const work = await coordinator.work(scope, proof);
    const directory = resolve(this.root, scope.projectId, work.run.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = resolve(directory, input.id);
    const temporary = resolve(directory, `.${randomUUID()}`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, path);
      return await coordinator.saveArtifact(scope, proof, input);
    } catch (error) {
      await rm(temporary, { force: true });
      /* Retain bytes on ambiguous DB commit; orphan reconciliation is safer than deleting referenced evidence. */ throw error;
    }
  }
  async get(
    projectId: string,
    runId: string,
    artifactId: string,
  ): Promise<Buffer> {
    for (const id of [projectId, runId, artifactId])
      if (!/^[a-f0-9-]{36}$/i.test(id))
        throw new StorageError('VALIDATION_ERROR');
    return readFile(resolve(this.root, projectId, runId, artifactId));
  }
}
