import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { createPipelineCliComposition } from "./run-games-pipeline";

async function tree(path: string): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const file = resolve(path, entry.name);
    if (entry.isDirectory()) result.push(...await tree(file));
    else { const value = await stat(file); result.push([file, value.size, value.mtimeMs]); }
  }
  return result;
}

it("builds the supplied artifact with real Next in isolated output and reconciles without rebuilding", async () => {
  const tracked = await readFile("generated/site-data.json", "utf8");
  const fixture = JSON.parse(tracked);
  fixture.games = [{ ...fixture.games[0], slug: "gate-fixture", title: "Gate Fixture Only" }];
  const artifact = JSON.stringify(fixture);
  const sha = createHash("sha256").update(artifact).digest("hex");
  await mkdir(".tmp", { recursive: true });
  const tempRoot = await mkdtemp(resolve(".tmp/gate-regression-"));
  const runId = `pipeline-v2.10:${"a".repeat(64)}`;
  const normalBefore = [await tree(".next"), await tree("out")];
  const composition = await createPipelineCliComposition({ gateOnly: true, tempRoot, artifact: async () => artifact });
  try {
    await expect(composition.runRunStage!({ runId, stage: "preview", artifactSha256: sha })).resolves.toEqual({ artifactSha256: sha });
    const root = `${tempRoot}/${runId}/preview`;
    const html = await readFile(`${root}/out/index.html`, "utf8");
    expect(html.toLowerCase()).toMatch(/<!doctype html>/);
    expect(html).toContain("</html>");
    expect(html).toContain("Gate Fixture Only");
    expect(await readFile(`${root}/out/games/gate-fixture.html`, "utf8")).toContain("Gate Fixture Only");
    expect(await readFile(`${root}/out/404.html`, "utf8")).toContain("</html>");
    const marker = JSON.parse(await readFile(`${root}/gate-complete.json`, "utf8"));
    expect(marker.artifactSha256).toBe(sha);
    expect(marker.outputManifest.files.some((file: { path: string }) => file.path === "index.html")).toBe(true);
    const beforeReconcile = await tree(`${root}/out`);
    await expect(composition.reconcileRunStage!({ runId, stage: "preview", artifactSha256: sha })).resolves.toEqual({ outcome: "consistent", artifactSha256: sha });
    expect(await tree(`${root}/out`)).toEqual(beforeReconcile);
    expect(await readFile("generated/site-data.json", "utf8")).toBe(tracked);
    expect([await tree(".next"), await tree("out")]).toEqual(normalBefore);
  } finally {
    await composition.dispose();
    await rm(tempRoot, { recursive: true, force: true });
  }
}, 180_000);
