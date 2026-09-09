export type ImageDimensions = {
  width: number;
  height: number;
};

type ImageMimeType = "image/jpeg" | "image/png" | "image/webp";

function invalidImage(): never {
  throw new Error("invalid_image");
}

function requireRange(bytes: Uint8Array, offset: number, length: number): void {
  if (
    !Number.isInteger(offset)
    || !Number.isInteger(length)
    || offset < 0
    || length < 0
    || offset > bytes.length - length
  ) {
    invalidImage();
  }
}

function u16be(bytes: Uint8Array, offset: number): number {
  requireRange(bytes, offset, 2);
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function u32be(bytes: Uint8Array, offset: number): number {
  requireRange(bytes, offset, 4);
  return (
    (bytes[offset]! * 0x1000000)
    + (bytes[offset + 1]! << 16)
    + (bytes[offset + 2]! << 8)
    + bytes[offset + 3]!
  );
}

function u16le(bytes: Uint8Array, offset: number): number {
  requireRange(bytes, offset, 2);
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function u32le(bytes: Uint8Array, offset: number): number {
  requireRange(bytes, offset, 4);
  return (
    bytes[offset]!
    + (bytes[offset + 1]! << 8)
    + (bytes[offset + 2]! << 16)
    + (bytes[offset + 3]! * 0x1000000)
  );
}

function positiveDimensions(width: number, height: number): ImageDimensions {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    invalidImage();
  }
  return { width, height };
}

function isJpegStartOfFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3)
    || (marker >= 0xc5 && marker <= 0xc7)
    || (marker >= 0xc9 && marker <= 0xcb)
    || (marker >= 0xcd && marker <= 0xcf)
  );
}

function parseJpegDimensions(bytes: Uint8Array): ImageDimensions {
  requireRange(bytes, 0, 2);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) invalidImage();

  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) invalidImage();
    // JPEG permits one or more fill bytes before the marker code.
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) invalidImage();

    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0x00) invalidImage();

    // SOI, EOI, restart markers, and TEM have no length field.
    if (marker === 0xd9) invalidImage();
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    const segmentLength = u16be(bytes, offset);
    if (segmentLength < 2) invalidImage();
    requireRange(bytes, offset, segmentLength);

    if (isJpegStartOfFrame(marker)) {
      // Length includes its own two bytes, precision, dimensions, and the
      // component count/table entries. Validate the count before reading.
      if (segmentLength < 8) invalidImage();
      const componentCount = bytes[offset + 7]!;
      if (componentCount === 0 || segmentLength !== 8 + componentCount * 3) invalidImage();
      const height = u16be(bytes, offset + 3);
      const width = u16be(bytes, offset + 5);
      return positiveDimensions(width, height);
    }

    offset += segmentLength;
  }

  invalidImage();
}

function parsePngDimensions(bytes: Uint8Array): ImageDimensions {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  requireRange(bytes, 0, signature.length);
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) invalidImage();
  }

  // The first chunk must be a complete 13-byte IHDR payload.
  requireRange(bytes, 8, 25);
  if (u32be(bytes, 8) !== 13) invalidImage();
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    invalidImage();
  }
  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);
  if (width > 0x7fffffff || height > 0x7fffffff) invalidImage();

  const bitDepth = bytes[24]!;
  const colorType = bytes[25]!;
  const legalBitDepth = (
    (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth))
    || (colorType === 2 && [8, 16].includes(bitDepth))
    || (colorType === 3 && [1, 2, 4, 8].includes(bitDepth))
    || (colorType === 4 && [8, 16].includes(bitDepth))
    || (colorType === 6 && [8, 16].includes(bitDepth))
  );
  if (!legalBitDepth || bytes[26] !== 0 || bytes[27] !== 0 || (bytes[28] !== 0 && bytes[28] !== 1)) {
    invalidImage();
  }
  return positiveDimensions(width, height);
}

