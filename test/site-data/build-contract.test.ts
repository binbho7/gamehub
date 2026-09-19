import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("production build contract", () => {
  it("gates Next build on the tracked artifact checker", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.build).toBe("npm run site:data:check && next build");
    expect(packageJson.scripts?.["site:build"]).toBe(packageJson.scripts?.build);
  });
});
