import {
  parseContract,
  validateContract,
  getValidator,
  type RunCreate,
  type ToolCall,
  type ErrorCode,
  type ConfigKey,
} from '../src/index.js';

const request: RunCreate = {
  projectId: 'uuid',
  targetUrl: 'https://example.test/',
};
const parsed: RunCreate = parseContract('RunCreate', request);
void parsed;
const value: unknown = {};
if (getValidator('RunCreate')(value)) {
  const inferred: RunCreate = value;
  void inferred;
}
const result = validateContract('ToolCall', value);
if (result.success) {
  const inferred: ToolCall = result.data;
  void inferred;
}
const knownCode: ErrorCode = 'LEASE_EXPIRED';
const knownKey: ConfigKey = 'MASTER_KEY_FILE';
void knownCode;
void knownKey;
const unknownField: RunCreate = {
  projectId: 'uuid',
  targetUrl: 'https://example.test/',
  // @ts-expect-error No invented RunCreate fields.
  guessedField: true,
};
const wrongBudget: RunCreate = {
  projectId: 'uuid',
  targetUrl: 'https://example.test/',
  // @ts-expect-error Invalid budget field type.
  budget: { maxCases: '8' },
};
// @ts-expect-error Forbidden tool names are not in the generated union.
const invalidTool: ToolCall = { name: 'shell', args: {} };
// @ts-expect-error Required request field is missing.
const missingField: RunCreate = { projectId: 'uuid' };
void unknownField;
void wrongBudget;
void invalidTool;
void missingField;
