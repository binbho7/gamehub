import { describe, expect, it } from "vitest";

import { sha256Hex } from "./hash";

describe("sha256Hex", () => {
  it("returns the lowercase SHA-256 digest for a known vector", async () => {
    await expect(sha256Hex(new TextEncoder().encode("abc"))).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("returns a 64-character lowercase hexadecimal digest for empty bytes", async () => {
    const digest = await sha256Hex(new Uint8Array());

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
