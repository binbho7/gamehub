import { describe, expect, it } from "vitest";

import { parseImageDimensions } from "./dimensions";

function jpegWithFrame(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe1, 0x00, 0x04, 0x01, 0x02,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
}

function crc32(bytes: number[]): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngWithDimensions(width: number, height: number): Uint8Array {
  const ihdr = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    width >>> 24, width >>> 16, width >>> 8, width,
    height >>> 24, height >>> 16, height >>> 8, height,
    0x08, 0x06, 0x00, 0x00, 0x00,
  ];
  const checksum = crc32(ihdr.slice(12, 29));
  return Uint8Array.from([...ihdr, checksum >>> 24, checksum >>> 16, checksum >>> 8, checksum]);
}

function webpChunk(chunk: string, payload: number[], riffSize = 4 + 8 + payload.length + (payload.length & 1)): Uint8Array {
  return Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, riffSize, riffSize >> 8, riffSize >> 16, riffSize >> 24,
    0x57, 0x45, 0x42, 0x50,
    ...Array.from(chunk).map((character) => character.charCodeAt(0)),
    payload.length, payload.length >> 8, payload.length >> 16, payload.length >> 24,
    ...payload,
    ...(payload.length & 1 ? [0] : []),
  ]);
}

describe("parseImageDimensions", () => {
  it("traverses JPEG markers before reading a SOF frame", () => {
    expect(parseImageDimensions(jpegWithFrame(0x1234, 0x2345), "image/jpeg")).toEqual({
      width: 0x1234,
      height: 0x2345,
    });
  });

  it("reads PNG dimensions from the IHDR chunk", () => {
    expect(parseImageDimensions(pngWithDimensions(0x12345678, 0x23456789), "image/png")).toEqual({
      width: 0x12345678,
      height: 0x23456789,
    });
  });

  it("reads dimensions from a lossy VP8 frame", () => {
    const payload = [0xe0, 0, 0, 0x9d, 0x01, 0x2a, 0x34, 0x12, 0x78, 0x16];
    expect(parseImageDimensions(webpChunk("VP8 ", payload), "image/webp")).toEqual({
      width: 0x1234,
      height: 0x1678,
    });
  });

  it("reads dimensions from a lossless VP8L frame", () => {
    // width = 0x1234, height = 0x5678 in the VP8L packed 14/14-bit fields.
    const width = 0x1234;
    const height = 0x1678;
    const bits = (width - 1) | ((height - 1) << 14);
    const payload = [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff];
    expect(parseImageDimensions(webpChunk("VP8L", payload), "image/webp")).toEqual({ width, height });
  });

  it("reads dimensions from an extended VP8X frame", () => {
    const width = 0x123456;
    const height = 0x234567;
    const payload = [
      0, 0, 0, 0,
      (width - 1) & 0xff, (width - 1) >> 8, (width - 1) >> 16,
      (height - 1) & 0xff, (height - 1) >> 8, (height - 1) >> 16,
    ];
    expect(parseImageDimensions(webpChunk("VP8X", payload), "image/webp")).toEqual({ width, height });
  });

  it.each([
    ["JPEG", "image/jpeg", Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04])],
    ["PNG", "image/png", pngWithDimensions(0, 1)],
    ["WebP", "image/webp", webpChunk("VP8L", [0x2f])],
  ] as const)("rejects malformed or invalid %s dimensions", (_label, mimeType, bytes) => {
    expect(() => parseImageDimensions(bytes, mimeType)).toThrow();
  });

  it("rejects a JPEG SOF with zero components or a non-exact segment length", () => {
    const zeroComponents = jpegWithFrame(10, 10);
    zeroComponents[17] = 0;
    expect(() => parseImageDimensions(zeroComponents, "image/jpeg")).toThrow();

    const wrongLength = jpegWithFrame(10, 10);
    wrongLength[10] = 0x12;
    expect(() => parseImageDimensions(wrongLength, "image/jpeg")).toThrow();
  });

  it("rejects an incomplete PNG IHDR and illegal IHDR fields", () => {
    const complete = pngWithDimensions(10, 10);
    expect(() => parseImageDimensions(complete.slice(0, -4), "image/png")).toThrow();

    for (const [offset, value] of [[24, 3], [25, 1], [26, 1], [27, 1], [28, 2]] as const) {
      const malformed = complete.slice();
      malformed[offset] = value;
      expect(() => parseImageDimensions(malformed, "image/png")).toThrow();
    }

    expect(() => parseImageDimensions(pngWithDimensions(0x80000000, 10), "image/png")).toThrow();
  });

  it("rejects invalid VP8 keyframe, version, and partition tags", () => {
    for (const tag of [0xe1, 0xe8, 0x20]) {
      const payload = [tag, 0, 0, 0x9d, 0x01, 0x2a, 0x34, 0x12, 0x78, 0x16];
      expect(() => parseImageDimensions(webpChunk("VP8 ", payload), "image/webp")).toThrow();
    }
  });

  it("rejects VP8L nonzero version bits and VP8X reserved or extra payload bytes", () => {
    expect(() => parseImageDimensions(webpChunk("VP8L", [0x2f, 0, 0, 0, 0x20]), "image/webp")).toThrow();
    expect(() => parseImageDimensions(webpChunk("VP8X", [1, 0, 0, 0, 1, 0, 0, 1, 0, 0]), "image/webp")).toThrow();
    expect(() => parseImageDimensions(webpChunk("VP8X", [0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0]), "image/webp")).toThrow();
  });

  it("rejects truncated chunk and marker reads instead of reading out of bounds", () => {
    expect(() => parseImageDimensions(Uint8Array.from([0xff, 0xd8, 0xff]), "image/jpeg")).toThrow();
    expect(() => parseImageDimensions(webpChunk("VP8X", [0, 0, 0]), "image/webp")).toThrow();
    expect(() => parseImageDimensions(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), "image/png")).toThrow();
  });
});
