import { describe, expect, it, vi } from "vitest";
import manifest from "../../content/manifests/v2-10-example.json";
import { canonicalizeManifest, hashManifest, deriveRunId } from "./canonical";

const expected = '{"items":[{"ordinal":1,"steamAppId":"1245620"},{"ordinal":2,"steamAppId":"292030"}],"manifestVersion":"1","pipelineVersion":"2.10","policyVersion":"v2.10-production-1","snapshotDate":"2026-09-19"}\n';
const digest = "2228908952aedd6d60d47ffe7cdf98e3f1f56d7042270624e58e3fa0a02b4964";

describe("canonical manifest identity", () => {
  it("emits exact compact UTF-8 bytes and one final newline", () => {
    expect(Buffer.from(canonicalizeManifest(manifest), "utf8")).toEqual(Buffer.from(expected, "utf8"));
  });
  it("ignores object insertion order at every level", () => {
    const reversed = Object.fromEntries(Object.entries(manifest).reverse());
    reversed.items = manifest.items.map(({ ordinal, steamAppId }) => ({ steamAppId, ordinal }));
    expect(canonicalizeManifest(reversed)).toBe(expected);
  });
  it("preserves manifest ordinal order rather than sorting IDs", () => {
    const changed = { ...manifest, items: [{ ordinal: 1, steamAppId: "9" }, { ordinal: 2, steamAppId: "1" }] };
    expect(JSON.parse(canonicalizeManifest(changed)).items).toEqual(changed.items);
  });
  it("hashes the exact canonical bytes including newline", () => {
    expect(hashManifest(manifest)).toBe(digest);
  });
  it("prefixes the manifest hash exactly once", () => {
    expect(deriveRunId(manifest)).toBe("pipeline-v2.10:" + digest);
  });
  it("repeated calls are byte-identical without clock or randomness", () => {
    const clock = vi.spyOn(Date, "now").mockImplementation(() => { throw new Error("clock"); });
    const random = vi.spyOn(Math, "random").mockImplementation(() => { throw new Error("random"); });
    try {
      expect(canonicalizeManifest(manifest)).toBe(canonicalizeManifest(manifest));
      expect(deriveRunId(manifest)).toBe("pipeline-v2.10:" + digest);
    } finally { clock.mockRestore(); random.mockRestore(); }
  });
  it.each([
    { ...manifest, secret: "forbidden" },
    { ...manifest, snapshotDate: "2026-02-30" },
    { ...manifest, items: [...manifest.items].reverse() },
  ])("validates before serializing or hashing", (invalid) => {
    expect(() => canonicalizeManifest(invalid)).toThrow();
    expect(() => hashManifest(invalid)).toThrow();
    expect(() => deriveRunId(invalid)).toThrow();
  });
});
