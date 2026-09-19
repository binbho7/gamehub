import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("V2.9 final documentation contract", () => {
  it("documents the canonical static-data workflow and forbidden runtime paths", async () => {
    const readme = await readFile("README.md", "utf8");
    for (const text of ["generated/site-data.json", "npm run site:data:check", "npm run build", "Cloudflare Pages", "snapshotDate", "local D1", "10 MiB", "10,000 games", "mock data is fixture-only", "does not use R2"]) expect(readme).toContain(text);
    for (const forbidden of ["automatically push", "runtime D1", "provider calls"]) expect(readme).toContain(forbidden);
  });
});
