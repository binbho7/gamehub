import { describe, expect, it } from "vitest";
import { runPipeline, type PipelineRunnerComposition, type PipelineRunnerRepository } from "./runner";
import { initialItemStages, initialRunStages, serializeItemStages, serializeRunStages } from "./state";
import type { ItemRow, RunRow, RunSnapshot } from "./run-repository";
import { deriveRunId } from "./canonical";

function makeItem(ordinal: number): ItemRow {
  return {
    run_id: "scenario-run", ordinal, steam_app_id: String(ordinal), game_id: null,
    current_stage: "import", current_state: "pending", attempt_count: 0,
    stage_states_json: serializeItemStages(initialItemStages()), reason_code: null,
    retry_class: "none", updated_at: 1,
  };
}

function makeRun(): RunRow {
  return {
    run_id: "scenario-run", manifest_hash: "a".repeat(64), pipeline_version: "2.10",
    policy_version: "public-v1", snapshot_date: "2026-09-19", status: "created",
    current_stage: null, run_stage_states_json: serializeRunStages(initialRunStages()),
    artifact_sha256: null, created_at: 1, updated_at: 1,
  };
}

function scenarioRepository(items: ItemRow[]): { repository: PipelineRunnerRepository; state: () => RunSnapshot } {
  let snapshot: RunSnapshot = { run: makeRun(), items };
  const repository: PipelineRunnerRepository = {
    async load(runId) {
      expect(runId).toBe("scenario-run");
      return snapshot;
    },
    async transitionRun(expected, event) {
      const status = event.type === "start" ? "running" : event.type === "fatal" ? "failed" : expected.status;
      snapshot = { ...snapshot, run: { ...expected, status } };
      return snapshot.run;
    },
    async transitionItem(expected, stage, event) {
      const stages = JSON.parse(expected.stage_states_json) as Record<string, { state: string; attemptCount: number; reasonCode: string | null; retryClass: string }>;
      const current = stages[stage]!;
      if (event.type === "start") {
        stages[stage] = { ...current, state: "running", attemptCount: current.attemptCount + 1 };
      } else if (event.type === "succeed") {
        stages[stage] = { ...current, state: "succeeded", reasonCode: null, retryClass: "none" };
      } else if (event.type === "fail") {
        stages[stage] = { ...current, state: "retryable_failed", reasonCode: event.reasonCode, retryClass: event.retryClass };
      }
      const updated: ItemRow = {
        ...expected,
        game_id: event.type === "succeed" && stage === "import" ? (event.gameId ?? expected.game_id) : expected.game_id,
        current_state: event.type === "start" ? "running" : event.type === "succeed" ? "pending" : "retryable_failed",
        current_stage: event.type === "succeed" ? (stage === "import" ? "enrich" : stage === "enrich" ? "verify" : stage === "verify" ? "images" : stage === "images" ? "evaluate" : stage) : stage,
        stage_states_json: JSON.stringify(stages), reason_code: event.type === "fail" ? event.reasonCode : null,
        retry_class: event.type === "fail" ? event.retryClass : "none", updated_at: 1,
      };
      snapshot = { ...snapshot, items: snapshot.items.map((item) => item.ordinal === expected.ordinal ? updated : item) };
      return { item: updated, action: "persist" as const };
    },
  };
  return { repository, state: () => snapshot };
}

describe("V2.10 Task 14 pipeline scenarios", () => {
  it("keeps 100-candidate provider caps, serializes writes, and returns canonical ordering", async () => {
    const { repository } = scenarioRepository(Array.from({ length: 100 }, (_, index) => makeItem(index + 1)));
    const active: Record<string, number> = { import: 0, enrich: 0, verify: 0, images: 0 };
    const peak: Record<string, number> = { import: 0, enrich: 0, verify: 0, images: 0 };
    let activeWrites = 0;
    let peakWrites = 0;
    const composition: PipelineRunnerComposition = {
      async runStage({ stage, steamAppId }) {
        if (stage in active) {
          active[stage]!++;
          peak[stage] = Math.max(peak[stage]!, active[stage]!);
        }
        await new Promise((resolve) => setTimeout(resolve, (101 - Number(steamAppId)) % 3));
        if (stage in active) active[stage]!--;
        return { status: "succeeded", gameId: Number(steamAppId), summary: "ok" };
      },
    };
    const originalTransition = repository.transitionItem;
    repository.transitionItem = async (...args) => {
      activeWrites++;
      peakWrites = Math.max(peakWrites, activeWrites);
      const result = await originalTransition(...args);
      activeWrites--;
      return result;
    };

    const result = await runPipeline({ runId: "scenario-run", repository, composition, write: true, now: () => 1 });
    expect(peak).toMatchObject({ import: 4, enrich: 2, verify: 2, images: 2 });
    expect(peakWrites).toBe(1);
    expect(result.items).toHaveLength(100);
    expect(result.items.map((item) => item.ordinal)).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
    expect(deriveRunId).toBeTypeOf("function");
  }, 30_000);
});
