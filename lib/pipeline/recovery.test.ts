import { describe, expect, it } from "vitest";
import { reconcileItem, recoverInterruptedItem, retryPipeline, resumePipeline, type PipelineRecoveryRepository } from "./recovery";
import { initialItemStages } from "./state";
import type { ItemRow, RunRow } from "./run-repository";

function item(state: "running" | "succeeded" | "retryable_failed" = "running"): ItemRow {
  const stages = initialItemStages();
  stages.import = { state, attemptCount: state === "running" ? 1 : 1, reasonCode: state === "retryable_failed" ? "network_error" : null, retryClass: state === "retryable_failed" ? "retryable" : "none" };
  return { run_id: "run", ordinal: 1, steam_app_id: "10", game_id: 7, current_stage: "import", current_state: state,
    attempt_count: 1, stage_states_json: JSON.stringify(stages), reason_code: stages.import.reasonCode,
    retry_class: stages.import.retryClass, updated_at: 1 };
}

const run = { run_id: "run", manifest_hash: "a".repeat(64), pipeline_version: "2.10", policy_version: "p", snapshot_date: "2026-09-19",
  status: "paused", current_stage: null, run_stage_states_json: JSON.stringify({ export: { state: "pending", attemptCount: 0, reasonCode: null, retryClass: "none" }, preview: { state: "pending", attemptCount: 0, reasonCode: null, retryClass: "none" }, "publish-ready": { state: "pending", attemptCount: 0, reasonCode: null, retryClass: "none" } }), artifact_sha256: null, created_at: 0, updated_at: 1 } as RunRow;