function asciiEquals(bytes: Uint8Array, offset: number, value: string): boolean {
  requireRange(bytes, offset, value.length);
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function parseVp8Dimensions(bytes: Uint8Array, payloadOffset: number, payloadSize: number): ImageDimensions {
  if (payloadSize < 10) invalidImage();
  requireRange(bytes, payloadOffset, payloadSize);
  const frameTag = bytes[payloadOffset]! | (bytes[payloadOffset + 1]! << 8) | (bytes[payloadOffset + 2]! << 16);
  const version = (frameTag >> 1) & 0x07;
  const firstPartitionSize = frameTag >> 5;
  // A keyframe's first partition necessarily contains the 7-byte keyframe
  // header (start code plus dimensions), and must fit in this bounded chunk.
  if ((frameTag & 1) !== 0 || version > 3 || firstPartitionSize < 7 || firstPartitionSize > payloadSize - 3) {
    invalidImage();
  }
  if (bytes[payloadOffset + 3] !== 0x9d || bytes[payloadOffset + 4] !== 0x01 || bytes[payloadOffset + 5] !== 0x2a) {
    invalidImage();
  }
  const width = u16le(bytes, payloadOffset + 6) & 0x3fff;
  const height = u16le(bytes, payloadOffset + 8) & 0x3fff;
  return positiveDimensions(width, height);
}

function parseVp8lDimensions(bytes: Uint8Array, payloadOffset: number, payloadSize: number): ImageDimensions {
  if (payloadSize < 5) invalidImage();
  requireRange(bytes, payloadOffset, payloadSize);
  if (bytes[payloadOffset] !== 0x2f) invalidImage();
  const first = bytes[payloadOffset + 1]!;
  const second = bytes[payloadOffset + 2]!;
  const third = bytes[payloadOffset + 3]!;
  const fourth = bytes[payloadOffset + 4]!;
  if ((fourth >> 5) !== 0) invalidImage();
  const width = 1 + (first | ((second & 0x3f) << 8));
  const height = 1 + ((second >> 6) | (third << 2) | ((fourth & 0x0f) << 10));
  return positiveDimensions(width, height);
}

function parseVp8xDimensions(bytes: Uint8Array, payloadOffset: number, payloadSize: number): ImageDimensions {
  if (payloadSize !== 10) invalidImage();
  requireRange(bytes, payloadOffset, payloadSize);
  if (
    (bytes[payloadOffset]! & 0x83) !== 0
    || bytes[payloadOffset + 1] !== 0
    || bytes[payloadOffset + 2] !== 0
    || bytes[payloadOffset + 3] !== 0
  ) invalidImage();
  const width = 1 + bytes[payloadOffset + 4]! + (bytes[payloadOffset + 5]! << 8) + (bytes[payloadOffset + 6]! << 16);
  const height = 1 + bytes[payloadOffset + 7]! + (bytes[payloadOffset + 8]! << 8) + (bytes[payloadOffset + 9]! << 16);
  return positiveDimensions(width, height);
}

function parseWebpDimensions(bytes: Uint8Array): ImageDimensions {
  requireRange(bytes, 0, 12);
  if (!asciiEquals(bytes, 0, "RIFF") || !asciiEquals(bytes, 8, "WEBP")) invalidImage();

  const riffSize = u32le(bytes, 4);
  if (riffSize < 4) invalidImage();
  const riffEnd = 8 + riffSize;
  if (!Number.isSafeInteger(riffEnd) || riffEnd > bytes.length || riffEnd < 12) invalidImage();

  let offset = 12;
  while (offset < riffEnd) {
    if (riffEnd - offset < 8) invalidImage();
    const tag = offset;
    const payloadSize = u32le(bytes, offset + 4);
    const payloadOffset = offset + 8;
    if (payloadSize > riffEnd - payloadOffset) invalidImage();
    const payloadEnd = payloadOffset + payloadSize;
    const nextOffset = payloadEnd + (payloadSize & 1);
    if (nextOffset > riffEnd || nextOffset > bytes.length) invalidImage();

    if (asciiEquals(bytes, tag, "VP8 ")) return parseVp8Dimensions(bytes, payloadOffset, payloadSize);
    if (asciiEquals(bytes, tag, "VP8L")) return parseVp8lDimensions(bytes, payloadOffset, payloadSize);
    if (asciiEquals(bytes, tag, "VP8X")) return parseVp8xDimensions(bytes, payloadOffset, payloadSize);
    offset = nextOffset;
  }

  invalidImage();
}

export function parseImageDimensions(bytes: Uint8Array, mimeType: ImageMimeType): ImageDimensions {
  if (mimeType === "image/jpeg") return parseJpegDimensions(bytes);
  if (mimeType === "image/png") return parsePngDimensions(bytes);
  if (mimeType === "image/webp") return parseWebpDimensions(bytes);
  invalidImage();
}
