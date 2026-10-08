// Focused root review of in-flight image validation; no browser or provider.
import ts from 'typescript';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const sourcePath = join(repo, 'packages/orchestrator/src/artifacts.ts');
const scratch = await mkdtemp(join(repo, 'packages/orchestrator/test/.root-g3e-review-'));
const root = await mkdtemp(join(tmpdir(), 'localqa-g3e-root-review-'));

function chunk(name, data) {
  const payload = Buffer.concat([Buffer.from(name), data]);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, payload, checksum]);
}

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const header = Buffer.alloc(13);
header.writeUInt32BE(1, 0);
header.writeUInt32BE(1, 4);
header[8] = 8;
header[9] = 6;
const png = Buffer.concat([
  signature,
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
  chunk('IEND', Buffer.alloc(0)),
]);
const invalidHeader = Buffer.from(header);
invalidHeader[9] = 99; // Not a legal PNG color type.
const invalidColorPng = Buffer.concat([
  signature, chunk('IHDR', invalidHeader),
  chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
  chunk('IEND', Buffer.alloc(0)),
]);
const invalidDataPng = Buffer.concat([
  signature, chunk('IHDR', header),
  chunk('IDAT', Buffer.from('not-a-zlib-stream')),
  chunk('IEND', Buffer.alloc(0)),
]);

try {
  const source = await readFile(sourcePath, 'utf8');
  const compiled = join(scratch, 'artifacts.mjs');
  await writeFile(compiled, ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText);
  const { ArtifactStore } = await import(pathToFileURL(compiled).href);
  const projectId = randomUUID(), runId = randomUUID();
  await mkdir(join(root, projectId, runId), { recursive: true });
  const cases = [
    { name: 'Complete one-pixel RGBA PNG', bytes: png, expected: 'accepted' },
    { name: 'PNG signature only; no IHDR, IDAT or IEND', bytes: signature, expected: 'rejected' },
    { name: 'JPEG signature only; no frame or image data', bytes: Buffer.from([0xff, 0xd8, 0xff]), expected: 'rejected' },
    { name: 'CRC-valid PNG with invalid color type 99', bytes: invalidColorPng, expected: 'rejected' },
    { name: 'CRC-valid PNG with invalid compressed image data', bytes: invalidDataPng, expected: 'rejected' },
  ];
  const results = [];
  for (const item of cases) {
    const artifactId = randomUUID();
    await writeFile(join(root, projectId, runId, artifactId), item.bytes);
    let result;
    try {
      const image = await new ArtifactStore(root).readApprovedImage({
        projectId, runId, artifactId,
        sha256: createHash('sha256').update(item.bytes).digest('hex'),
        byteLength: item.bytes.length,
      });
      result = { result: 'accepted', mediaType: image.mediaType };
    } catch (error) {
      result = { result: 'rejected', code: error.code ?? error.message };
    }
    results.push({ case: item.name, expected: item.expected, ...result, passed: item.expected === result.result });
  }
  console.log(JSON.stringify({
    sourceSha256: createHash('sha256').update(source).digest('hex'), results,
    scope: 'Current ArtifactStore helper only; not composed image path acceptance',
  }, null, 2));
  if (results.some((item) => !item.passed)) process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
}
