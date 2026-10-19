import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { crc32, inflateSync } from 'node:zlib';
import type { Artifact, TaskRecording } from '@localqa/contracts';
import { parseContract } from '@localqa/contracts';
import {
  StorageError,
  type WorkerScope,
  type LeaseProof,
} from '@localqa/storage';
import type { Coordinator, StoppedRecordingArtifact } from './core.js';
const IMAGE_BYTE_LIMIT = 25 * 1024 * 1024;
/** Uncompressed scanlines. Larger claims are rejected before inflate. */
const PNG_DECODED_LIMIT = 32 * 1024 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_CRITICAL = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);
const ADAM7: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

/** PNG spec table 11.2. Color type 99 and other combinations are not images. */
function pngHeader(data: Buffer): PngHeader | null {
  if (data.length !== 13) return null;
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  const bitDepth = data[8] ?? 0;
  const colorType = data[9] ?? 0;
  const compression = data[10] ?? 0;
  const filter = data[11] ?? 0;
  const interlace = data[12] ?? 0;
  if (width < 1 || height < 1 || compression !== 0 || filter !== 0) return null;
  if (interlace !== 0 && interlace !== 1) return null;
  const allowed: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (!allowed[colorType]?.includes(bitDepth)) return null;
  return { width, height, bitDepth, colorType, interlace };
}

function pngSamples(colorType: number): number {
  if (colorType === 0 || colorType === 3) return 1;
  if (colorType === 2) return 3;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  return 0;
}

function pngRowBytes(width: number, bitsPerPixel: number): number | null {
  if (width < 1 || bitsPerPixel < 1 || width > PNG_DECODED_LIMIT) return null;
  const bits = width * bitsPerPixel;
  if (!Number.isSafeInteger(bits)) return null;
  return Math.ceil(bits / 8);
}

/** Exact filtered size, or null when the claim would exceed the decode bound. */
function pngDecodedLength(header: PngHeader): number | null {
  const bitsPerPixel = pngSamples(header.colorType) * header.bitDepth;
  const passes = header.interlace === 0 ? ([[0, 0, 1, 1]] as const) : ADAM7;
  let total = 0;
  for (const [x0, y0, dx, dy] of passes) {
    if (header.width <= x0 || header.height <= y0) continue;
    const passWidth = Math.ceil((header.width - x0) / dx);
    const passHeight = Math.ceil((header.height - y0) / dy);
    const row = pngRowBytes(passWidth, bitsPerPixel);
    if (row === null || passHeight > PNG_DECODED_LIMIT) return null;
    const block = (row + 1) * passHeight;
    if (!Number.isSafeInteger(block) || block > PNG_DECODED_LIMIT) return null;
    if (total > PNG_DECODED_LIMIT - block) return null;
    total += block;
  }
  return total > 0 ? total : null;
}

function pngScanlines(raw: Buffer, header: PngHeader): boolean {
  const bitsPerPixel = pngSamples(header.colorType) * header.bitDepth;
  const passes = header.interlace === 0 ? ([[0, 0, 1, 1]] as const) : ADAM7;
  let offset = 0;
  for (const [x0, y0, dx, dy] of passes) {
    if (header.width <= x0 || header.height <= y0) continue;
    const passWidth = Math.ceil((header.width - x0) / dx);
    const passHeight = Math.ceil((header.height - y0) / dy);
    const row = pngRowBytes(passWidth, bitsPerPixel);
    if (row === null) return false;
    for (let line = 0; line < passHeight; line += 1) {
      const filter = raw[offset];
      if (filter === undefined || filter > 4) return false;
      offset += 1 + row;
      if (offset > raw.length) return false;
    }
  }
  return offset === raw.length;
}

/**
 * A PNG needs a legal IHDR, a real zlib IDAT, and filtered scanlines of the
 * declared size. CRC alone is not enough. Kind and filename are not a media type.
 */
function pngImage(bytes: Buffer): boolean {
  if (bytes.length < 8) return false;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1)
    if (bytes[index] !== PNG_SIGNATURE[index]) return false;
  let offset = 8;
  let header: PngHeader | null = null;
  let palette = false;
  let image = false;
  let imageClosed = false;
  let ended = false;
  const compressed: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataEnd = typeStart + 4 + length;
    if (dataEnd + 4 > bytes.length) return false;
    const type = bytes.toString('latin1', typeStart, typeStart + 4);
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    const checksum = crc32(bytes.subarray(typeStart, dataEnd)) >>> 0;
    if (bytes.readUInt32BE(dataEnd) !== checksum) return false;
    const critical = (type.charCodeAt(0) & 0x20) === 0;
    if (critical && !PNG_CRITICAL.has(type)) return false;
    if (!header) {
      if (type !== 'IHDR') return false;
      header = pngHeader(bytes.subarray(typeStart + 4, dataEnd));
      if (!header) return false;
    } else if (type === 'IHDR') return false;
    else if (type === 'PLTE') {
      if (image || length < 3 || length > 768 || length % 3 !== 0) return false;
      palette = true;
    } else if (type === 'IDAT') {
      if (imageClosed || length < 1) return false;
      if (header.colorType === 3 && !palette) return false;
      compressed.push(bytes.subarray(typeStart + 4, dataEnd));
      image = true;
    } else if (type === 'IEND') {
      if (length !== 0 || !image) return false;
      ended = true;
    } else if (image) imageClosed = true;
    offset = dataEnd + 4;
    if (ended && offset !== bytes.length) return false;
  }
  if (!ended || !header || offset !== bytes.length) return false;
  const expected = pngDecodedLength(header);
  if (expected === null) return false;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
  } catch {
    return false;
  }
  return raw.length === expected && pngScanlines(raw, header);
}

