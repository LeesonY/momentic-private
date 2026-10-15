/**
 * Test support for the internal service-identity boundary.
 *
 * Tests must sign internal requests exactly like a real peer instead of being
 * exempted from the gate: an exemption would make the suite unable to detect a
 * regression that removes authentication.
 */
import { randomBytes } from 'node:crypto';
import {
  InternalServiceSigner,
  InternalServiceVerifier,
} from '@localqa/service-identity';

function toBytes(body) {
  if (body === undefined || body === null) return undefined;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return body;
  if (typeof body === 'string') return Buffer.from(body);
  return Buffer.from(JSON.stringify(body));
}

/**
 * Builds a key ring with one key per service and returns the verifier to pass
 * into `createApiContext` plus a signer for request headers.
 */
export function createTestServiceIdentity(serviceIds = ['worker', 'orchestrator']) {
  const secrets = new Map();
  const services = {};
  for (const serviceId of serviceIds) {
    const secret = randomBytes(32);
    secrets.set(serviceId, secret);
    services[serviceId] = {
      activeVersion: 1,
      keys: { 1: secret.toString('base64') },
    };
  }
  const document = { services };
  const sign = (serviceId, { method = 'POST', path, body, keyVersion = 1 }) => {
    const secret = secrets.get(serviceId);
    if (!secret) throw new Error(`unknown test service '${serviceId}'`);
    const signer = new InternalServiceSigner({
      serviceId,
      keyVersion,
      secret,
    });
    return signer.sign({ method, path, rawBody: toBytes(body) }).headers;
  };
  /**
   * Signs with an explicit clock so tests can exercise the staleness window
   * without mocking the process clock. The returned headers are genuinely
   * signed for the given timestamp, not tampered with afterwards.
   */
  const signAt = (
    serviceId,
    { method = 'POST', path, body, keyVersion = 1, timestampMs },
  ) => {
    const secret = secrets.get(serviceId);
    if (!secret) throw new Error(`unknown test service '${serviceId}'`);
    return new InternalServiceSigner({
      serviceId,
      keyVersion,
      secret,
      now: () => timestampMs,
    }).sign({ method, path, rawBody: toBytes(body) }).headers;
  };
  return {
    document,
    verifier: new InternalServiceVerifier(document),
    serviceIds: [...serviceIds],
    sign,
    signAt,
    /** A key the ring has never seen: used for forgery tests. */
    forgedHeaders: (path, body) =>
      new InternalServiceSigner({
        serviceId: 'worker',
        keyVersion: 1,
        secret: randomBytes(32),
      }).sign({ method: 'POST', path, rawBody: toBytes(body) }).headers,
  };
}