describe("V2.10 recovery orchestration", () => {
  it("recovers an interrupted item and preserves a consistent succeeded stage without execution", async () => {
    const calls: string[] = [];
    const repository: PipelineRecoveryRepository = {
      async recoverItem(expected, stage) { calls.push(`recover:${stage}`); return { item: { ...expected, current_state: "retryable_failed", reason_code: "stale_attempt", retry_class: "retryable" }, action: "persist" }; },
      async reconcileItem(expected, stage, result) { calls.push(`reconcile:${stage}:${result}`); return { item: expected, action: "skip_execution" }; },
      async load() { return { run, items: [item()] }; },
      async transitionRun(expected, event) { return { ...expected, status: event.type === "resume" ? "running" : expected.status }; },
      async transitionItem(expected) { return { item: expected, action: "execute" }; },
    };
    await recoverInterruptedItem(repository, item(), "import", 2);
    await reconcileItem(repository, item("succeeded"), "import", "consistent", 2);
    expect(calls).toEqual(["recover:import", "reconcile:import:consistent"]);
  });

  it("supports retry-only requeue and resume from the durable run id", async () => {
    let loaded = false;
    const repository: PipelineRecoveryRepository = {
      async recoverItem(expected) { return { item: expected, action: "persist" }; },
      async reconcileItem(expected) { return { item: expected, action: "skip_execution" }; },
      async load(id) { loaded = id === "run"; return { run, items: [item("retryable_failed")] }; },
      async transitionRun(expected, event) { return { ...expected, status: event.type === "resume" ? "running" : expected.status }; },
      async transitionItem(expected) { return { item: expected, action: "execute" }; },
    };
    await retryPipeline({ runId: "run", repository, composition: { async runStage() { return { status: "succeeded", gameId: 7, summary: "ok" }; } }, write: true });
    await resumePipeline({ runId: "run", repository, composition: { async runStage() { return { status: "succeeded", gameId: 7, summary: "ok" }; } }, write: true });
    expect(loaded).toBe(true);
  });

  it("maps missing effects to retryable failure and identity conflicts to blocked", async () => {
    const results: string[] = [];
    const repository: PipelineRecoveryRepository = {
      async recoverItem(expected) { return { item: expected, action: "persist" }; },
      async reconcileItem(expected, _stage, result) { results.push(result); return { item: expected, action: "persist" }; },
      async load() { return { run, items: [] }; },
      async transitionRun(expected) { return expected; },
      async transitionItem(expected) { return { item: expected, action: "execute" }; },
    };
    await reconcileItem(repository, item("succeeded"), "import", "missing", 2);
    await reconcileItem(repository, item("succeeded"), "import", "conflict", 2);
    expect(results).toEqual(["missing", "conflict"]);
  });

  it("recovers a running run-level stage and resumes that same stage", async () => {
    const events: string[] = [];
    const running = { ...run, status: "running" as const, current_stage: "preview" as const,
      run_stage_states_json: JSON.stringify({ export: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" }, preview: { state: "running", attemptCount: 1, reasonCode: null, retryClass: "none" }, "publish-ready": { state: "pending", attemptCount: 0, reasonCode: null, retryClass: "none" } }) };
    const repository: PipelineRecoveryRepository = {
      async load() { return { run: running, items: [] }; },
      async recoverRun(expected) { events.push(`recover:${expected.current_stage}`); return { ...expected, status: "paused", current_stage: "preview" }; },
      async transitionRun(expected, event) { events.push(event.type); return { ...expected, status: event.type === "resume" ? "running" : expected.status }; },
      async transitionItem(expected) { return { item: expected, action: "execute" }; },
    };
    await resumePipeline({ runId: "run", repository, composition: { async runStage() { events.push("item"); return { status: "succeeded", gameId: 7, summary: "ok" }; }, async runRunStage() { events.push("run-stage"); return { artifactSha256: "a".repeat(64) }; } }, write: true });
    expect(events).toContain("recover:preview");
    expect(events).toContain("resume");
  });

  it("resumes a pending preview without recovering or failing the run", async () => {
    const events: string[] = [];
    const pendingPreview = { ...run, status: "running" as const, current_stage: "preview" as const,
      run_stage_states_json: JSON.stringify({ export: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" }, preview: { state: "pending", attemptCount: 0, reasonCode: null, retryClass: "none" }, "publish-ready": { state: "pending", attemptCount: 0, reasonCode: null, retryClass: "none" } }) };
    const repository: PipelineRecoveryRepository = {
      async load() { return { run: pendingPreview, items: [] }; },
      async recoverRun() { events.push("recover"); throw new Error("pending preview must not recover"); },
      async transitionRun(expected, event) { events.push(event.type); return { ...expected, status: event.type === "fail" ? "paused" : expected.status }; },
      async transitionItem(expected) { return { item: expected, action: "execute" }; },
    };
    await resumePipeline({ runId: "run", repository, composition: { async runStage() { throw new Error("unused"); }, async runRunStage() { events.push("run-stage"); return { artifactSha256: "a".repeat(64) }; } }, write: true });
    expect(events).toContain("run-stage");
    expect(events).not.toContain("recover");
    expect(events).not.toContain("fail");
  });

  it("reconciles uncertain provider completion before retrying", async () => {
    const events: string[] = [];
    const repository: PipelineRecoveryRepository = {
      async load() { return { run, items: [item("retryable_failed")] }; },
      async reconcileUncertain(expected, stage) { events.push(`reconcile:${stage}`); return { item: { ...expected, current_state: "succeeded" }, action: "skip_execution" }; },
      async transitionRun(expected, event) { return { ...expected, status: event.type === "resume" ? "running" : expected.status }; },
      async transitionItem() { throw new Error("duplicate provider write"); },
    };
    await retryPipeline({ runId: "run", repository, composition: { async runStage() { throw new Error("must not execute"); } }, write: true });
    expect(events).toEqual(["reconcile:import"]);
  });

  it("refreshes retry dependencies through a durable repository transition", async () => {
    const events: string[] = [];
    let refreshed = false;
    const repository: PipelineRecoveryRepository = {
      async load() { return { run, items: [refreshed ? { ...item("retryable_failed"), current_state: "pending" as const, reason_code: null, retry_class: "none", stage_states_json: JSON.stringify(initialItemStages()) } : item("retryable_failed")] }; },
      async reconcileUncertain(expected) { return { item: expected, action: "persist" }; },
      async requeueItem(expected, stage) { events.push(`requeue:${stage}`); refreshed = true; return { item: { ...expected, current_state: "pending" }, action: "persist" }; },
      async transitionRun(expected) { return expected; },
      async transitionItem(expected) { return { item: expected, action: "execute" }; },
    };
    const result = await retryPipeline({ runId: "run", repository, composition: { async runStage() { return { status: "succeeded", gameId: 7, summary: "ok" }; } }, write: true });
    expect(events).toEqual(["requeue:import"]);
    expect(result.items[0]?.current_state).toBe("pending");
  });

  it("does not re-execute an uncertain run-level stage without reconciliation", async () => {
    const running = { ...run, status: "paused" as const, current_stage: "preview" as const,
      run_stage_states_json: JSON.stringify({ export: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" }, preview: { state: "retryable_failed", attemptCount: 1, reasonCode: "composition_failure", retryClass: "retryable" }, "publish-ready": { state: "pending", attemptCount: 0, reasonCode: null, retryClass: "none" } }) };
    let executed = 0;
    const repository: PipelineRecoveryRepository = {
      async load() { return { run: running, items: [] }; },
      async transitionRun(expected, event) { return { ...expected, status: event.type === "fail" ? "paused" : expected.status }; },
      async transitionItem(expected) { return { item: expected, action: "execute" }; },
    };
    await expect(resumePipeline({ runId: "run", repository, composition: { async runStage() { return { status: "succeeded", gameId: 7, summary: "unused" }; }, async runRunStage() { executed++; return { artifactSha256: "a".repeat(64) }; } }, write: true })).resolves.toMatchObject({ status: "paused" });
    expect(executed).toBe(0);
  });
});
