import { describe, expect, it } from "vitest";

import { buildImageStorageKey } from "./storage-key";

const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("buildImageStorageKey", () => {
  it.each([
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["image/webp", "webp"],
  ] as const)("maps %s to its content-addressed extension", (mimeType, extension) => {
    expect(buildImageStorageKey(HASH, mimeType)).toBe(`images/sha256/01/23/${HASH}.${extension}`);
  });

  it.each([
    "",
    "0123456789abcdef",
    `${HASH}0`,
    HASH.replace("a", "g"),
    HASH.toUpperCase(),
  ])("rejects an invalid hash: %s", (hash) => {
    expect(() => buildImageStorageKey(hash, "image/png")).toThrow("invalid_image_hash");
  });

  it("rejects an unsupported MIME type", () => {
    expect(() => buildImageStorageKey(HASH, "image/gif" as never)).toThrow("invalid_image_mime");
  });
});
