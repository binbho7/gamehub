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

function retryItem(ordinal: number, reasonCode: "network_error" | "stale_attempt", steamAppId = String(ordinal * 10)): ItemRow {
  const value = item("retryable_failed");
  const stages = JSON.parse(value.stage_states_json) as ReturnType<typeof initialItemStages>;
  stages.import = { ...stages.import, state: "retryable_failed", reasonCode, retryClass: "retryable", attemptCount: 1 };
  return { ...value, ordinal, steam_app_id: steamAppId, reason_code: reasonCode, stage_states_json: JSON.stringify(stages) };
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
      async commitRetryPlan(plans) { return plans.map(({ expected }) => expected); },
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
      async commitRetryPlan(plans) { return plans.map(({ expected }) => expected); },
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
      async transitionRun(expected, event) {
        events.push(event.type);
        if (event.type === "resume") {
          const states = JSON.parse(expected.run_stage_states_json) as Record<string, { state: string }>;
          states.preview = { ...states.preview, state: "running" };
          return { ...expected, status: "running", run_stage_states_json: JSON.stringify(states) };
        }
        return { ...expected, status: expected.status };
      },
      async transitionItem(expected) { return { item: expected, action: "execute" }; },
    };
    await resumePipeline({ runId: "run", repository, composition: { async runStage() { events.push("item"); return { status: "succeeded", gameId: 7, summary: "ok" }; }, async runRunStage() { events.push("run-stage"); return { artifactSha256: "a".repeat(64) }; } }, write: true });
    expect(events).toContain("recover:preview");
    expect(events).not.toContain("resume");
  });

  it("does not resume a run already returned as running by recovery", async () => {
    const events: string[] = [];
    const running = { ...run, status: "running" as const, current_stage: "preview" as const,
      run_stage_states_json: JSON.stringify({ export: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" }, preview: { state: "running", attemptCount: 1, reasonCode: null, retryClass: "none" }, "publish-ready": { state: "pending", attemptCount: 0, reasonCode: null, retryClass: "none" } }) };
    const repository: PipelineRecoveryRepository = {
      async load() { return { run: running, items: [] }; },
      async recoverRun(expected) { return { ...expected, status: "running" }; },
      async transitionRun(_expected, event) { events.push(event.type); return running; },
      async transitionItem(expected) { return { item: expected, action: "execute" }; },
    };
    await resumePipeline({ runId: "run", repository, composition: {
      async runStage() { throw new Error("unused"); },
      async runRunStage() { events.push("run-stage"); return { artifactSha256: "a".repeat(64) }; },
    }, write: true });
    expect(events).toEqual(["run-stage", "succeed"]);
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

  it("fails closed when atomic retry preparation is unavailable", async () => {
    const repository: PipelineRecoveryRepository = {
      async load() { return { run, items: [item("retryable_failed")] }; },
      async transitionRun(expected, event) { return { ...expected, status: event.type === "resume" ? "running" : expected.status }; },
      async transitionItem() { throw new Error("duplicate provider write"); },
    };
    await expect(retryPipeline({ runId: "run", repository, composition: { async runStage() { throw new Error("must not execute"); } }, write: true }))
      .rejects.toThrow("atomic retry preparation unavailable");
  });

  it("refreshes retry dependencies through a durable repository transition", async () => {
    const events: string[] = [];
    let refreshed = false;
    const repository: PipelineRecoveryRepository = {
      async load() { return { run, items: [refreshed ? { ...item("retryable_failed"), current_state: "pending" as const, reason_code: null, retry_class: "none", stage_states_json: JSON.stringify(initialItemStages()) } : item("retryable_failed")] }; },
      async commitRetryPlan(plans) { events.push("commit"); refreshed = true; return plans.map(({ expected }) => ({ ...expected, current_state: "pending" as const })); },
      async transitionRun(expected) { return expected; },
      async transitionItem(expected) { return { item: expected, action: "execute" }; },
    };
    const result = await retryPipeline({ runId: "run", repository, composition: { async runStage() { return { status: "succeeded", gameId: 7, summary: "ok" }; } }, write: true });
    expect(events).toEqual(["commit"]);
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

  it("does not requeue a stale provider item when reconciliation is unavailable", async () => {
    const events: string[] = [];
    const running = { ...run, status: "running" as const };
    const repository: PipelineRecoveryRepository = {
      async load() { return { run: running, items: [item()] }; },
      async recoverItem() { events.push("recover"); return { item: item("retryable_failed"), action: "persist" }; },
      async requeueItem() { events.push("requeue"); return { item: item("retryable_failed"), action: "persist" }; },
      async transitionRun(expected) { return expected; },
      async transitionItem(expected) { events.push("transition"); return { item: expected, action: "execute" }; },
    };
    await resumePipeline({ runId: "run", repository, composition: { async runStage() { throw new Error("must not execute"); } }, write: true });
    expect(events).toEqual([]);
  });

  it.each([
    ["ordinary first", [retryItem(1, "network_error"), retryItem(2, "stale_attempt")]],
    ["stale first", [retryItem(1, "stale_attempt"), retryItem(2, "network_error")]],
    ["multiple ordinary first", [retryItem(1, "network_error"), retryItem(2, "network_error"), retryItem(3, "stale_attempt")]],
  ])("preflights unreconcilable stale attempts before every mutation: %s", async (_label, items) => {
    const events: string[] = [];
    const repository: PipelineRecoveryRepository = {
      async load() { return { run, items }; },
      async requeueItem(expected) { events.push(`requeue:${expected.ordinal}`); return { item: expected, action: "persist" }; },
      async transitionRun(expected) { events.push("run"); return expected; },
      async transitionItem(expected) { events.push(`transition:${expected.ordinal}`); return { item: expected, action: "execute" }; },
    };
    const result = await retryPipeline({ runId: "run", repository, composition: {
      async runStage() { events.push("execute"); throw new Error("must not execute"); },
    }, write: true });
    expect(events).toEqual([]);
    expect(result.items).toEqual(items);
  });

  it.each(["consistent", "missing", "conflict"] as const)("reconciles every stale item before ordinary requeue: %s", async (outcome) => {
    const events: string[] = [];
    const stale = retryItem(1, "stale_attempt");
    const ordinary = retryItem(2, "network_error");
    let current = [stale, ordinary];
    const repository: PipelineRecoveryRepository = {
      async load() { return { run, items: current }; },
      async transitionRun(expected) { return { ...expected, status: "running" }; },
      async transitionItem(expected, _stage, event) {
        if (event.type === "reconcile") {
          events.push(`transition:${event.result}:${expected.ordinal}`);
          const state = event.result === "consistent" ? "succeeded" : event.result === "conflict" ? "blocked" : "retryable_failed";
          const updated = { ...expected, current_state: state, reason_code: event.result === "missing" ? "completion_missing" : null } as ItemRow;
          current = current.map((entry) => entry.ordinal === expected.ordinal ? updated : entry);
          return { item: updated, action: event.result === "consistent" ? "skip_execution" as const : "persist" as const };
        }
        return { item: expected, action: "execute" as const };
      },
      async requeueItem(expected) {
        events.push(`requeue:${expected.ordinal}`);
        const updated = { ...expected, current_state: "pending" as const, reason_code: null };
        current = current.map((entry) => entry.ordinal === expected.ordinal ? updated : entry);
        return { item: updated, action: "persist" as const };
      },
      async commitRetryPlan(plans) {
        events.push("commit");
        return plans.map(({ expected, events: planEvents }) => {
          const reconcile = planEvents.find((event) => event.type === "reconcile");
          const refreshed = planEvents.some((event) => event.type === "refresh");
          const state = refreshed ? "pending" : reconcile?.type === "reconcile" && reconcile.result === "consistent" ? "succeeded" : "blocked";
          const updated = { ...expected, current_state: state } as ItemRow;
          current = current.map((entry) => entry.ordinal === expected.ordinal ? updated : entry);
          return updated;
        });
      },
    };
    await retryPipeline({ runId: "run", repository, composition: {
      async reconcileStage() { events.push("reconcile:1"); return outcome; },
      async runStage({ steamAppId }) { events.push(`execute:${steamAppId}`); return { status: "succeeded", gameId: 7, summary: "ok" }; },
    }, write: true });
    expect(events.indexOf("reconcile:1")).toBeLessThan(events.indexOf("commit"));
  });

  it("reconciles all stale rows before any ordinary mutation", async () => {
    const events: string[] = [];
    const items = [retryItem(1, "stale_attempt"), retryItem(2, "network_error"), retryItem(3, "stale_attempt")];
    const repository: PipelineRecoveryRepository = {
      async load() { return { run, items }; },
      async transitionRun(expected) { return expected; },
      async transitionItem(expected) { events.push(`transition:${expected.ordinal}`); return { item: { ...expected, current_state: "succeeded" }, action: "skip_execution" }; },
      async requeueItem(expected) { events.push(`requeue:${expected.ordinal}`); return { item: expected, action: "persist" }; },
      async commitRetryPlan(plans) { events.push("commit"); return plans.map(({ expected }) => expected); },
    };
    await retryPipeline({ runId: "run", repository, composition: {
      async reconcileStage({ steamAppId }) { events.push(`reconcile:${steamAppId}`); return "consistent"; },
      async runStage() { return { status: "succeeded", gameId: 7, summary: "ok" }; },
    }, write: true });
    expect(events.slice(0, 3)).toEqual(["reconcile:10", "reconcile:30", "commit"]);
  });

  it("does not mutate ordinary retryables when stale reconciliation throws", async () => {
    const events: string[] = [];
    const items = [retryItem(1, "stale_attempt"), retryItem(2, "network_error")];
    const repository: PipelineRecoveryRepository = {
      async load() { return { run, items }; },
      async transitionRun(expected) { return expected; },
      async transitionItem(expected) { events.push(`transition:${expected.ordinal}`); return { item: expected, action: "persist" }; },
      async requeueItem(expected) { events.push(`requeue:${expected.ordinal}`); return { item: expected, action: "persist" }; },
    };
    await expect(retryPipeline({ runId: "run", repository, composition: {
      async reconcileStage() { throw new Error("reconciliation unavailable"); },
      async runStage() { throw new Error("must not execute"); },
    }, write: true })).rejects.toThrow("reconciliation unavailable");
    expect(events).toEqual([]);
  });

  it("collects every stale outcome before writing when a later reconciliation throws", async () => {
    const events: string[] = [];
    const items = [retryItem(1, "stale_attempt"), retryItem(2, "stale_attempt"), retryItem(3, "network_error")];
    const repository: PipelineRecoveryRepository = {
      async load() { return { run, items }; },
      async transitionRun(expected) { return expected; },
      async transitionItem(expected) { events.push(`transition:${expected.ordinal}`); return { item: expected, action: "persist" }; },
      async requeueItem(expected) { events.push(`requeue:${expected.ordinal}`); return { item: expected, action: "persist" }; },
    };
    await expect(retryPipeline({ runId: "run", repository, composition: {
      async reconcileStage({ steamAppId }) {
        events.push(`reconcile:${steamAppId}`);
        if (steamAppId === "20") throw new Error("second reconciliation unavailable");
        return "consistent";
      },
      async runStage() { throw new Error("must not execute"); },
    }, write: true })).rejects.toThrow("second reconciliation unavailable");
    expect(events).toEqual(["reconcile:10", "reconcile:20"]);
  });
});
