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
import { createGateway, createStubAdapter } from '@localqa/model-gateway';
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

  const stubAdapter = createStubAdapter();
  const gateway = createGateway({
    adapter: stubAdapter,
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
  };
}

export function createApiServer(context: ApiContext): http.Server {
  const router = createRouter();
  const requestHandler = createRequestHandler(context, router);
  return http.createServer((req, res) => {
    void requestHandler(req, res);
  });
}
