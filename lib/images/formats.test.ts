import { describe, expect, it } from "vitest";

import { validateImageBytes } from "./formats";

const JPEG = Uint8Array.from([
  0xff, 0xd8,
  0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46,
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x30, 0x03,
  0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  0xff, 0xd9,
]);

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00, 0x30,
  0x08, 0x06, 0x00, 0x00, 0x00,
]);

const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  0x56, 0x50, 0x38, 0x58, 0x0a, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x2f, 0x00, 0x00,
]);

describe("validateImageBytes", () => {
  it.each([
    ["image/jpeg", JPEG, 48, 32],
    ["image/png", PNG, 32, 48],
    ["image/webp", WEBP, 32, 48],
  ])("accepts a valid %s with matching magic bytes", (mimeType, bytes, width, height) => {
    expect(validateImageBytes(bytes, mimeType)).toEqual({
      ok: true,
      mimeType,
      dimensions: { width, height },
    });
  });

  it("normalizes a content type's case and parameters", () => {
    expect(validateImageBytes(PNG, " IMAGE/PNG; charset=binary ")).toMatchObject({
      ok: true,
      mimeType: "image/png",
    });
  });

  it.each([
    ["image/png", JPEG],
    ["image/jpeg", PNG],
    ["image/webp", PNG],
    ["image/gif", PNG],
    [null, PNG],
  ] as const)("rejects content type %s when it does not describe the bytes", (contentType, bytes) => {
    expect(validateImageBytes(bytes, contentType)).toEqual({ ok: false, outcome: "mime_mismatch" });
  });

  it.each([
    ["truncated JPEG", JPEG.slice(0, 2), "image/jpeg"],
    ["truncated PNG header", PNG.slice(0, 16), "image/png"],
    ["truncated WebP chunk", WEBP.slice(0, 20), "image/webp"],
    ["malformed JPEG marker", Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00]), "image/jpeg"],
  ] as const)("returns invalid_image for a %s", (_label, bytes, contentType) => {
    expect(validateImageBytes(bytes, contentType)).toEqual({ ok: false, outcome: "invalid_image" });
  });
});
