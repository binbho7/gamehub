import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runLocalGate, type LocalGateFs } from "./local";

const artifact = "{\"version\":1}\n";
const sha = createHash("sha256").update(artifact).digest("hex");

function fs(initial: Record<string, string> = {}): LocalGateFs & { files: Record<string, string> } {
  const files = { ...initial };
  return {
    files,
    async read(path) { return files[path]; },
    async write(path, value) { files[path] = value; },
  };
}

describe("V2.10 local preview and publish-ready gates", () => {
  it("checks and builds from a temp artifact/output without touching the tracked artifact", async () => {
    const io = fs({ "generated/site-data.json": "tracked" });
    const calls: string[] = [];
    const result = await runLocalGate({
      stage: "preview", artifact, artifactSha256: sha, fs: io,
      checkSiteData: async (path) => { calls.push(`check:${path}`); expect(await io.read(path)).toBe(artifact); },
      build: async (artifactPath, outputPath) => {
        calls.push(`build:${artifactPath}:${outputPath}`);
        expect(await io.read(artifactPath)).toBe(artifact);
        await io.write(`${outputPath}/index.html`, "ok");
      },
    });
    expect(result).toEqual({ artifactSha256: sha });
    expect(calls).toEqual(["check:.tmp/v2.10/preview/site-data.json", "build:.tmp/v2.10/preview/site-data.json:.tmp/v2.10/preview/out"]);
    expect(io.files["generated/site-data.json"]).toBe("tracked");
  });

  it("fails closed when the artifact hash differs from pipeline_runs", async () => {
    const io = fs();
    let invoked = false;
    await expect(runLocalGate({
      stage: "publish-ready", artifact, artifactSha256: "a".repeat(64), fs: io,
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
      stage: "publish-ready", artifact, artifactSha256: sha, fs: io,
      checkSiteData: async (path) => { calls.push(`check:${path}`); },
      build: async (artifactPath, outputPath) => { calls.push(`build:${artifactPath}:${outputPath}`); },
    });
    expect(calls).toEqual(["check:.tmp/v2.10/publish-ready/site-data.json", "build:.tmp/v2.10/publish-ready/site-data.json:.tmp/v2.10/publish-ready/out"]);
  });

  it("does not advance or publish on checker/build failure", async () => {
    const io = fs();
    await expect(runLocalGate({
      stage: "preview", artifact, artifactSha256: sha, fs: io,
      checkSiteData: async () => { throw new Error("invalid artifact"); },
      build: async () => { throw new Error("must not run"); },
    })).rejects.toThrow("invalid artifact");
    expect(io.files).toEqual({ ".tmp/v2.10/preview/site-data.json": artifact });
  });
});
