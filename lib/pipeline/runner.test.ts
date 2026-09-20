import { describe, expect, it } from "vitest";
import { runPipeline, type PipelineRunnerComposition, type PipelineRunnerRepository } from "./runner";
import { initialItemStages, parseItemStages, serializeItemStages } from "./state";
import { transitionItem } from "./transitions";
import { resumePipeline } from "./recovery";
import type { ItemRow, RunRow, RunSnapshot } from "./run-repository";

function item(ordinal: number, steamAppId = String(ordinal)): ItemRow {
  const stages = initialItemStages();
  return { run_id: "run", ordinal, steam_app_id: steamAppId, game_id: null, current_stage: "import",
    current_state: "pending", attempt_count: 0, stage_states_json: JSON.stringify(stages), reason_code: null,
    retry_class: "none", updated_at: 0 };
}

function retryableItem(ordinal: number, steamAppId = String(ordinal)): ItemRow {
  const stages = initialItemStages();
  stages.import = { state: "retryable_failed", attemptCount: 1, reasonCode: "network_error", retryClass: "retryable" };
  return { run_id: "run", ordinal, steam_app_id: steamAppId, game_id: null, current_stage: "import",
    current_state: "retryable_failed", attempt_count: 1, stage_states_json: JSON.stringify(stages), reason_code: "network_error",
    retry_class: "retryable", updated_at: 0 };
}

function exhaustedRetryableItem(ordinal: number, steamAppId = String(ordinal)): ItemRow {
  const stages = initialItemStages();
  stages.import = { state: "retryable_failed", attemptCount: 3, reasonCode: "network_error", retryClass: "retryable" };
  return { run_id: "run", ordinal, steam_app_id: steamAppId, game_id: null, current_stage: "import",
    current_state: "retryable_failed", attempt_count: 3, stage_states_json: JSON.stringify(stages), reason_code: "network_error",
    retry_class: "retryable", updated_at: 0 };
}

function fixture(items: ItemRow[]): { repository: PipelineRunnerRepository; calls: string[] } {
  const calls: string[] = [];
  const run = { run_id: "run", manifest_hash: "a".repeat(64), pipeline_version: "2.10", policy_version: "policy",
    snapshot_date: "2026-09-19", status: "created", current_stage: null, run_stage_states_json: JSON.stringify({
      export: { state: "pending", attemptCount: 0, reasonCode: null, retryClass: "none" },
      preview: { state: "pending", attemptCount: 0, reasonCode: null, retryClass: "none" },
      "publish-ready": { state: "pending", attemptCount: 0, reasonCode: null, retryClass: "none" },
    }), artifact_sha256: null, created_at: 0, updated_at: 0 } as RunRow;
  let snapshot: RunSnapshot = { run, items };
  const repository: PipelineRunnerRepository = {
    async load(runId) { expect(runId).toBe("run"); return snapshot; },
    async transitionRun(expected, event) { calls.push(`run:${event.type}`); snapshot = { ...snapshot, run: { ...expected, status: event.type === "start" ? "running" : "failed" } }; return snapshot.run; },
    async transitionItem(expected, stage, event) { calls.push(`${expected.steam_app_id}:${stage}:${event.type}`); return { item: expected, action: "execute" }; },
  };
  return { repository, calls };
}

describe("automatic item retry", () => {
  it("rejects a requested run stage before any mutation when it differs from durable state", async () => {
    const { repository, calls } = fixture([item(1)]);
    await expect(runPipeline({ runId: "run", repository, composition: { async runStage() { return { status: "succeeded", gameId: 1, summary: "ok" }; } }, write: true, requestedRunStage: "preview" })).rejects.toThrow("requested run stage");
    expect(calls).toEqual([]);
  });

  it("retries retryable failures with injectable 1s and 2s delays", async () => {
    const { repository } = fixture([retryableItem(1)]);
    let attempts = 0;
    const sleeps: number[] = [];
    const result = await runPipeline({ runId: "run", repository, composition: {
      async runStage() { attempts += 1; if (attempts < 3) throw { code: "network_error" }; return { status: "succeeded", gameId: 1, summary: "ok" }; },
    }, write: true, sleep: async (ms) => { sleeps.push(ms); } });
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
    expect(result.status).toBe("running");
  });
});

const composition: PipelineRunnerComposition = {
  async runStage() { return { status: "succeeded", gameId: 1, summary: "ok" }; },
};

