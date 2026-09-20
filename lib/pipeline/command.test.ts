import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { runPipelineCommand } from "./command";
import type { PipelineRunnerComposition, PipelineRunnerRepository } from "./runner";
import { runPipelineCli } from "../../scripts/run-games-pipeline";
import { createPipelineCliComposition } from "../../scripts/run-games-pipeline";
import { parsePipelineArgs } from "../../scripts/run-games-pipeline";
import type { RunSnapshot } from "./run-repository";

const validRunId = "pipeline-v2.10:" + "a".repeat(64);
const snapshot = { run: { run_id: validRunId, manifest_hash: "b".repeat(64), pipeline_version: "2.10", policy_version: "policy", snapshot_date: "2026-09-19", status: "paused", current_stage: null, run_stage_states_json: "{}", artifact_sha256: null, created_at: 1, updated_at: 1 }, items: [{ ordinal: 1, steam_app_id: "7" }] } as unknown as RunSnapshot;

describe("pipeline run command composition boundary", () => {
  it("names evaluate in the invalid command diagnostic", () => {
    expect(() => parsePipelineArgs(["bogus", "--run-id", validRunId])).toThrow("run, resume, retry, or evaluate");
  });
  it("invokes the bounded runner with the exact --run-id scope", async () => {
    const repository = {} as PipelineRunnerRepository;
    const composition = {} as PipelineRunnerComposition;
    const run = vi.fn(async () => ({ status: "running" as const, run: {} as never, items: [] }));

    await expect(runPipelineCommand({ runId: "pipeline-v2.10:abc", repository, composition, write: true, run })).resolves.toMatchObject({
      status: "running",
    });
    expect(run).toHaveBeenCalledWith({ runId: "pipeline-v2.10:abc", repository, composition, write: true });
  });

  it("parses the actual games:pipeline run boundary and forwards the exact durable run ID", async () => {
    const repository = {} as PipelineRunnerRepository;
    const composition = {} as PipelineRunnerComposition;
    const run = vi.fn(async () => ({ status: "running" as const, run: {} as never, items: [] }));

    await expect(runPipelineCli(["run", "--run-id", "pipeline-v2.10:" + "a".repeat(64)], {
      repository,
      composition,
      run,
      stdout: vi.fn(),
      stderr: vi.fn(),
    })).resolves.toBe(0);

    expect(run).toHaveBeenCalledWith({
      runId: "pipeline-v2.10:" + "a".repeat(64),
      repository,
      composition,
      write: false,
    });
  });

  it.each(["resume", "retry"])("accepts %s --run-id while evaluate remains read-only", async (command) => {
    const run = vi.fn(async () => ({ status: "running" as const, run: {} as never, items: [] }));
    const recover = vi.fn(async () => ({ status: "running" as const, run: {} as never, items: [] }));
    await expect(runPipelineCli([command, "--run-id", "pipeline-v2.10:" + "a".repeat(64), "--write"], {
      repository: {} as PipelineRunnerRepository, composition: {} as PipelineRunnerComposition, run,
      ...(command === "resume" ? { resume: recover } : { retry: recover }), stdout: vi.fn(), stderr: vi.fn(),
    })).resolves.toBe(0);
    expect(recover).toHaveBeenCalledWith(expect.objectContaining({ write: true }));
    expect(run).not.toHaveBeenCalled();
  });

  it("runs read-only evaluate with durable snapshot, linked selection, and deterministic diagnostics", async () => {
    const stdout = vi.fn();
    const evaluator = vi.fn(() => ({ diagnostics: [{ code: "missing_required_metadata", steamAppId: "7", message: "missing" }] }));
    const repository = { load: vi.fn(async () => snapshot) } as unknown as PipelineRunnerRepository;
    await expect(runPipelineCli(["evaluate", "--run-id", validRunId, "--selection", "selection.json"], {
      repository, composition: {} as PipelineRunnerComposition, preflightEvaluate: evaluator,
      readSelection: vi.fn(async () => ({ selectionVersion: "1", pipelineVersion: "2.10", policyVersion: "policy", snapshotDate: "2026-09-19", manifestHash: "b".repeat(64), items: [{ steamAppId: "7", decision: "include" }] })), stdout, stderr: vi.fn(),
    })).resolves.toBe(0);
    expect(evaluator).toHaveBeenCalledWith(expect.objectContaining({ snapshot, selection: expect.any(Object) }));
    expect(stdout).toHaveBeenCalledWith(JSON.stringify({ runId: validRunId, diagnostics: [{ code: "missing_required_metadata", steamAppId: "7", message: "missing" }] }) + "\n");
  });

  it("runs evaluate without a mutating provider composition", async () => {
    const stdout = vi.fn();
    await expect(runPipelineCli(["evaluate", "--run-id", validRunId, "--selection", "selection.json"], {
      repository: { load: vi.fn(async () => snapshot) } as unknown as PipelineRunnerRepository,
      preflightEvaluate: vi.fn(async () => ({ diagnostics: [] })),
      readSelection: vi.fn(async () => ({ selectionVersion: "1", pipelineVersion: "2.10", policyVersion: "policy", snapshotDate: "2026-09-19", manifestHash: "b".repeat(64), items: [{ steamAppId: "7", decision: "include" }] })),
      stdout,
      stderr: vi.fn(),
    })).resolves.toBe(0);
    expect(stdout).toHaveBeenCalled();
  });

  it("rejects evaluate writes", async () => {
    const stderr = vi.fn();
    await expect(runPipelineCli(["evaluate", "--run-id", validRunId, "--selection", "selection.json", "--write"], {
      repository: {} as PipelineRunnerRepository, composition: {} as PipelineRunnerComposition, stdout: vi.fn(), stderr,
    })).resolves.toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("read-only"));
  });

  it("builds an executable local composition from injected sync fixtures", async () => {
    const calls: string[] = [];
    const composition = await createPipelineCliComposition({
      env: { TWITCH_CLIENT_ID: "fixture-id", TWITCH_CLIENT_SECRET: "fixture-secret", IMAGE_INGEST_TOKEN: "fixture-token" },
      createDependencies: async () => ({
        stages: {
          steam: { execute: async () => ({ gameId: 7, summary: "imported", action: "existing" as const }) },
          igdb: { execute: async () => ({ summary: "enriched" }) },
          links: { execute: async () => ({ summary: "verified" }) },
          images: { execute: async () => ({ summary: "imaged" }) },
        },
        dispose: async () => { calls.push("dispose"); },
      }),
    });
    await expect(composition.runStage({ steamAppId: "7", stage: "import", gameId: null, dryRun: true }))
      .resolves.toMatchObject({ stage: "import", status: "succeeded", gameId: 7 });
    await composition.dispose();
    expect(calls).toEqual(["dispose"]);
  });

  it("fails closed instead of fabricating evaluation success", async () => {
    const composition = await createPipelineCliComposition({
      env: { TWITCH_CLIENT_ID: "fixture-id", TWITCH_CLIENT_SECRET: "fixture-secret", IMAGE_INGEST_TOKEN: "fixture-token" },
      createDependencies: async () => ({
        stages: {
          steam: { execute: async () => ({ gameId: 7, summary: "imported", action: "existing" as const }) },
          igdb: { execute: async () => ({ summary: "enriched" }) },
          links: { execute: async () => ({ summary: "verified" }) },
          images: { execute: async () => ({ summary: "imaged" }) },
        },
        dispose: async () => {},
      }),
    });
    await expect(composition.runStage({ steamAppId: "7", stage: "evaluate", gameId: 7, dryRun: true }))
      .rejects.toMatchObject({ code: "evaluation_runtime_unavailable" });
    await composition.dispose();
  });

  it("wires run-level stages to the injected local checker, build, artifact, and temp paths", async () => {
    const files: Record<string, string> = {};
    const calls: string[] = [];
    const composition = await createPipelineCliComposition({
      tempRoot: "/tmp/task12",
      artifact: async () => "artifact",
      gateFs: { async read(path) { return files[path]; }, async list(path) { return Object.keys(files).filter((file) => file.startsWith(`${path}/`)); }, async remove(path) { delete files[path]; }, async write(path, value) { files[path] = value; } },
      checkSiteData: async (path) => { calls.push(`check:${path}`); },
      build: async (artifactPath, outputPath) => { calls.push(`build:${artifactPath}:${outputPath}`); files[`${outputPath}/index.html`] = "ok"; },
      env: { TWITCH_CLIENT_ID: "fixture-id", TWITCH_CLIENT_SECRET: "fixture-secret", IMAGE_INGEST_TOKEN: "fixture-token" },
      createDependencies: async () => ({ stages: {
        steam: { execute: async () => ({ gameId: 7, summary: "imported", action: "existing" as const }) },
        igdb: { execute: async () => ({ summary: "enriched" }) }, links: { execute: async () => ({ summary: "verified" }) },
        images: { execute: async () => ({ summary: "imaged" }) },
      }, dispose: async () => {} }),
    });
    const sha = createHash("sha256").update("artifact").digest("hex");
    const runId = `pipeline-v2.10:${"a".repeat(64)}`;
    await expect(composition.runRunStage!({ runId, stage: "preview", artifactSha256: sha })).resolves.toEqual({ artifactSha256: sha });
    expect(calls).toEqual([`check:/tmp/task12/${runId}/preview/site-data.json`, `build:/tmp/task12/${runId}/preview/site-data.json:/tmp/task12/${runId}/preview/out`]);
    await composition.dispose();
  });

  it.each(["preview", "publish-ready"] as const)("reconciles an interrupted %s as missing so the real CLI can retry it", async (stage) => {
    const artifact = "artifact";
    const sha = createHash("sha256").update(artifact).digest("hex");
    const composition = await createPipelineCliComposition({
      artifact: async () => artifact,
      env: { TWITCH_CLIENT_ID: "fixture-id", TWITCH_CLIENT_SECRET: "fixture-secret", IMAGE_INGEST_TOKEN: "fixture-token" },
      createDependencies: async () => ({ stages: {
        steam: { execute: async () => ({ gameId: 7, summary: "imported", action: "existing" as const }) },
        igdb: { execute: async () => ({ summary: "enriched" }) }, links: { execute: async () => ({ summary: "verified" }) },
        images: { execute: async () => ({ summary: "imaged" }) },
      }, dispose: async () => {} }),
    });
    await expect(composition.reconcileRunStage!({ runId: `pipeline-v2.10:${"a".repeat(64)}`, stage, artifactSha256: sha })).resolves.toEqual({ outcome: "missing" });
    await composition.dispose();
  });

  it("reports conflict during real CLI reconciliation when the durable artifact hash is absent or invalid", async () => {
    const composition = await createPipelineCliComposition({
      artifact: async () => "artifact",
      env: { TWITCH_CLIENT_ID: "fixture-id", TWITCH_CLIENT_SECRET: "fixture-secret", IMAGE_INGEST_TOKEN: "fixture-token" },
      createDependencies: async () => ({ stages: {
        steam: { execute: async () => ({ gameId: 7, summary: "imported", action: "existing" as const }) },
        igdb: { execute: async () => ({ summary: "enriched" }) }, links: { execute: async () => ({ summary: "verified" }) },
        images: { execute: async () => ({ summary: "imaged" }) },
      }, dispose: async () => {} }),
    });
    const runId = `pipeline-v2.10:${"a".repeat(64)}`;
    await expect(composition.reconcileRunStage!({ runId, stage: "preview", artifactSha256: null })).resolves.toEqual({ outcome: "missing" });
    await expect(composition.reconcileRunStage!({ runId, stage: "preview", artifactSha256: "bad" })).resolves.toEqual({ outcome: "missing" });
    await composition.dispose();
  });
});
