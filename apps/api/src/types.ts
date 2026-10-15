import type { IncomingMessage, ServerResponse } from 'node:http';
import type { User, RunEvent } from '@localqa/contracts';
import type {
  Database,
  Actor,
  SecretVault,
  AccountsRepository,
  ProjectRepository,
  ConfigurationRepository,
  ModelRepository,
  RunRepository,
} from '@localqa/storage';
import type { Coordinator, ArtifactStore } from '@localqa/orchestrator';
import type { InternalServiceVerifier } from '@localqa/service-identity';
import type { Gateway } from '@localqa/model-gateway';

export interface ApiContext {
  db: Database;
  vault: SecretVault;
  coordinator: Coordinator;
  gateway: Gateway;
  artifacts: ArtifactStore;
  accountsRepo: AccountsRepository;
  projectRepo: ProjectRepository;
  configRepo: ConfigurationRepository;
  modelRepo: ModelRepository;
  runRepo: RunRepository;
  adminActor: Actor;
  publicOrigin?: string | undefined;
  /**
   * Verifier for the `/internal/v1/*` service-identity boundary. When absent
   * every internal route fails closed; a deployment must supply it explicitly.
   */
  serviceIdentity?: InternalServiceVerifier | undefined;
  /** Process transport. Production uses global fetch unless a test injects one. */
  modelTransport: typeof fetch;
}

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  api: ApiContext;
  method: string;
  pathname: string;
  query: Record<string, string>;
  headers: Record<string, string | undefined>;
  params: Record<string, string>;
  body: unknown;
  rawBody: Buffer;
  actor: Actor | null;
  user: User | null;
  requestId: string;
}

export type RouteHandler = (ctx: RequestContext) => Promise<unknown>;

export interface RouteMatch {
  handler: RouteHandler;
  params: Record<string, string>;
}

export interface SseSubscriber {
  id: string;
  runId: string;
  lastSeq: number;
  send: (event: RunEvent) => void;
  close: () => void;
}