describe("V2.10 bounded pipeline runner", () => {
  it.each(["import", "enrich", "verify", "images"] as const)("reconciles interrupted %s before safe replay and preserves other items", async (stage) => {
    let stages = initialItemStages();
    for (const predecessor of ["import", "enrich", "verify", "images"] as const) {
      if (predecessor === stage) break;
      stages = transitionItem(stages, predecessor, predecessor === "import" ? { type: "start" } : { type: "start" }).stages;
      stages = transitionItem(stages, predecessor, predecessor === "import" ? { type: "succeed", gameId: 701 } : { type: "succeed" }).stages;
    }
    stages = transitionItem(stages, stage, { type: "start" }).stages;
    const interrupted: ItemRow = { run_id: "run", ordinal: 1, steam_app_id: "1", game_id: stage === "import" ? null : 701,
      current_stage: stage, current_state: "running", attempt_count: stages[stage].attemptCount,
      stage_states_json: serializeItemStages(stages), reason_code: null, retry_class: "none", updated_at: 0 };
    const unrelated = item(2, "2");
    const base = fixture([interrupted, unrelated]);
    let snapshot: RunSnapshot = { run: (await base.repository.load("run")).run, items: [interrupted, unrelated] };
    const events: string[] = [];
    const repository: PipelineRunnerRepository = {
      async load() { return snapshot; },
      async transitionRun(expected, event) {
        snapshot = { ...snapshot, run: { ...expected, status: event.type === "start" ? "running" : expected.status } };
        return snapshot.run;
      },
      async transitionItem(expected, currentStage, event, now) {
        events.push(event.type === "reconcile" ? `reconcile:${currentStage}` : event.type === "start" ? `start:${currentStage}` : `${expected.ordinal}:${event.type}:${currentStage}`);
        const next = transitionItem(parseItemStages(expected.stage_states_json), currentStage, event);
        if (next.action === "skip_execution") return { item: expected, action: next.action };
        const outcome = next.stages[next.currentStage];
        const updated = { ...expected, current_stage: next.currentStage, current_state: outcome.state,
          attempt_count: outcome.attemptCount, stage_states_json: serializeItemStages(next.stages),
          reason_code: outcome.reasonCode, retry_class: outcome.retryClass,
          game_id: event.type === "succeed" && event.gameId !== undefined ? event.gameId : expected.game_id, updated_at: now };
        snapshot = { ...snapshot, items: snapshot.items.map((item) => item.ordinal === updated.ordinal ? updated : item) };
        return { item: updated, action: next.action };
      },
    };
    const reconciled: string[] = [];
    const executed: string[] = [];
    await resumePipeline({ repository, runId: "run", write: true, composition: {
      async reconcileStage(input) {
        reconciled.push(input.stage);
        return input.stage === stage ? "missing" : "consistent";
      },
      async runStage(input) {
        executed.push(input.stage);
        return { status: "succeeded", gameId: input.stage === "import" ? 701 : input.gameId, summary: "ok" };
      },
    } });
    expect(reconciled.filter((value) => value === stage)).toHaveLength(1);
    expect(events.indexOf(`reconcile:${stage}`)).toBeGreaterThanOrEqual(0);
    expect(events.indexOf(`start:${stage}`)).toBeGreaterThan(events.indexOf(`reconcile:${stage}`));
    expect(executed.filter((value) => value === stage)).toHaveLength(1);
    expect(snapshot.items.find((item) => item.ordinal === 2)).toMatchObject({ ordinal: 2, steam_app_id: "2", current_state: "succeeded", current_stage: "evaluate" });
  });

  it("loads the exact durable run scope by run id and never accepts a manifest", async () => {
    const { repository, calls } = fixture([item(1)]);
    await runPipeline({ runId: "run", repository, composition, write: true });
    expect(calls[0]).toBe("run:start");
  });

  it("admits retryable_failed items for another attempt", async () => {
    const { repository } = fixture([retryableItem(1)]);
    const seen: string[] = [];
    await runPipeline({ runId: "run", repository, composition: {
      async runStage(input) { seen.push(input.steamAppId); return { status: "succeeded", gameId: 1, summary: "ok" }; },
    }, write: true });
    expect(seen).toEqual(["1"]);
  });

  it("fails closed on an exhausted retryable item without admitting or starting it", async () => {
    const { repository, calls } = fixture([exhaustedRetryableItem(1)]);
    const runStage = async () => { throw new Error("must not execute"); };

    await expect(runPipeline({ runId: "run", repository, composition: { runStage }, write: true }))
      .resolves.toMatchObject({ status: "failed" });
    expect(calls).toEqual(["run:start", "run:fatal"]);
  });

  it("reconciles an exhausted run-level retry before deciding whether to resume", async () => {
    const { repository, calls } = fixture([]);
    let snapshot = await repository.load("run");
    snapshot = { ...snapshot, run: { ...snapshot.run, status: "paused", current_stage: "preview",
      run_stage_states_json: JSON.stringify({ export: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" }, preview: { state: "retryable_failed", attemptCount: 3, reasonCode: "database_busy", retryClass: "retryable" }, "publish-ready": { state: "pending", attemptCount: 0, reasonCode: null, retryClass: "none" } }) } };
    repository.load = async () => snapshot;
    await expect(runPipeline({ runId: "run", repository, composition, write: true, mode: "resume" }))
      .resolves.toMatchObject({ status: "paused" });
    expect(calls).not.toContain("run:fatal");
  });

  it("admits items in ordinal order with at most four game workers", async () => {
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const { repository } = fixture(Array.from({ length: 8 }, (_, i) => item(i + 1)));
    const composed: PipelineRunnerComposition = { async runStage(input) {
      active++; peak = Math.max(peak, active); order.push(input.steamAppId);
      await new Promise((resolve) => setTimeout(resolve, 1)); active--;
      return { status: "succeeded", gameId: 1, summary: "ok" };
    } };
    await runPipeline({ runId: "run", repository, composition: composed, write: true });
    expect(peak).toBeLessThanOrEqual(4);
    expect(order.slice(0, 4)).toEqual(["1", "2", "3", "4"]);
  });

  it("continues after an item failure but stops admission on a run-fatal failure", async () => {
    const { repository } = fixture([item(1), item(2), item(3)]);
    const seen: string[] = [];
    const composed: PipelineRunnerComposition = { async runStage(input) {
      seen.push(input.steamAppId);
      if (input.steamAppId === "1") throw { code: "steam_invalid_app" };
      if (input.steamAppId === "2") throw { code: "composition_failure" };
      return { status: "succeeded", gameId: 1, summary: "ok" };
    } };
    await expect(runPipeline({ runId: "run", repository, composition: composed, write: true })).resolves.toMatchObject({ status: "failed" });
    expect(seen).toContain("1");
    expect(seen).toContain("2");
    expect(seen.length).toBeLessThanOrEqual(3);
  });

  it("executes a stale run-level stage through the run ledger", async () => {
    const { repository, calls } = fixture([]);
    let snapshot = await repository.load("run");
    snapshot = { ...snapshot, run: { ...snapshot.run, status: "running", current_stage: "preview",
      run_stage_states_json: JSON.stringify({ export: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" }, preview: { state: "running", attemptCount: 1, reasonCode: null, retryClass: "none" }, "publish-ready": { state: "pending", attemptCount: 0, reasonCode: null, retryClass: "none" } }) } };
    repository.load = async () => snapshot;
    repository.transitionRun = async (expected, event) => {
      calls.push(`run:${event.type}`);
      if (event.type === "start_stage") return { ...expected, status: "running", current_stage: "preview" };
      if (event.type === "succeed") return { ...expected, status: "ready", current_stage: "publish-ready" };
      return expected;
    };
    const seen: string[] = [];
    await runPipeline({ runId: "run", repository, composition: {
      ...composition,
      async runRunStage(input) { seen.push(input.stage); return { artifactSha256: "a".repeat(64) }; },
    }, write: true, mode: "resume" });
    expect(seen).toEqual(["preview"]);
    expect(calls).toContain("run:start_stage");
    expect(calls).toContain("run:succeed");
  });

  it("does not start a run-level stage twice after resume already admitted it", async () => {
    const { repository, calls } = fixture([]);
    let snapshot = await repository.load("run");
    snapshot = { ...snapshot, run: { ...snapshot.run, status: "paused", current_stage: "preview",
      run_stage_states_json: JSON.stringify({ export: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" }, preview: { state: "retryable_failed", attemptCount: 1, reasonCode: "interrupted", retryClass: "retryable" }, "publish-ready": { state: "pending", attemptCount: 0, reasonCode: null, retryClass: "none" } }) } };
    repository.load = async () => snapshot;
    repository.transitionRun = async (expected, event) => {
      calls.push(`run:${event.type}`);
      if (event.type === "resume") return { ...expected, status: "running", run_stage_states_json: JSON.stringify({ export: { state: "succeeded" }, preview: { state: "running" }, "publish-ready": { state: "pending" } }) };
      if (event.type === "succeed") return { ...expected, status: "ready", current_stage: "publish-ready" };
      return expected;
    };
    await runPipeline({ runId: "run", repository, composition: {
      ...composition,
      async reconcileRunStage() { return { outcome: "missing" }; },
      async runRunStage() { return { artifactSha256: "a".repeat(64) }; },
    }, write: true, mode: "resume" });
    expect(calls).toEqual(["run:resume", "run:succeed"]);
  });
});
