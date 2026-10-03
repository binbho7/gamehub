import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { copyTrackedProductionInputs, trackedFileList } from "../scripts/production-build-inputs";

describe("SEO production build inputs", () => {
  it("copies every absolute TypeScript import used by the root layout", async () => {
    const projectRoot = process.cwd();
    const buildRoot = await mkdtemp("/private/tmp/gamehub-seo-build-");
    const trackedFiles = trackedFileList(execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: projectRoot, encoding: "utf8" }));

    try {
      await copyTrackedProductionInputs(projectRoot, buildRoot, trackedFiles);
      const layout = await readFile(resolve(buildRoot, "app/layout.tsx"), "utf8");
      const imports = [...layout.matchAll(/from "@\/([^"?]+)"/g)].map((match) => match[1]);

      for (const target of imports) {
        const candidates = [`${target}.ts`, `${target}.tsx`, `${target}/index.ts`, `${target}/index.tsx`];
        const copied = await Promise.all(candidates.map((candidate) => access(resolve(buildRoot, candidate)).then(() => true, () => false)));
        expect(copied.some(Boolean), `missing isolated-build import: @/${target}`).toBe(true);
      }
    } finally {
      await rm(buildRoot, { recursive: true, force: true });
    }
  });
});