/** Baseline, progressive, and lossless SOF markers. DHT and DAC are not frames. */
function jpegFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

/**
 * Structural JPEG only. Requires SOI, at least one SOF (not DHT or DAC) with
 * a positive frame size, at least one SOS with at least one entropy byte, and
 * a final EOI with no trailing bytes. This does not Huffman-decode the scan,
 * check tables, or produce a bitmap. SOF plus SOS is not a decoded image.
 * FF D8 FF alone is not a JPEG.
 */
function jpegImage(bytes: Buffer): boolean {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2;
  let frame = false;
  let scan = false;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return false;
    offset += 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return false;
    const marker = bytes[offset] ?? 0;
    offset += 1;
    if (marker === 0xd9) return frame && scan && offset === bytes.length;
    if (
      marker === 0x00 ||
      marker === 0x01 ||
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7)
    )
      return false;
    if (marker === 0xda) {
      if (!frame || offset + 2 > bytes.length) return false;
      const segment = bytes.readUInt16BE(offset);
      const components = bytes[offset + 2] ?? 0;
      if (
        components < 1 ||
        segment < 6 + components * 2 ||
        offset + segment > bytes.length
      )
        return false;
      let cursor = offset + segment;
      let entropy = 0;
      let nextMarker = -1;
      while (cursor < bytes.length) {
        if (bytes[cursor] !== 0xff) {
          entropy += 1;
          cursor += 1;
          continue;
        }
        let markerAt = cursor + 1;
        while (markerAt < bytes.length && bytes[markerAt] === 0xff)
          markerAt += 1;
        if (markerAt >= bytes.length) return false;
        const next = bytes[markerAt] ?? 0;
        if (next === 0x00) {
          entropy += 1;
          cursor = markerAt + 1;
          continue;
        }
        if (next >= 0xd0 && next <= 0xd7) {
          cursor = markerAt + 1;
          continue;
        }
        if (entropy < 1) return false;
        nextMarker = markerAt - 1;
        break;
      }
      if (nextMarker < 0) return false;
      scan = true;
      offset = nextMarker;
      continue;
    }
    if (offset + 2 > bytes.length) return false;
    const segment = bytes.readUInt16BE(offset);
    if (segment < 2 || offset + segment > bytes.length) return false;
    if (jpegFrame(marker)) {
      if (segment < 8) return false;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      const components = bytes[offset + 7] ?? 0;
      if (height < 1 || width < 1 || components < 1) return false;
      if (segment < 8 + components * 3) return false;
      frame = true;
    }
    offset += segment;
  }
  return false;
}

/** Kind and filename are not a media type. */
function imageMediaType(bytes: Buffer): 'image/png' | 'image/jpeg' | null {
  if (pngImage(bytes)) return 'image/png';
  if (jpegImage(bytes)) return 'image/jpeg';
  return null;
}

