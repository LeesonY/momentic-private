/**
 * Authenticated HTTP client for the `/internal/v1/*` service boundary.
 *
 * The internal API is a shared network surface, so this client signs every
 * request with the calling service's key from the protected key ring. It exists
 * so the boundary has a real consumer: without one the only way to use those
 * routes would be from inside the API process, and the identity gate could not
 * be exercised end to end.
 *
 * Request/response shapes mirror the frozen internal contracts; the server
 * remains the authority for leases, fencing tokens, policy and verdicts.
 */
import type { ActionPermit, Artifact, Lease, Task, ToolCall } from '@localqa/contracts';
import { StorageError } from '@localqa/storage';
import type { LeaseProof, WorkerScope } from '@localqa/storage';
import {
  InternalServiceSigner,
  type ServiceClientCredential,
} from '@localqa/service-identity';

export interface InternalHttpClientOptions extends ServiceClientCredential {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const STATUS_TO_CODE: Record<number, string> = {
  400: 'VALIDATION_ERROR',
  401: 'FORBIDDEN',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'LEASE_EXPIRED',
  413: 'ARTIFACT_TOO_LARGE',
  422: 'VALIDATION_ERROR',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

export class InternalHttpClient {
  readonly #baseUrl: string;
  readonly #serviceId: string;
  readonly #signer: InternalServiceSigner;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: InternalHttpClientOptions) {
    if (!/^https?:\/\//.test(options.baseUrl))
      throw new Error('baseUrl must be an absolute http(s) URL');
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#serviceId = options.serviceId;
    this.#signer = new InternalServiceSigner({
      serviceId: options.serviceId,
      keyVersion: options.keyVersion,
      secret: options.secret,
    });
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  get serviceId(): string {
    return this.#serviceId;
  }

  /** Lease duration is server-owned; the caller value is not transmitted. */
  async claim(
    scope: WorkerScope,
    capabilities: readonly string[],
  ): Promise<Lease | null> {
    const response = await this.#request(
      'POST',
      '/internal/v1/leases/claim',
      { workerId: scope.workerId, capabilities: [...capabilities] },
      { 'x-project-id': scope.projectId },
    );
    if (response.status === 204) return null;
    return response.json as Lease;
  }

  async heartbeat(
    scope: WorkerScope,
    proof: LeaseProof,
  ): Promise<unknown> {
    const response = await this.#request(
      'POST',
      `/internal/v1/tasks/${proof.taskId}/heartbeat`,
      {
        fencingToken: proof.fencingToken,
        contextVersion: proof.contextVersion,
      },
      this.#proofHeaders(scope, proof),
    );
    return response.json;
  }

  async complete(
    scope: WorkerScope,
    proof: LeaseProof,
    input: {
      fencingToken: number;
      result: Record<string, unknown>;
      results?: unknown[];
      reason?: string;
    },
  ): Promise<Task> {
    const response = await this.#request(
      'POST',
      `/internal/v1/tasks/${proof.taskId}/complete`,
      input,
      this.#proofHeaders(scope, proof),
    );
    return response.json as Task;
  }

  async reserveAction(
    scope: WorkerScope,
    proof: LeaseProof,
    toolCall: ToolCall,
  ): Promise<ActionPermit> {
    const response = await this.#request(
      'POST',
      '/internal/v1/actions/reserve',
      {
        taskId: proof.taskId,
        fencingToken: proof.fencingToken,
        contextVersion: proof.contextVersion,
        toolCall,
      },
      this.#proofHeaders(scope, proof),
    );
    return response.json as ActionPermit;
  }

  async recordActionResult(
    scope: WorkerScope,
    proof: LeaseProof,
    actionId: string,
    result: Record<string, unknown>,
  ): Promise<void> {
    await this.#request(
      'POST',
      `/internal/v1/actions/${actionId}/result`,
      result,
      this.#proofHeaders(scope, proof),
    );
  }

  async modelComplete(
    scope: WorkerScope,
    proof: LeaseProof,
    request: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await this.#request(
      'POST',
      '/internal/v1/model/complete',
      request,
      this.#proofHeaders(scope, proof),
      120_000,
    );
    return response.json;
  }

  async resolveAuth(
    scope: WorkerScope,
    proof: LeaseProof,
    authProfileId: string,
    authProfileVersion: number,
  ): Promise<unknown> {
    const response = await this.#request(
      'POST',
      '/internal/v1/auth/resolve',
      { taskId: proof.taskId, authProfileId, authProfileVersion },
      this.#proofHeaders(scope, proof),
    );
    return response.json;
  }

  async uploadArtifact(
    scope: WorkerScope,
    proof: LeaseProof,
    fields: { taskId: string; kind: string; redaction: string },
    file: { filename: string; bytes: Uint8Array },
  ): Promise<Artifact> {
    const boundary = `----localqa${Date.now().toString(16)}`;
    const body = buildMultipart(boundary, fields, file);
    const response = await this.#request(
      'POST',
      '/internal/v1/artifacts',
      body,
      this.#proofHeaders(scope, proof),
      120_000,
      `multipart/form-data; boundary=${boundary}`,
    );
    return response.json as Artifact;
  }

  #proofHeaders(
    scope: WorkerScope,
    proof: LeaseProof,
  ): Record<string, string> {
    return {
      'x-lease-token': proof.leaseToken,
      'x-worker-id': scope.workerId,
      'x-project-id': scope.projectId,
      'x-fencing-token': String(proof.fencingToken),
      'x-context-version': String(proof.contextVersion),
    };
  }

  async #request(
    method: string,
    path: string,
    body: unknown,
    extraHeaders: Record<string, string> = {},
    timeoutMs?: number,
    contentType?: string,
  ): Promise<{ status: number; json: unknown }> {
    const rawBody: Uint8Array | undefined =
      body === undefined
        ? undefined
        : Buffer.isBuffer(body)
          ? body
          : new TextEncoder().encode(JSON.stringify(body));
    const signed = this.#signer.sign({ method, path, rawBody });
    const init: RequestInit = {
      method,
      headers: {
        ...signed.headers,
        ...extraHeaders,
        'content-type': contentType ?? 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs ?? this.#timeoutMs),
    };
    if (rawBody !== undefined) init.body = Buffer.from(rawBody);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, init);
    } catch (error) {
      throw new StorageError(
        'SERVICE_UNAVAILABLE',
        `internal request failed: ${(error as Error).name}`,
      );
    }
    if (response.status >= 200 && response.status < 300) {
      if (response.status === 204) return { status: 204, json: null };
      return { status: response.status, json: await response.json() };
    }
    // Drain the body but never echo it: it may carry server-side detail.
    await response.text().catch(() => '');
    throw new StorageError(
      (STATUS_TO_CODE[response.status] ??
        'SERVICE_UNAVAILABLE') as ConstructorParameters<typeof StorageError>[0],
      `internal request rejected with HTTP ${response.status}`,
    );
  }
}

function buildMultipart(
  boundary: string,
  fields: Record<string, string>,
  file: { filename: string; bytes: Uint8Array },
): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${file.filename}"\r\ncontent-type: application/octet-stream\r\n\r\n`,
    ),
    Buffer.from(file.bytes),
    Buffer.from('\r\n'),
  );
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}
