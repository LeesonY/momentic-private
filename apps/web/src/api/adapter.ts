import type { ApiClient } from './types.ts';
import { HttpApiClient } from './client.ts';
import { MockApiClient } from '../mocks/mockClient.ts';

// By default in dev mode without backend, use MockApiClient.
// Can be toggled at runtime or via VITE_USE_MOCK=false
const storagePreference =
  typeof window !== 'undefined'
    ? localStorage.getItem('LOCALQA_USE_MOCK')
    : null;
const useMock =
  storagePreference !== null ? storagePreference === 'true' : true;

export const defaultApiClient: ApiClient = useMock
  ? new MockApiClient()
  : new HttpApiClient();

export function setUseMock(enabled: boolean): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem('LOCALQA_USE_MOCK', String(enabled));
    window.location.reload();
  }
}

export function isUsingMock(): boolean {
  return defaultApiClient instanceof MockApiClient;
}
