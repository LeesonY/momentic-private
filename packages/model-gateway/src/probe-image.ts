import { randomInt } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const digits = [
  ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
];

function chunk(type: string, data: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, payload, checksum]);
}

/** Random answer exists only in PNG pixels, never the request text or filename. */
export function createProbeImage(): { code: string; dataUrl: string } {
  const code = Array.from({ length: 8 }, () => randomInt(10)).join('');
  const scale = 8;
  const width = (code.length * 6 + 3) * scale;
  const height = 11 * scale;
  const stride = 1 + width * 3;
  const pixels = Buffer.alloc(stride * height, 255);
  for (let y = 0; y < height; y++) pixels[y * stride] = 0;
  for (let i = 0; i < code.length; i++) {
    const glyph = digits[Number(code[i])]!;
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (glyph[gy]![gx] !== '1') continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const x = (i * 6 + gx + 2) * scale + dx;
            const y = (gy + 2) * scale + dy;
            pixels.fill(0, y * stride + 1 + x * 3, y * stride + 1 + x * 3 + 3);
          }
        }
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2; // RGB, no interlacing.
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return { code, dataUrl: `data:image/png;base64,${png.toString('base64')}` };
}
