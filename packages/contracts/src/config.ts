// Frozen deployment key registry for T02/T05/T09. This is not a DTO contract.
// Defaults come from technical design §8/§12 and SRS §6/NFR-010; EVENT_RETENTION_DAYS
// has no documented default and must be chosen explicitly by the deploy owner.
export const CONFIG_KEYS = Object.freeze({
  // Exactly one source must be configured by the production launcher.
  DATABASE_URL: { kind: 'postgres-url', required: false, sensitive: true },
  DATABASE_URL_FILE: {
    kind: 'protected-file',
    required: false,
    sensitive: true,
  },
  PUBLIC_ORIGIN: { kind: 'https-origin', required: true, sensitive: false },
  DATA_DIR: { kind: 'absolute-path', required: true, sensitive: false },
  MASTER_KEY_FILE: { kind: 'protected-file', required: true, sensitive: true },
  WORKER_IDENTITY_FILE: {
    kind: 'protected-file',
    required: true,
    sensitive: true,
  },
  BROWSER_SLOTS: { kind: 'positive-integer', required: false, default: 4 },
  JOB_LEASE_SECONDS: { kind: 'positive-integer', required: false, default: 45 },
  JOB_HEARTBEAT_SECONDS: {
    kind: 'positive-integer',
    required: false,
    default: 10,
  },
  JOB_POLL_INTERVAL_MS: {
    kind: 'positive-integer',
    required: false,
    default: 1000,
  },
  INPUT_WAIT_TIMEOUT_SECONDS: {
    kind: 'positive-integer',
    required: false,
    default: 300,
  },
  OTP_CONTEXT_WAIT_TIMEOUT_SECONDS: {
    kind: 'positive-integer',
    required: false,
    default: 300,
  },
  EVENT_RETENTION_DAYS: { kind: 'positive-integer', required: true },
  REPORT_RETENTION_DAYS: {
    kind: 'positive-integer',
    required: false,
    default: 90,
  },
  ARTIFACT_RETENTION_DAYS: {
    kind: 'positive-integer',
    required: false,
    default: 30,
  },
  AUDIT_RETENTION_DAYS: {
    kind: 'positive-integer',
    required: false,
    default: 180,
  },
} as const);
for (const descriptor of Object.values(CONFIG_KEYS)) Object.freeze(descriptor);
export type ConfigKey = keyof typeof CONFIG_KEYS;
export const CONFIG_KEY_NAMES = Object.freeze(
  Object.keys(CONFIG_KEYS) as ConfigKey[],
);
// Consumers must enforce: heartbeat < lease, poll <= 1000 ms, OTP wait <= 300 s,
// at most floor(BROWSER_SLOTS / 2) OTP-waiting contexts, HTTPS production origin,
// protected files and reference-aware GC. T01 does not access secrets or start services.
