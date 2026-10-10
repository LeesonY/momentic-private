import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';

export const root = fileURLToPath(new URL('../../../', import.meta.url));
const files = [
  'domain.schema.json',
  'events.schema.json',
  'openapi.json',
  'regression.schema.json',
  'report.schema.json',
  'tools.schema.json',
];
const documents = {};
const hashes = {};
for (const file of files) {
  // Hash the canonical repository content, not Git's platform-specific
  // working-tree CRLF translation. Generated manifests must match on Windows
  // and Linux for the same committed contracts.
  const raw = (await readFile(`${root}docs/contracts/${file}`, 'utf8')).replace(
    /\r\n/g,
    '\n',
  );
  documents[file] = JSON.parse(raw);
  hashes[file] = createHash('sha256').update(raw).digest('hex');
}
const defs = documents['domain.schema.json'].$defs;
const names = Object.keys(defs).sort();
// All definitions are reachable, including recursive JsonValue. Do not synthesize DTO fields.
const types = await compile(
  {
    ...documents['domain.schema.json'],
    anyOf: names.map((name) => ({ $ref: `#/$defs/${name}` })),
  },
  'Contract',
  {
    bannerComment:
      '/* Generated from docs/contracts/*.json. DO NOT EDIT. Runtime schemas are authoritative for refinements. */',
    additionalProperties: true,
    maxItems: -1,
    strictIndexSignatures: true,
    format: true,
  },
);
const mapping = `\nexport interface ContractTypes {\n${names.map((name) => `  ${name}: ${name};`).join('\n')}\n}\n`;
const outputs = {
  'types.ts': types + mapping,
  'schemas.json': JSON.stringify(documents, null, 2) + '\n',
  'manifest.json':
    JSON.stringify(
      { schemaVersion: 1, sourceHashes: hashes, definitions: names },
      null,
      2,
    ) + '\n',
};
const out = `${root}packages/contracts/src/generated`;
if (!process.argv.includes('--check')) await mkdir(out, { recursive: true });
for (const [file, content] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) {
    if ((await readFile(`${out}/${file}`, 'utf8')) !== content) {
      throw new Error(
        `Generated file drift: ${file}; run pnpm contracts:generate`,
      );
    }
  } else {
    await writeFile(`${out}/${file}`, content);
  }
}
console.log(
  JSON.stringify({
    check: process.argv.includes('--check'),
    generated: Object.keys(outputs),
    definitions: names.length,
    sourceHashes: hashes,
  }),
);
