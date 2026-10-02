import { deflateRawSync, inflateRawSync, crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { Report } from '@localqa/contracts';
import type {
  ArtifactStorageBackend,
  ManifestMap,
  ArtifactManifestEntry,
} from '../artifacts/types.js';
import { renderMarkdownReport } from './markdown.js';

export interface ZipEntry {
  name: string;
  data: Buffer | Uint8Array | string;
}

export function packZip(entries: readonly ZipEntry[]): Buffer {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const dataBuf = Buffer.isBuffer(entry.data)
      ? entry.data
      : typeof entry.data === 'string'
        ? Buffer.from(entry.data, 'utf8')
        : Buffer.from(entry.data);

    const compressed = deflateRawSync(dataBuf);
    const useCompressed = compressed.length < dataBuf.length;
    const finalData = useCompressed ? compressed : dataBuf;
    const method = useCompressed ? 8 : 0;
    const entryCrc = crc32(dataBuf);

    // Local file header (30 bytes + name length)
    const lfh = Buffer.alloc(30 + nameBuf.length);
    lfh.writeUInt32LE(0x04034b50, 0); // local file header signature
    lfh.writeUInt16LE(20, 4); // version needed to extract (2.0)
    lfh.writeUInt16LE(0x0800, 6); // general purpose bit flag (UTF-8)
    lfh.writeUInt16LE(method, 8); // compression method
    lfh.writeUInt16LE(0, 10); // file last mod time
    lfh.writeUInt16LE(0, 12); // file last mod date
    lfh.writeUInt32LE(entryCrc, 14); // crc-32
    lfh.writeUInt32LE(finalData.length, 18); // compressed size
    lfh.writeUInt32LE(dataBuf.length, 22); // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26); // file name length
    lfh.writeUInt16LE(0, 28); // extra field length
    nameBuf.copy(lfh, 30);

    localHeaders.push(lfh, finalData);

    // Central directory file header (46 bytes + name length)
    const cdh = Buffer.alloc(46 + nameBuf.length);
    cdh.writeUInt32LE(0x02014b50, 0); // central file header signature
    cdh.writeUInt16LE(20, 4); // version made by
    cdh.writeUInt16LE(20, 6); // version needed to extract
    cdh.writeUInt16LE(0x0800, 8); // general purpose bit flag
    cdh.writeUInt16LE(method, 10); // compression method
    cdh.writeUInt16LE(0, 12); // file last mod time
    cdh.writeUInt16LE(0, 14); // file last mod date
    cdh.writeUInt32LE(entryCrc, 16); // crc-32
    cdh.writeUInt32LE(finalData.length, 20); // compressed size
    cdh.writeUInt32LE(dataBuf.length, 24); // uncompressed size
    cdh.writeUInt16LE(nameBuf.length, 28); // file name length
    cdh.writeUInt16LE(0, 30); // extra field length
    cdh.writeUInt16LE(0, 32); // file comment length
    cdh.writeUInt16LE(0, 34); // disk number start
    cdh.writeUInt16LE(0, 36); // internal file attributes
    cdh.writeUInt32LE(0, 38); // external file attributes
    cdh.writeUInt32LE(offset, 42); // relative offset of local header
    nameBuf.copy(cdh, 46);

    centralHeaders.push(cdh);
    offset += lfh.length + finalData.length;
  }

  const centralDirSize = centralHeaders.reduce((sum, h) => sum + h.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central dir signature
  eocd.writeUInt16LE(0, 4); // number of this disk
  eocd.writeUInt16LE(0, 6); // number of the disk with start of central directory
  eocd.writeUInt16LE(entries.length, 8); // total number of entries in central dir on this disk
  eocd.writeUInt16LE(entries.length, 10); // total number of entries in central dir
  eocd.writeUInt32LE(centralDirSize, 12); // size of the central directory
  eocd.writeUInt32LE(offset, 16); // offset of start of central directory
  eocd.writeUInt16LE(0, 20); // zip file comment length

  return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
}

export function unpackZip(
  zipBuffer: Buffer,
): Map<string, { data: Buffer; crc32: number }> {
  const result = new Map<string, { data: Buffer; crc32: number }>();
  let eocdOffset = -1;

  for (
    let i = zipBuffer.length - 22;
    i >= Math.max(0, zipBuffer.length - 65557);
    i--
  ) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error('Invalid ZIP: End of Central Directory record not found');
  }

  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

  let currentCdOffset = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (zipBuffer.readUInt32LE(currentCdOffset) !== 0x02014b50) {
      throw new Error(
        `Invalid Central Directory header at offset ${currentCdOffset}`,
      );
    }

    const method = zipBuffer.readUInt16LE(currentCdOffset + 10);
    const expectedCrc = zipBuffer.readUInt32LE(currentCdOffset + 16);
    const compSize = zipBuffer.readUInt32LE(currentCdOffset + 20);
    const uncompSize = zipBuffer.readUInt32LE(currentCdOffset + 24);
    const nameLen = zipBuffer.readUInt16LE(currentCdOffset + 28);
    const extraLen = zipBuffer.readUInt16LE(currentCdOffset + 30);
    const commentLen = zipBuffer.readUInt16LE(currentCdOffset + 32);
    const lfhOffset = zipBuffer.readUInt32LE(currentCdOffset + 42);

    const name = zipBuffer.toString(
      'utf8',
      currentCdOffset + 46,
      currentCdOffset + 46 + nameLen,
    );
    currentCdOffset += 46 + nameLen + extraLen + commentLen;

    // Read local header to get payload start
    if (zipBuffer.readUInt32LE(lfhOffset) !== 0x04034b50) {
      throw new Error(`Invalid Local File Header at offset ${lfhOffset}`);
    }
    const localNameLen = zipBuffer.readUInt16LE(lfhOffset + 26);
    const localExtraLen = zipBuffer.readUInt16LE(lfhOffset + 28);
    const dataStart = lfhOffset + 30 + localNameLen + localExtraLen;
    const rawData = zipBuffer.subarray(dataStart, dataStart + compSize);

    let uncompData: Buffer;
    if (method === 0) {
      uncompData = Buffer.from(rawData);
    } else if (method === 8) {
      uncompData = inflateRawSync(rawData);
    } else {
      throw new Error(
        `Unsupported compression method ${method} for entry ${name}`,
      );
    }

    if (uncompData.length !== uncompSize) {
      throw new Error(
        `Uncompressed size mismatch for ${name}: expected ${uncompSize}, got ${uncompData.length}`,
      );
    }

    const computedCrc = crc32(uncompData);
    if (computedCrc !== expectedCrc) {
      throw new Error(
        `CRC-32 mismatch for ${name}: expected ${expectedCrc}, got ${computedCrc}`,
      );
    }

    result.set(name, { data: uncompData, crc32: computedCrc });
  }

  return result;
}

