import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { reconcileLocalGate, runLocalGate, type LocalGateFs } from "./local";

const artifact = "{\"version\":1}\n";
const sha = createHash("sha256").update(artifact).digest("hex");
const runId = `pipeline-v2.10:${"a".repeat(64)}`;

function fs(initial: Record<string, string> = {}): LocalGateFs & { files: Record<string, string> } {
  const files = { ...initial };
  return {
    files,
    async read(path) { return files[path]; },
    async list(path) { return Object.keys(files).filter((file) => file.startsWith(`${path}/`)); },
    async write(path, value) { files[path] = value; },
  };
}

describe("V2.10 local preview and publish-ready gates", () => {
  it("checks and builds from a temp artifact/output without touching the tracked artifact", async () => {
    const io = fs({ "generated/site-data.json": "tracked" });
    const calls: string[] = [];
    const result = await runLocalGate({
      runId, stage: "preview", artifact, artifactSha256: sha, fs: io,
      checkSiteData: async (path) => { calls.push(`check:${path}`); expect(await io.read(path)).toBe(artifact); },
      build: async (artifactPath, outputPath) => {
        calls.push(`build:${artifactPath}:${outputPath}`);
        expect(await io.read(artifactPath)).toBe(artifact);
        await io.write(`${outputPath}/index.html`, "ok");
      },
    });
    expect(result).toEqual({ artifactSha256: sha });
    expect(calls).toEqual([`check:.tmp/v2.10/${runId}/preview/site-data.json`, `build:.tmp/v2.10/${runId}/preview/site-data.json:.tmp/v2.10/${runId}/preview/out`]);
    expect(io.files["generated/site-data.json"]).toBe("tracked");
  });

  it("fails closed when the artifact hash differs from pipeline_runs", async () => {
    const io = fs();
    let invoked = false;
    await expect(runLocalGate({
      runId, stage: "publish-ready", artifact, artifactSha256: "a".repeat(64), fs: io,
      checkSiteData: async () => { invoked = true; },
      build: async () => { invoked = true; },
    })).rejects.toThrow("artifact SHA-256 mismatch");
    expect(invoked).toBe(false);
    expect(io.files).toEqual({});
  });

  it("runs the publish-ready gate only after the preview artifact is valid", async () => {
    const io = fs();
    const calls: string[] = [];
    await runLocalGate({
      runId, stage: "publish-ready", artifact, artifactSha256: sha, fs: io,
      checkSiteData: async (path) => { calls.push(`check:${path}`); },
      build: async (artifactPath, outputPath) => { calls.push(`build:${artifactPath}:${outputPath}`); },
    });
    expect(calls).toEqual([`check:.tmp/v2.10/${runId}/publish-ready/site-data.json`, `build:.tmp/v2.10/${runId}/publish-ready/site-data.json:.tmp/v2.10/${runId}/publish-ready/out`]);
  });

  it("does not advance or publish on checker/build failure", async () => {
    const io = fs();
    await expect(runLocalGate({
      runId, stage: "preview", artifact, artifactSha256: sha, fs: io,
      checkSiteData: async () => { throw new Error("invalid artifact"); },
      build: async () => { throw new Error("must not run"); },
    })).rejects.toThrow("invalid artifact");
    expect(io.files).toEqual({ [`.tmp/v2.10/${runId}/preview/site-data.json`]: artifact });
  });

  it("uses distinct deterministic roots for concurrent runs and reuses the same root on repeat", async () => {
    const io = fs();
    const otherRunId = `pipeline-v2.10:${"b".repeat(64)}`;
    const paths: string[] = [];
    const gate = (id: string) => runLocalGate({
      runId: id, stage: "preview", artifact, artifactSha256: sha, fs: io,
      checkSiteData: async (path) => { paths.push(path); },
      build: async (artifactPath, outputPath) => { paths.push(`${artifactPath}|${outputPath}`); },
    });
    await Promise.all([gate(runId), gate(otherRunId), gate(runId)]);
    expect(new Set(paths.filter((path) => path.endsWith("site-data.json")))).toEqual(new Set([
      `.tmp/v2.10/${runId}/preview/site-data.json`,
      `.tmp/v2.10/${otherRunId}/preview/site-data.json`,
    ]));
    expect(paths.filter((path) => path.endsWith("site-data.json"))).toHaveLength(3);
    expect(paths.filter((path) => path.includes(`${runId}/preview`))).toHaveLength(4);
    expect(paths).not.toContain(".tmp/v2.10/preview/site-data.json");
  });

  it("reconciles a complete run-scoped artifact and export by its durable SHA", async () => {
    const root = `.tmp/v2.10/${runId}/preview`;
    const io = fs({
      [`${root}/site-data.json`]: artifact,
      [`${root}/out/index.html`]: "exported",
      [`${root}/gate-complete.json`]: JSON.stringify({ artifactSha256: sha, outputManifest: { files: [{ path: "index.html", sha256: createHash("sha256").update("exported").digest("hex"), size: 8 }] }, outputManifestSha256: createHash("sha256").update(JSON.stringify({ files: [{ path: "index.html", sha256: createHash("sha256").update("exported").digest("hex"), size: 8 }] })).digest("hex") }),
    });
    await expect(reconcileLocalGate({ runId, stage: "preview", artifact, artifactSha256: sha, fs: io }))
      .resolves.toEqual({ outcome: "consistent", artifactSha256: sha });
  });

  it("does not reconcile a truncated export merely because index.html exists", async () => {
    const root = `.tmp/v2.10/${runId}/preview`;
    const io = fs({
      [`${root}/site-data.json`]: artifact,
      [`${root}/out/index.html`]: "truncated",
      [`${root}/gate-complete.json`]: JSON.stringify({ artifactSha256: sha }),
    });
    await expect(reconcileLocalGate({ runId, stage: "preview", artifact, artifactSha256: sha, fs: io }))
      .resolves.toEqual({ outcome: "conflict" });
  });

  it("reports missing only when the run-scoped gate artifact or export is absent", async () => {
    await expect(reconcileLocalGate({ runId, stage: "preview", artifact, artifactSha256: sha, fs: fs() }))
      .resolves.toEqual({ outcome: "missing" });
    await expect(reconcileLocalGate({
      runId, stage: "preview", artifact, artifactSha256: sha,
      fs: fs({ [`.tmp/v2.10/${runId}/preview/site-data.json`]: artifact }),
    })).resolves.toEqual({ outcome: "missing" });
  });

  it("reports conflict when the run-scoped artifact or export does not match", async () => {
    const root = `.tmp/v2.10/${runId}/preview`;
    const outputManifest = { files: [{ path: "index.html", sha256: createHash("sha256").update("exported").digest("hex"), size: 8 }] };
    const complete = { [`${root}/site-data.json`]: artifact, [`${root}/out/index.html`]: "exported", [`${root}/gate-complete.json`]: JSON.stringify({ artifactSha256: sha, outputManifest, outputManifestSha256: createHash("sha256").update(JSON.stringify(outputManifest)).digest("hex") }) };
    await expect(reconcileLocalGate({ runId, stage: "preview", artifact, artifactSha256: null, fs: fs(complete) }))
      .resolves.toEqual({ outcome: "conflict" });
    await expect(reconcileLocalGate({
      runId, stage: "preview", artifact, artifactSha256: sha,
      fs: fs({ ...complete, [`${root}/site-data.json`]: "different" }),
    })).resolves.toEqual({ outcome: "conflict" });
    await expect(reconcileLocalGate({
      runId, stage: "preview", artifact, artifactSha256: sha,
      fs: fs({ [`${root}/site-data.json`]: artifact, [`${root}/out/index.html`]: "different", [`${root}/gate-complete.json`]: complete[`${root}/gate-complete.json`] }),
    })).resolves.toEqual({ outcome: "conflict" });
  });
});
