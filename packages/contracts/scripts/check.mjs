import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import SwaggerParser from '@apidevtools/swagger-parser';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const docs = {};
const files = [
  'domain.schema.json',
  'events.schema.json',
  'openapi.json',
  'regression.schema.json',
  'report.schema.json',
  'tools.schema.json',
];
// Git converts checked-out text to CRLF on Windows; compare the generator's
// semantic LF text without hiding real generated-content differences.
const canonicalText = (text) => text.replace(/\r\n/g, '\n');
for (const file of files)
  docs[file] = JSON.parse(
    await readFile(`${root}docs/contracts/${file}`, 'utf8'),
  );
// Execute an unchanged copy of the authoritative generator in project-local scratch.
// Never run it in docs/, where it would rewrite shared documents.
await mkdir(`${root}.localqa-t01`, { recursive: true });
const staging = await mkdtemp(`${root}.localqa-t01/contract-check-`);
try {
  await copyFile(
    `${root}docs/build_contracts.py`,
    `${staging}/build_contracts.py`,
  );
  // On Windows, python3 can resolve to an unusable Microsoft Store alias.
  // Prefer the installed Python launcher; Linux CI continues to use python3.
  const python = process.platform === 'win32' ? 'py' : 'python3';
  const pythonArgs =
    process.platform === 'win32'
      ? ['-3', `${staging}/build_contracts.py`]
      : [`${staging}/build_contracts.py`];
  const stdout = execFileSync(python, pythonArgs, {
    cwd: root,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8',
  });
  console.log(stdout.trim());
  for (const file of files)
    assert.equal(
      canonicalText(await readFile(`${staging}/contracts/${file}`, 'utf8')),
      canonicalText(await readFile(`${root}docs/contracts/${file}`, 'utf8')),
      `Source generator drift: ${file}`,
    );
  for (const file of [
    'run-create.json',
    'report.sample.json',
    'tool-call.json',
    'event.sample.json',
    'regression.case.json',
  ])
    assert.equal(
      canonicalText(await readFile(`${staging}/examples/${file}`, 'utf8')),
      canonicalText(await readFile(`${root}docs/examples/${file}`, 'utf8')),
      `Example generator drift: ${file}`,
    );
} finally {
  await rm(staging, { recursive: true, force: true });
}
const ajv = new Ajv2020({
  strictSchema: true,
  strictTypes: false,
  strictTuples: false,
  strictRequired: false,
  allowUnionTypes: true,
  allErrors: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
});
addFormats(ajv, { mode: 'full' });
ajv.addFormat('binary', true);
for (const keyword of ['x-roles', 'x-result-schema', 'x-sensitive'])
  ajv.addKeyword(keyword);
let definitionCount = 0;
for (const file of files.filter((file) => file !== 'openapi.json')) {
  const document = docs[file];
  assert(ajv.validateSchema(document), `${file}: ${ajv.errorsText()}`);
  ajv.addSchema(document, file);
  for (const [name, schema] of Object.entries(document.$defs)) {
    assert.deepEqual(
      schema,
      docs['domain.schema.json'].$defs[name],
      `${file}: divergent ${name}`,
    );
    assert(ajv.getSchema(`${file}#/$defs/${name}`));
    definitionCount++;
  }
  if (document.$ref) assert(ajv.getSchema(file));
}
function normalize(value) {
  if (typeof value === 'string')
    return value.replace('#/components/schemas/', '#/$defs/');
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, normalize(child)]),
    );
  return value;
}
const api = docs['openapi.json'];
assert.deepEqual(
  normalize(api.components.schemas),
  docs['domain.schema.json'].$defs,
  'OpenAPI/shared definition divergence',
);
await SwaggerParser.validate(structuredClone(api));
let operations = 0;
let apiSchemas = 0;
const operationIds = new Set();
for (const [path, methods] of Object.entries(api.paths)) {
  for (const [method, op] of Object.entries(methods)) {
    assert(
      !operationIds.has(op.operationId),
      `Duplicate operationId: ${op.operationId}`,
    );
    operationIds.add(op.operationId);
    assert.equal(
      op.tags.includes('Internal'),
      path.startsWith('/internal/'),
      `${method} ${path} audience`,
    );
    const schemas = op.parameters.map((parameter) => parameter.schema);
    for (const media of Object.values(op.requestBody?.content ?? {}))
      schemas.push(media.schema);
    for (const response of Object.values(op.responses))
      for (const media of Object.values(response.content ?? {}))
        schemas.push(media.schema);
    for (const schema of schemas) {
      ajv.compile({
        ...normalize(schema),
        $defs: docs['domain.schema.json'].$defs,
      });
      apiSchemas++;
    }
    operations++;
  }
}
const examples = {
  'run-create.json': ['domain.schema.json', 'RunCreate'],
  'report.sample.json': ['report.schema.json', 'Report'],
  'tool-call.json': ['tools.schema.json', 'ToolCall'],
  'event.sample.json': ['events.schema.json', 'RunEvent'],
  'regression.case.json': ['regression.schema.json', 'RegressionDocument'],
};
for (const [file, [document, name]] of Object.entries(examples)) {
  const validator = ajv.getSchema(`${document}#/$defs/${name}`);
  const value = JSON.parse(
    await readFile(`${root}docs/examples/${file}`, 'utf8'),
  );
  assert(validator(value), `${file}: ${ajv.errorsText(validator.errors)}`);
}
console.log(
  JSON.stringify({
    result: 'passed',
    generatorFilesCompared: 11,
    jsonSchemaDraft: '2020-12',
    openapi: api.openapi,
    definitions: definitionCount,
    domainDefinitions: Object.keys(docs['domain.schema.json'].$defs).length,
    operations,
    apiSchemas,
    examples: Object.keys(examples).length,
    note: 'Contract engineering only; no M0/P0 gate or business-semantic validation claimed.',
  }),
);
