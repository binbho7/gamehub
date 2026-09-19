import { describe, expect, it, vi } from "vitest";
import { runPipelineCommand } from "./command";
import type { PipelineRunnerComposition, PipelineRunnerRepository } from "./runner";
import { runPipelineCli } from "../../scripts/run-games-pipeline";

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
});
