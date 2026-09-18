import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("site data production security boundary", () => {
  it("keeps production source and routes free of mock fallback", async () => {
    const files = ["lib/site-data/source.ts", "app/page.tsx", "app/games/page.tsx", "app/search/page.tsx", "app/games/[slug]/page.tsx", "app/genres/[slug]/page.tsx", "app/platforms/[slug]/page.tsx"];
    const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));
    expect(sources.every((source) => !source.includes("lib/mock-data"))).toBe(true);
    expect(sources.some((source) => source.includes("Date.now") || source.includes("fetch("))).toBe(false);
  });

  it("does not expose forbidden artifact fields", async () => {
    const artifact = await readFile("generated/site-data.json", "utf8");
    for (const key of ["gameId", "canonicalId", "storageKey", "contentHash", "rawPayload", "providerPayload", "fenceEpoch", "generatedAt", "localPath", "cloudflareId"]) {
      expect(artifact).not.toContain(`\"${key}\"`);
    }
  });
});
