import { describe, expect, it } from "vitest";
import { initialItemStages, initialRunStages, parseItemStages, parseRunStages } from "./state";
import { transitionItem, transitionRun } from "./transitions";

const outcome = (state: string, attemptCount = 0, reasonCode: string | null = null, retryClass = "none") =>
  ({ state, attemptCount, reasonCode, retryClass });

describe("item transition contract", () => {
  it("admits discover and retains exactly six durable outcomes in enum order", () => {
    expect(initialItemStages()).toEqual({ discover: outcome("succeeded"), import: outcome("pending"),
      enrich: outcome("pending"), verify: outcome("pending"), images: outcome("pending"), evaluate: outcome("pending") });
    expect(() => parseItemStages('{"discover":{}}')).toThrow();
    expect(() => parseRunStages('{"export":{}}')).toThrow();
  });
  it("requires every predecessor succeeded, starts attempts and advances only after success", () => {
    const stages = initialItemStages();
    expect(() => transitionItem(stages, "enrich", { type: "start" })).toThrow();
    const started = transitionItem(stages, "import", { type: "start" });
    expect(started.stages.import).toEqual(outcome("running", 1));
    expect(stages.import.state).toBe("pending");
    const done = transitionItem(started.stages, "import", { type: "succeed" });
    expect(done.stages.import).toEqual(outcome("succeeded", 1));
    expect(done.currentStage).toBe("enrich");
    expect(transitionItem(done.stages, "enrich", { type: "start" }).stages.enrich.state).toBe("running");
  });
  it.each(["retryable", "permanent", "blocked"] as const)("persists %s failure and only skips dependents for prerequisite terminal failure", (retryClass) => {
    const started = transitionItem(initialItemStages(), "import", { type: "start" });
    const failed = transitionItem(started.stages, "import", { type: "fail", retryClass, reasonCode: "test_reason" });
    expect(failed.stages.import).toEqual(outcome(
      retryClass === "retryable" ? "retryable_failed" : retryClass === "permanent" ? "permanently_failed" : "blocked",
      1, "test_reason", retryClass));
    for (const stage of ["enrich", "verify", "images", "evaluate"] as const) {
      expect(failed.stages[stage].state).toBe(retryClass === "retryable" ? "pending" : "skipped");
      expect(() => transitionItem(failed.stages, stage, { type: "start" })).toThrow();
    }
    if (retryClass !== "retryable") expect(() => transitionItem(failed.stages, "import", { type: "start" })).toThrow();
  });
  it("caps retry attempts at three and accepts stale recovery only as an externally admitted event", () => {
    let stages = initialItemStages();
    for (let attempt = 1; attempt <= 3; attempt++) {
      stages = transitionItem(stages, "import", { type: "start" }).stages;
      expect(stages.import.attemptCount).toBe(attempt);
      stages = transitionItem(stages, "import", { type: "recover_stale" }).stages;
      expect(stages.import.state).toBe("retryable_failed");
    }
    expect(() => transitionItem(stages, "import", { type: "start" })).toThrow();
    expect(() => transitionItem(initialItemStages(), "import", { type: "recover_stale" })).toThrow();
  });
  it("reconciliation passes without rewriting succeeded; missing effects retry and conflicts block", () => {
    const started = transitionItem(initialItemStages(), "import", { type: "start" });
    const done = transitionItem(started.stages, "import", { type: "succeed" });
    const pass = transitionItem(done.stages, "import", { type: "reconcile", result: "consistent" });
    expect(pass.action).toBe("skip_execution");
    expect(pass.stages).toEqual(done.stages);
    const missing = transitionItem(done.stages, "import", { type: "reconcile", result: "missing" });
    expect(missing.stages.import.state).toBe("retryable_failed");
    expect(() => transitionItem(missing.stages, "enrich", { type: "start" })).toThrow();
    const conflict = transitionItem(done.stages, "import", { type: "reconcile", result: "conflict" });
    expect(conflict.stages.import.state).toBe("blocked");
    expect(conflict.stages.evaluate.state).toBe("skipped");
  });
  it.each(["import", "enrich", "verify", "images"] as const)("reconciles an interrupted current %s stage before replay", (stage) => {
    let stages = initialItemStages();
    for (const predecessor of ["import", "enrich", "verify", "images"] as const) {
      if (predecessor === stage) break;
      stages = transitionItem(stages, predecessor, { type: "start" }).stages;
      stages = transitionItem(stages, predecessor, predecessor === "import" ? { type: "succeed", gameId: 701 } : { type: "succeed" }).stages;
    }
    stages = transitionItem(stages, stage, { type: "start" }).stages;
    stages = transitionItem(stages, stage, { type: "recover_stale" }).stages;

    const consistent = transitionItem(stages, stage, {
      type: "reconcile", result: "consistent", ...(stage === "import" ? { gameId: 701 } : {}),
    });
    expect(consistent.action).toBe("skip_execution");
    expect(consistent.stages[stage].state).toBe("succeeded");
    expect(consistent.currentStage).toBe(stage === "images" ? "evaluate" : ["import", "enrich", "verify", "images"][(["import", "enrich", "verify", "images"] as const).indexOf(stage) + 1]!);

    const missing = transitionItem(stages, stage, { type: "reconcile", result: "missing" });
    expect(missing.action).toBe("persist");
    expect(missing.stages[stage]).toMatchObject({ state: "retryable_failed", reasonCode: "missing_effects", retryClass: "retryable" });

    const conflict = transitionItem(stages, stage, { type: "reconcile", result: "conflict" });
    expect(conflict.action).toBe("persist");
    expect(conflict.stages[stage]).toMatchObject({ state: "blocked", reasonCode: "invariant_conflict", retryClass: "blocked" });
    expect(conflict.stages.evaluate.state).toBe("skipped");
  });
  it.each(["succeeded", "retryable_failed", "permanently_failed", "blocked", "skipped"] as const)("refreshes terminal %s and dependents only", (state) => {
    const stages = initialItemStages();
    stages.enrich = { state, attemptCount: 1, reasonCode: null, retryClass: "none" };
    const reset = transitionItem(stages, "enrich", { type: "refresh" });
    expect(reset.stages.discover).toEqual(stages.discover);
    expect(reset.stages.import).toEqual(stages.import);
    expect(reset.stages.enrich).toEqual(outcome("pending"));
    expect(reset.stages.evaluate).toEqual(outcome("pending"));
    expect(() => transitionItem(stages, "import", { type: "refresh" })).toThrow();
  });
  it("rejects completion and reconciliation from nonmatching source states", () => {
    const stages = initialItemStages();
    expect(() => transitionItem(stages, "import", { type: "succeed" })).toThrow();
    expect(() => transitionItem(stages, "import", { type: "fail", retryClass: "blocked", reasonCode: "conflict" })).toThrow();
    expect(() => transitionItem(stages, "import", { type: "reconcile", result: "consistent" })).toThrow();
  });
  it("does not complete dependent work after predecessor reconciliation found missing effects", () => {
    let stages = transitionItem(initialItemStages(), "import", { type: "start" }).stages;
    stages = transitionItem(stages, "import", { type: "succeed" }).stages;
    stages = transitionItem(stages, "enrich", { type: "start" }).stages;
    stages = transitionItem(stages, "import", { type: "reconcile", result: "missing" }).stages;
    expect(() => transitionItem(stages, "enrich", { type: "succeed" })).toThrow();
  });
  it("validates imported game identity only on import success", () => {
    const running = transitionItem(initialItemStages(), "import", { type: "start" }).stages;
    expect(() => transitionItem(running, "import", { type: "succeed", gameId: -1 })).toThrow();
    const done = transitionItem(running, "import", { type: "succeed", gameId: 701 });
    const enriched = transitionItem(done.stages, "enrich", { type: "start" });
    expect(() => transitionItem(enriched.stages, "enrich", { type: "succeed", gameId: 701 })).toThrow();
  });
});

