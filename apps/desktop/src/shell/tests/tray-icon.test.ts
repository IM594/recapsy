import { describe, expect, it } from 'bun:test';
import { inflateSync } from 'node:zlib';
import { createTrayIconPngBuffer } from '../tray-icon';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

describe('tray icon PNG', () => {
  it('contains a complete, visible 16×16 image', () => {
    const png = createTrayIconPngBuffer();

    expect(png.subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE);

    const headerChunk = parseChunk(png, PNG_SIGNATURE.length);
    expect(headerChunk.type).toBe('IHDR');
    const header = headerChunk.data;
    expect(header.length).toBe(13);
    expect(header.readUInt32BE(0)).toBe(16);
    expect(header.readUInt32BE(4)).toBe(16);
    expect(header[8]).toBe(8);

    const colorType = header.readUInt8(9);
    expect([4, 6]).toContain(colorType);
    const bytesPerPixel = colorType === 4 ? 2 : 4;
    const rowDataLength = 16 * bytesPerPixel;
    const imageDataChunk = parseChunk(png, headerChunk.nextOffset);
    expect(imageDataChunk.type).toBe('IDAT');
    const scanlines = inflateSync(imageDataChunk.data);

    expect(scanlines.length).toBe(16 * (rowDataLength + 1));

    const pixels = decodeScanlines(scanlines, 16, rowDataLength, bytesPerPixel);
    expect(
      pixels.some((value, index) => index % bytesPerPixel === bytesPerPixel - 1 && value > 0),
    ).toBe(true);

    const endChunk = parseChunk(png, imageDataChunk.nextOffset);
    expect(endChunk.type).toBe('IEND');
    expect(endChunk.data.length).toBe(0);
    expect(endChunk.nextOffset).toBe(png.length);
  });

  it('returns an independent buffer for every caller', () => {
    const first = createTrayIconPngBuffer();
    const second = createTrayIconPngBuffer();

    expect(first).not.toBe(second);
    first[0] = 0;
    expect(second[0]).toBe(PNG_SIGNATURE[0]);
  });
});

type PngChunk = {
  data: Buffer;
  nextOffset: number;
  type: string;
};

function parseChunk(png: Buffer, offset: number): PngChunk {
  expect(offset + 12).toBeLessThanOrEqual(png.length);
  const dataLength = png.readUInt32BE(offset);
  const type = png.toString('ascii', offset + 4, offset + 8);
  const dataStart = offset + 8;
  const nextOffset = dataStart + dataLength + 4;
  expect(nextOffset).toBeLessThanOrEqual(png.length);

  return {
    data: png.subarray(dataStart, dataStart + dataLength),
    nextOffset,
    type,
  };
}

function decodeScanlines(
  scanlines: Buffer,
  height: number,
  rowDataLength: number,
  bytesPerPixel: number,
): Buffer {
  const pixels = Buffer.alloc(height * rowDataLength);

  for (let row = 0; row < height; row += 1) {
    const encodedRowStart = row * (rowDataLength + 1);
    const filter = scanlines[encodedRowStart];
    expect(filter).toBeDefined();

    for (let column = 0; column < rowDataLength; column += 1) {
      const encoded = scanlines[encodedRowStart + column + 1] ?? 0;
      const outputIndex = row * rowDataLength + column;
      const left = column >= bytesPerPixel ? (pixels[outputIndex - bytesPerPixel] ?? 0) : 0;
      const above = row > 0 ? (pixels[outputIndex - rowDataLength] ?? 0) : 0;
      const upperLeft =
        row > 0 && column >= bytesPerPixel
          ? (pixels[outputIndex - rowDataLength - bytesPerPixel] ?? 0)
          : 0;

      pixels[outputIndex] = unfilterByte(filter ?? -1, encoded, left, above, upperLeft);
    }
  }

  return pixels;
}

function unfilterByte(
  filter: number,
  encoded: number,
  left: number,
  above: number,
  upperLeft: number,
): number {
  switch (filter) {
    case 0:
      return encoded;
    case 1:
      return (encoded + left) & 0xff;
    case 2:
      return (encoded + above) & 0xff;
    case 3:
      return (encoded + Math.floor((left + above) / 2)) & 0xff;
    case 4:
      return (encoded + paethPredictor(left, above, upperLeft)) & 0xff;
    default:
      throw new Error(`Unsupported PNG filter: ${filter}`);
  }
}

function paethPredictor(left: number, above: number, upperLeft: number): number {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);

  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}
