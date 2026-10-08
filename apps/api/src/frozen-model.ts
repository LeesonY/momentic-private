import type { ModelProfile } from '@localqa/contracts';
import {
  createGateway,
  createOpenAIAdapter,
  type Gateway,
} from '@localqa/model-gateway';

export interface FrozenModel {
  document: ModelProfile;
  apiKey: string | null;
}

/**
 * One gateway for this call's frozen profile.
 * No artifact resolver: an approved image stays blocked until a later package.
 * The transport is the caller's fetch. This function does not use global fetch.
 */
export function createFrozenGateway(
  frozen: FrozenModel,
  transport: typeof fetch,
): Gateway {
  const document = frozen.document;
  return createGateway({
    adapter: createOpenAIAdapter(transport),
    profiles: [
      {
        id: document.id,
        version: document.version,
        name: document.name,
        endpoint: document.endpoint,
        configuredModelId: document.configuredModelId,
        kind: 'openai_compatible',
        dataBoundary: document.dataBoundary,
        capabilities: document.capabilities,
        responseFormat: document.responseFormat ?? 'json_schema',
        status: document.status,
        encryptedApiKey: frozen.apiKey ? 'set' : null,
        approvedFallbackIds: [],
      },
    ],
    decryptKey() {
      return frozen.apiKey ?? '';
    },
  });
}