const created = () => ({ status: "created" as const, currentStage: null, stages: initialRunStages(), artifactSha256: null });
describe("run transition contract", () => {
  it("starts, pauses, resumes and fails item work without inventing run stage success", () => {
    const running = transitionRun(created(), { type: "start" });
    expect(running.status).toBe("running");
    const paused = transitionRun(running, { type: "pause" });
    expect(paused.status).toBe("paused");
    expect(transitionRun(paused, { type: "resume" })).toEqual(running);
    expect(transitionRun(running, { type: "fatal" }).status).toBe("failed");
    expect(() => transitionRun(created(), { type: "resume" })).toThrow();
  });
  it("terminally fails an exhausted paused run-level attempt", () => {
    let run = transitionRun(transitionRun(created(), { type: "start" }), { type: "admit_export" });
    run = transitionRun(run, { type: "start_stage" });
    run = transitionRun(run, { type: "fail", retryClass: "retryable", reasonCode: "database_busy" });
    run = transitionRun(run, { type: "resume" });
    run = transitionRun(run, { type: "fail", retryClass: "retryable", reasonCode: "database_busy" });
    run = transitionRun(run, { type: "resume" });
    run = transitionRun(run, { type: "fail", retryClass: "retryable", reasonCode: "database_busy" });
    expect(run.status).toBe("paused");
    expect(() => transitionRun(run, { type: "fatal" })).not.toThrow();
    expect(transitionRun(run, { type: "fatal" }).status).toBe("failed");
  });
  it("records the export hash, checks it at each later gate, then becomes ready", () => {
    let run = transitionRun(transitionRun(created(), { type: "start" }), { type: "admit_export" });
    expect(run.currentStage).toBe("export");
    expect(run.stages).toEqual({ export: outcome("pending"), preview: outcome("pending"), "publish-ready": outcome("pending") });
    for (const stage of ["export", "preview", "publish-ready"] as const) {
      run = transitionRun(run, { type: "start_stage" });
      expect(run.stages[stage]).toEqual(outcome("running", 1));
      expect(() => transitionRun(run, { type: "succeed", artifactSha256: "INVALID" })).toThrow();
      if (stage !== "export") expect(() => transitionRun(run, { type: "succeed", artifactSha256: "b".repeat(64) })).toThrow();
      run = transitionRun(run, { type: "succeed", artifactSha256: "a".repeat(64) });
      expect(run.artifactSha256).toBe("a".repeat(64));
    }
    expect(run.status).toBe("ready");
    expect(() => transitionRun(run, { type: "admit_export" })).toThrow();
  });
  it.each(["export", "preview", "publish-ready"] as const)("pauses and resumes %s with three-attempt cap and preserves earlier outcomes/hash", (stage) => {
    let run = transitionRun(transitionRun(created(), { type: "start" }), { type: "admit_export" });
    while (run.currentStage !== stage) {
      run = transitionRun(transitionRun(run, { type: "start_stage" }), { type: "succeed", artifactSha256: "a".repeat(64) });
    }
    run = transitionRun(run, { type: "start_stage" });
    for (let attempt = 1; attempt <= 3; attempt++) {
      run = transitionRun(run, { type: "pause" });
      expect(run.status).toBe("paused");
      expect(run.currentStage).toBe(stage);
      expect(run.stages[stage].state).toBe("retryable_failed");
      expect(run.artifactSha256).toBe(stage === "export" ? null : "a".repeat(64));
      if (attempt < 3) run = transitionRun(run, { type: "resume" });
    }
    expect(() => transitionRun(run, { type: "resume" })).toThrow();
  });
  it.each(["retryable", "permanent", "run_fatal"] as const)("persists %s run-stage failure without advancing", (retryClass) => {
    const run = transitionRun(transitionRun(transitionRun(created(), { type: "start" }), { type: "admit_export" }), { type: "start_stage" });
    const failed = transitionRun(run, { type: "fail", retryClass, reasonCode: "test_reason" });
    expect(failed.status).toBe(retryClass === "retryable" ? "paused" : "failed");
    expect(failed.stages.export.state).toBe(retryClass === "retryable" ? "retryable_failed" : "permanently_failed");
    expect(failed.stages.preview.state).toBe("pending");
    expect(failed.artifactSha256).toBeNull();
  });
});