export interface ManifestDocument {
  schemaVersion: 1;
  runId: string;
  projectId: string;
  generatedAt: string;
  isSnapshot: boolean;
  totalArtifacts: number;
  availableArtifacts: number;
  missingArtifacts: number;
  degradedArtifacts: number;
  failedArtifacts: number;
  artifacts: ArtifactManifestEntry[];
}

export async function createOfflineZipArchive(
  report: Report,
  manifest: ManifestMap,
  artifactStore: ArtifactStorageBackend,
): Promise<{ zipBuffer: Buffer; manifestDocument: ManifestDocument }> {
  const isSnapshot = !['completed', 'cancelled', 'failed'].includes(
    report.run.status,
  );

  const manifestEntries = Array.from(manifest.values());
  const manifestDocument: ManifestDocument = {
    schemaVersion: 1,
    runId: report.run.id,
    projectId: report.run.projectId,
    generatedAt: new Date().toISOString(),
    isSnapshot,
    totalArtifacts: manifestEntries.length,
    availableArtifacts: manifestEntries.filter((e) => e.status === 'available')
      .length,
    missingArtifacts: manifestEntries.filter((e) => e.status === 'missing')
      .length,
    degradedArtifacts: manifestEntries.filter((e) => e.status === 'degraded')
      .length,
    failedArtifacts: manifestEntries.filter((e) => e.status === 'failed')
      .length,
    artifacts: manifestEntries,
  };

  const entries: ZipEntry[] = [];

  // 1. report.json
  entries.push({
    name: 'report.json',
    data: Buffer.from(JSON.stringify(report, null, 2), 'utf8'),
  });

  // 2. report.md
  const markdownContent = renderMarkdownReport(report, manifest);
  entries.push({
    name: 'report.md',
    data: Buffer.from(markdownContent, 'utf8'),
  });

  // 3. manifest.json
  entries.push({
    name: 'manifest.json',
    data: Buffer.from(JSON.stringify(manifestDocument, null, 2), 'utf8'),
  });

  // 4. Binary artifacts (only available items)
  for (const entry of manifestEntries) {
    if (entry.status === 'available' && entry.relativePath) {
      try {
        const fileBuffer = await artifactStore.get(
          report.run.projectId,
          report.run.id,
          entry.id,
        );
        entries.push({
          name: entry.relativePath,
          data: fileBuffer,
        });
      } catch (err) {
        // If file read failed unexpectedly, degrade manifest
        entry.status = 'missing';
        entry.error = String(err);
      }
    }
  }

  const zipBuffer = packZip(entries);
  return { zipBuffer, manifestDocument };
}

