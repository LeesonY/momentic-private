import http from 'node:http';
import { resolve } from 'node:path';
import {
  Database,
  AccountsRepository,
  ProjectRepository,
  ConfigurationRepository,
  ModelRepository,
  RunRepository,
  SecretVault,
  type Actor,
} from '@localqa/storage';
import { Coordinator, ArtifactStore } from '@localqa/orchestrator';
import {
  createGateway,
  createOpenAIAdapter,
  createStubAdapter,
} from '@localqa/model-gateway';
import { createRouter, createRequestHandler } from './app.js';
import type { ApiContext } from './types.js';

export * from './types.js';
export * from './errors.js';
export * from './router.js';
export * from './auth.js';
export * from './app.js';

export interface CreateApiOptions {
  connectionString: string;
  vault: SecretVault;
  artifactsDir?: string | undefined;
  serviceActor?: Actor | undefined;
  publicOrigin?: string | undefined;
  workerSecret?: string | undefined;
  platformSlots?: number | undefined;
  projectSlots?: number | undefined;
  /** Explicit test double. Production entries leave this unset. */
  allowTestStub?: boolean | undefined;
  /** Overrides the process transport. Unset uses the runtime's global fetch. */
  modelTransport?: typeof fetch | undefined;
}

export function resolveModelTransport(override?: typeof fetch): typeof fetch {
  return override ?? globalThis.fetch;
}

export function createApiContext(options: CreateApiOptions): ApiContext {
  const db = new Database(options.connectionString);
  const vault = options.vault;

  const artifactsPath = resolve(options.artifactsDir || '.artifacts');
  const artifacts = new ArtifactStore(artifactsPath);

  const adminActor: Actor = options.serviceActor || {
    userId: '00000000-0000-0000-0000-000000000001',
  };

  const coordinator = new Coordinator({
    db,
    serviceActor: adminActor,
    vault,
    platformSlots: options.platformSlots ?? 4,
    projectSlots: options.projectSlots ?? 4,
  });

  const modelTransport = resolveModelTransport(options.modelTransport);
  // Frozen profile calls use modelTransport. The context gateway is not a
  // production fallback: stub exists only when allowTestStub is set.
  const gateway = options.allowTestStub
    ? createGateway({
        adapter: createStubAdapter(),
        profiles: [
          {
            id: '00000000-0000-0000-0000-000000000002',
            version: 1,
            name: 'test-stub',
            endpoint: 'https://example.com/v1',
            configuredModelId: 'stub',
            kind: 'stub',
            dataBoundary: 'internal',
            capabilities: {
              structuredOutput: true,
              nativeTools: true,
              imageInput: false,
            },
            encryptedApiKey: null,
            approvedFallbackIds: [],
          },
        ],
        decryptKey() {
          return '';
        },
      })
    : createGateway({
        adapter: createOpenAIAdapter(modelTransport),
        profiles: [],
        decryptKey() {
          return '';
        },
      });

  const accountsRepo = new AccountsRepository(db);
  const projectRepo = new ProjectRepository(db);
  const configRepo = new ConfigurationRepository(db, vault);
  const modelRepo = new ModelRepository(db, vault);
  const runRepo = new RunRepository(db, vault);

  return {
    db,
    vault,
    coordinator,
    gateway,
    artifacts,
    accountsRepo,
    projectRepo,
    configRepo,
    modelRepo,
    runRepo,
    adminActor,
    publicOrigin: options.publicOrigin,
    workerSecret: options.workerSecret,
    modelTransport,
  };
}

export function createApiServer(context: ApiContext): http.Server {
  const router = createRouter();
  const requestHandler = createRequestHandler(context, router);
  return http.createServer((req, res) => {
    void requestHandler(req, res);
  });
}
