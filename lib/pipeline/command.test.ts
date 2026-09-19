import { describe, expect, it, vi } from "vitest";
import { runPipelineCommand } from "./command";
import type { PipelineRunnerComposition, PipelineRunnerRepository } from "./runner";
import { runPipelineCli } from "../../scripts/run-games-pipeline";
import { createPipelineCliComposition } from "../../scripts/run-games-pipeline";

describe("pipeline run command composition boundary", () => {
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
    await expect(runPipelineCli([command, "--run-id", "pipeline-v2.10:" + "a".repeat(64), "--write"], {
      repository: {} as PipelineRunnerRepository, composition: {} as PipelineRunnerComposition, run, stdout: vi.fn(), stderr: vi.fn(),
    })).resolves.toBe(0);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ write: true }));
  });

  it("rejects evaluate as a mutating pipeline command", async () => {
    const stderr = vi.fn();
    await expect(runPipelineCli(["evaluate", "--run-id", "pipeline-v2.10:" + "a".repeat(64), "--write"], {
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
});