export function verifyUnpackedZip(
  zipBuffer: Buffer,
  expectedManifest: ManifestMap,
  expectedReport: Report,
): { verified: boolean; files: string[]; errors: string[] } {
  const errors: string[] = [];
  const files: string[] = [];

  try {
    const extracted = unpackZip(zipBuffer);
    for (const key of extracted.keys()) {
      files.push(key);
    }

    if (!extracted.has('report.json')) {
      errors.push('ZIP does not contain report.json');
    } else {
      const repJson = extracted.get('report.json')!.data.toString('utf8');
      const parsed = JSON.parse(repJson);
      if (parsed.run?.id !== expectedReport.run.id) {
        errors.push(
          `report.json runId mismatch: ${parsed.run?.id} !== ${expectedReport.run.id}`,
        );
      }
    }

    if (!extracted.has('report.md')) {
      errors.push('ZIP does not contain report.md');
    }

    if (!extracted.has('manifest.json')) {
      errors.push('ZIP does not contain manifest.json');
    } else {
      const manJson = extracted.get('manifest.json')!.data.toString('utf8');
      const parsed = JSON.parse(manJson) as ManifestDocument;
      if (parsed.runId !== expectedReport.run.id) {
        errors.push(
          `manifest.json runId mismatch: ${parsed.runId} !== ${expectedReport.run.id}`,
        );
      }
    }

    for (const entry of expectedManifest.values()) {
      if (entry.status === 'available' && entry.relativePath) {
        const item = extracted.get(entry.relativePath);
        if (!item) {
          errors.push(
            `Expected artifact file ${entry.relativePath} missing from ZIP`,
          );
        } else if (entry.sha256) {
          const actualSha = createHash('sha256')
            .update(item.data)
            .digest('hex');
          if (actualSha !== entry.sha256) {
            errors.push(
              `Artifact ${entry.id} hash mismatch: expected ${entry.sha256}, got ${actualSha}`,
            );
          }
        }
      } else if (entry.relativePath && extracted.has(entry.relativePath)) {
        errors.push(
          `Artifact ${entry.id} status is ${entry.status} but file was included in ZIP`,
        );
      }
    }
  } catch (err) {
    errors.push(`ZIP unpack failed: ${String(err)}`);
  }

  return {
    verified: errors.length === 0,
    files,
    errors,
  };
}