/** Server-owned durable directory. Worker supplies bytes, never a server path. */
export class ArtifactStore {
  constructor(readonly root: string) {
    this.root = resolve(root);
  }
  async upload(
    coordinator: Coordinator,
    scope: WorkerScope,
    proof: LeaseProof,
    metadata: Artifact,
    bytes: Uint8Array,
  ): Promise<Artifact> {
    const input = parseContract('Artifact', metadata);
    if (
      bytes.byteLength > 25 * 1024 * 1024 ||
      input.bytes !== bytes.byteLength ||
      createHash('sha256').update(bytes).digest('hex') !== input.sha256 ||
      !['applied', 'not_needed'].includes(input.redaction)
    )
      throw new StorageError('VALIDATION_ERROR');
    const work = await coordinator.work(scope, proof);
    const directory = resolve(this.root, scope.projectId, work.run.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = resolve(directory, input.id);
    const temporary = resolve(directory, `.${randomUUID()}`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, path);
      return await coordinator.saveArtifact(scope, proof, input);
    } catch (error) {
      await rm(temporary, { force: true });
      /* Retain bytes on ambiguous DB commit; orphan reconciliation is safer than deleting referenced evidence. */ throw error;
    }
  }
  /**
   * Write evidence for a browser task that was stopped before finish. The
   * normal upload path needs a live lease; this one is fenced by the last
   * lease's token and is accepted only after cancellation/expiry.
   */
  async uploadStopped(
    coordinator: Coordinator,
    scope: WorkerScope,
    proof: LeaseProof,
    entries: readonly StoppedRecordingArtifact[],
    recording: TaskRecording,
  ): Promise<void> {
    const parsedRecording = parseContract('TaskRecording', recording);
    if (
      parsedRecording.taskId !== proof.taskId ||
      !['degraded', 'missing'].includes(parsedRecording.status) ||
      entries.length === 0
    )
      throw new StorageError('VALIDATION_ERROR');
    const validated = entries.map(({ artifact, bytes }) => {
      const input = parseContract('Artifact', artifact);
      if (
        input.projectId !== scope.projectId ||
        input.taskId !== proof.taskId ||
        !['rrweb', 'console', 'network'].includes(input.kind) ||
        !['available', 'degraded'].includes(input.status) ||
        input.redaction !== 'applied' ||
        bytes.byteLength > 25 * 1024 * 1024 ||
        input.bytes !== bytes.byteLength ||
        createHash('sha256').update(bytes).digest('hex') !== input.sha256
      )
        throw new StorageError('VALIDATION_ERROR');
      return { input, bytes };
    });
    const { runId } = await coordinator.stoppedRecordingTarget(scope, proof);
    if (validated.some(({ input }) => input.runId !== runId))
      throw new StorageError('VALIDATION_ERROR');
    const directory = resolve(this.root, scope.projectId, runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const written: string[] = [];
    try {
      for (const { input, bytes } of validated) {
        const path = resolve(directory, input.id);
        if (!path.startsWith(`${directory}${sep}`))
          throw new StorageError('VALIDATION_ERROR');
        const temporary = resolve(directory, `.${randomUUID()}`);
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await rename(temporary, path);
          written.push(path);
        } catch (error) {
          await rm(temporary, { force: true });
          throw error;
        }
      }
    } catch (error) {
      await Promise.all(written.map((path) => rm(path, { force: true })));
      throw error;
    }
    /* Retain bytes on an ambiguous DB commit; orphan reconciliation is safer
       than deleting evidence the transaction may have referenced. */
    await coordinator.saveStoppedRecording(
      scope,
      proof,
      validated.map(({ input, bytes }) => ({ artifact: input, bytes })),
      parsedRecording,
    );
  }

  async get(
    projectId: string,
    runId: string,
    artifactId: string,
  ): Promise<Buffer> {
    for (const id of [projectId, runId, artifactId])
      if (!/^[a-f0-9-]{36}$/i.test(id))
        throw new StorageError('VALIDATION_ERROR');
    return readFile(resolve(this.root, projectId, runId, artifactId));
  }

  /**
   * Bytes for one already-approved image. Caller enforces project, run, task,
   * available, and redaction. This checks the declared hash and length, rejects
   * symlinks and paths outside this store. PNG must decode. JPEG is marker
   * structure only, not a Huffman-decoded scan.
   */
  async readApprovedImage(input: {
    projectId: string;
    runId: string;
    artifactId: string;
    sha256: string;
    byteLength: number;
  }): Promise<{ mediaType: 'image/png' | 'image/jpeg'; bytes: Buffer }> {
    for (const id of [input.projectId, input.runId, input.artifactId])
      if (!/^[a-f0-9-]{36}$/i.test(id))
        throw new StorageError('VALIDATION_ERROR');
    if (!/^[a-f0-9]{64}$/i.test(input.sha256))
      throw new StorageError('VALIDATION_ERROR');
    if (!Number.isInteger(input.byteLength) || input.byteLength < 1)
      throw new StorageError('VALIDATION_ERROR');
    if (input.byteLength > IMAGE_BYTE_LIMIT)
      throw new StorageError('ARTIFACT_TOO_LARGE');
    const rootPrefix = this.root.endsWith(sep)
      ? this.root
      : `${this.root}${sep}`;
    let cursor = this.root;
    for (const part of [input.projectId, input.runId, input.artifactId]) {
      const next = resolve(cursor, part);
      if (!next.startsWith(rootPrefix))
        throw new StorageError('VALIDATION_ERROR');
      let stat;
      try {
        stat = await lstat(next);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') throw new StorageError('NOT_FOUND');
        throw new StorageError('VALIDATION_ERROR');
      }
      if (stat.isSymbolicLink()) throw new StorageError('VALIDATION_ERROR');
      const last = part === input.artifactId;
      if (!last && !stat.isDirectory())
        throw new StorageError('VALIDATION_ERROR');
      if (last && !stat.isFile()) throw new StorageError('VALIDATION_ERROR');
      if (last && stat.size > IMAGE_BYTE_LIMIT)
        throw new StorageError('ARTIFACT_TOO_LARGE');
      if (last && stat.size !== input.byteLength)
        throw new StorageError('VALIDATION_ERROR');
      cursor = next;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(cursor);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new StorageError('NOT_FOUND');
      throw new StorageError('VALIDATION_ERROR');
    }
    if (bytes.byteLength !== input.byteLength)
      throw new StorageError('VALIDATION_ERROR');
    if (
      createHash('sha256').update(bytes).digest('hex') !==
      input.sha256.toLowerCase()
    )
      throw new StorageError('VALIDATION_ERROR');
    const mediaType = imageMediaType(bytes);
    if (!mediaType) throw new StorageError('VALIDATION_ERROR');
    return { mediaType, bytes };
  }
}
