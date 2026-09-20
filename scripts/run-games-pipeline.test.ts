import { describe, expect, it, vi } from "vitest";
import { deriveRunId, hashManifest } from "../lib/pipeline/canonical";
import { parseInputManifest } from "../lib/pipeline/contracts";
import { initialItemStages, initialRunStages, serializeItemStages, serializeRunStages } from "../lib/pipeline/state";
import { parsePipelineArgs, runPipelineCli, type PipelineCliDependencies } from "./run-games-pipeline";

const manifest = parseInputManifest({
  manifestVersion: "1", pipelineVersion: "2.10", policyVersion: "public-v1", snapshotDate: "2026-09-20",
  items: [{ ordinal: 1, steamAppId: "123" }],
});
const runId = deriveRunId(manifest);
const snapshot = {
  run: { run_id: runId, manifest_hash: hashManifest(manifest), pipeline_version: "2.10" as const,
    policy_version: manifest.policyVersion, snapshot_date: manifest.snapshotDate, status: "created" as const,
    current_stage: null, run_stage_states_json: serializeRunStages(initialRunStages()), artifact_sha256: null,
    created_at: 1, updated_at: 1 },
  items: [{ run_id: runId, ordinal: 1, steam_app_id: "123", game_id: null, current_stage: "import" as const,
    current_state: "pending" as const, attempt_count: 0, stage_states_json: serializeItemStages(initialItemStages()),
    reason_code: null, retry_class: "none" as const, updated_at: 1 }],
};

function deps(overrides: Partial<PipelineCliDependencies> = {}): PipelineCliDependencies {
  return {
    repository: { load: vi.fn(async () => snapshot), transitionRun: vi.fn(), transitionItem: vi.fn() },
    composition: { runStage: vi.fn(async () => ({ status: "succeeded", gameId: 1, summary: "ok" })) },
    stdout: vi.fn(), stderr: vi.fn(), ...overrides,
  } as PipelineCliDependencies;
}

describe("V2.10 operator CLI", () => {
  it("parses create dry-run and write forms without accepting remote execution", () => {
    expect(parsePipelineArgs(["create", "--manifest", "manifest.json"])).toMatchObject({ command: "create", manifest: "manifest.json", write: false });
    expect(parsePipelineArgs(["create", "--manifest", "manifest.json", "--write", "--json"])).toMatchObject({ command: "create", manifest: "manifest.json", write: true, json: true });
    expect(() => parsePipelineArgs(["create", "--manifest", "manifest.json", "--remote"])).toThrow("--remote is not supported");
  });

  it("parses every operator command with its required scope", () => {
    expect(parsePipelineArgs(["run", "--run-id", runId, "--write"]).command).toBe("run");
    expect(parsePipelineArgs(["resume", "--run-id", runId]).command).toBe("resume");
    expect(parsePipelineArgs(["retry", "--run-id", runId, "--write"]).command).toBe("retry");
    expect(parsePipelineArgs(["report", "--run-id", runId, "--json"])).toMatchObject({ command: "report", json: true });
    expect(parsePipelineArgs(["evaluate", "--run-id", runId, "--selection", "selection.json", "--json"]).command).toBe("evaluate");
    expect(parsePipelineArgs(["export", "--selection", "selection.json", "--snapshot-date", "2026-09-20", "--json"])).toMatchObject({ command: "export", json: true });
    expect(parsePipelineArgs(["preview", "--run-id", runId, "--write"]).command).toBe("preview");
    expect(parsePipelineArgs(["publish-ready", "--run-id", runId, "--write"]).command).toBe("publish-ready");
  });

  it("dry-runs create without mutating the repository", async () => {
    const create = vi.fn();
    const value = deps({ repository: { ...deps().repository, create } as never, readManifest: vi.fn(async () => manifest) });
    expect(await runPipelineCli(["create", "--manifest", "manifest.json", "--json"], value)).toBe(0);
    expect(create).not.toHaveBeenCalled();
    expect(value.stdout).toHaveBeenCalledWith(expect.stringContaining(`"runId":"${runId}"`));
  });

  it("creates a durable run only for create --write", async () => {
    const create = vi.fn(async () => snapshot);
    const value = deps({ repository: { ...deps().repository, create } as never, readManifest: vi.fn(async () => manifest) });
    expect(await runPipelineCli(["create", "--manifest", "manifest.json", "--write", "--json"], value)).toBe(0);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("keeps evaluate read-only and requires a selection", async () => {
    const transitionRun = vi.fn();
    const value = deps({ repository: { ...deps().repository, transitionRun } as never,
      readSelection: vi.fn(async () => ({ selectionVersion: "1", pipelineVersion: "2.10", policyVersion: "public-v1", snapshotDate: "2026-09-20", manifestHash: hashManifest(manifest), items: [{ steamAppId: "123", decision: "include" }] })),
      preflightEvaluate: vi.fn(async () => ({ diagnostics: [] })),
    });
    expect(await runPipelineCli(["evaluate", "--run-id", runId, "--selection", "selection.json", "--json"], value)).toBe(0);
    expect(transitionRun).not.toHaveBeenCalled();
  });

  it("dispatches export without constructing provider stages", async () => {
    const exportCommand = vi.fn(async () => ({ totalGames: 1, eligibleCount: 1 }));
    const value = deps({ exportCommand });
    expect(await runPipelineCli(["export", "--selection", "selection.json", "--snapshot-date", "2026-09-20", "--json"], value)).toBe(0);
    expect(exportCommand).toHaveBeenCalledWith({ selection: "selection.json", snapshotDate: "2026-09-20", json: true });
  });
});
