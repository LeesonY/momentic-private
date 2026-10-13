import type { ModelProfile } from '@localqa/contracts';
import {
  createAnthropicAdapter,
  createOpenAIAdapter,
  createStubAdapter,
  type GatewayProfile,
} from '@localqa/model-gateway';
import type { ModelOptions } from './model.js';

export interface LoadedModelVersion {
  document: ModelProfile;
  apiKey: string | null;
}

/** Non-secret slot. The credential stays in the map and is never this string. */
export function credentialSlot(profileId: string, version: number): string {
  return `${profileId}:${version}`;
}

/**
 * Worker process model options.
 * allowTestStub keeps the isolated stub adapter and never reads a credential.
 * Otherwise each frozen profile version keeps its own credential slot.
 */
export function createWorkerModelOptions(input: {
  transport: typeof fetch;
  allowTestStub?: boolean | undefined;
  load: (profileId: string, version: number) => Promise<LoadedModelVersion>;
  readApprovedImage?: ModelOptions['readApprovedImage'];
}): ModelOptions {
  const keys = new Map<string, string>();
  const allowTestStub = input.allowTestStub === true;
  const openai = createOpenAIAdapter(input.transport);
  const anthropic = createAnthropicAdapter(input.transport);
  const stub = createStubAdapter();
  return {
    adapter: allowTestStub ? stub : openai,
    adapterForKind: (kind) => {
      if (allowTestStub) return stub;
      return kind === 'anthropic_messages' ? anthropic : openai;
    },
    allowTestStub,
    async profile(id, version) {
      const loaded = await input.load(id, version);
      const document = loaded.document;
      if (document.id !== id || document.version !== version)
        throw new Error(
          'Frozen model version did not match the requested profile',
        );
      if (allowTestStub) {
        if (!document.configuredModelId.startsWith('stub-'))
          throw new Error('Test stub profile not configured');
        return stubProfile(document);
      }
      const slot = credentialSlot(document.id, document.version);
      if (loaded.apiKey) keys.set(slot, loaded.apiKey);
      else keys.delete(slot);
      return {
        id: document.id,
        version: document.version,
        name: document.name,
        endpoint: document.endpoint,
        configuredModelId: document.configuredModelId,
        kind: document.adapter,
        dataBoundary: document.dataBoundary,
        capabilities: document.capabilities,
        responseFormat: document.responseFormat ?? 'json_schema',
        status: document.status,
        ...(document.maxOutputTokens !== undefined
          ? { maxOutputTokens: document.maxOutputTokens }
          : {}),
        ...(document.contextWindowTokens !== undefined
          ? { contextWindowTokens: document.contextWindowTokens }
          : {}),
        encryptedApiKey: loaded.apiKey ? slot : null,
        approvedFallbackIds: [],
      };
    },
    decryptKey(id, ciphertext) {
      if (allowTestStub)
        throw new Error('Test stub must not decrypt API credentials');
      const prefix = `${id}:`;
      if (!ciphertext.startsWith(prefix)) return '';
      return keys.get(ciphertext) ?? '';
    },
    ...(input.readApprovedImage
      ? { readApprovedImage: input.readApprovedImage }
      : {}),
  };
}

function stubProfile(document: ModelProfile): GatewayProfile {
  return {
    id: document.id,
    version: document.version,
    name: document.name,
    endpoint: document.endpoint,
    configuredModelId: document.configuredModelId,
    kind: 'stub',
    ...(document.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: document.maxOutputTokens }),
    ...(document.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: document.contextWindowTokens }),
    dataBoundary: document.dataBoundary,
    capabilities: {
      structuredOutput: true,
      nativeTools: true,
      imageInput: true,
    },
    encryptedApiKey: null,
    approvedFallbackIds: [],
  };
}
