import { ITEM_STAGES, RUN_STAGES, pending, type ItemStage, type ItemStages, type RunState } from "./state";

export type ItemEvent =
  | { type: "start" | "refresh" }
  | { type: "succeed"; gameId?: number }
  // The caller must first obtain safe recovery admission; process authority belongs to Task 8.
  | { type: "recover_stale" }
  | { type: "fail"; retryClass: "retryable" | "permanent" | "blocked"; reasonCode: string }
  | { type: "reconcile"; result: "consistent" | "missing" | "conflict" };

function requireTransition(condition: boolean): asserts condition {
  if (!condition) throw new Error("invalid pipeline transition");
}
export function transitionItem(source: ItemStages, stage: ItemStage, event: ItemEvent) {
  const stages = structuredClone(source);
  const index = ITEM_STAGES.indexOf(stage);
  requireTransition(index >= 0);
  const current = stages[stage];
  let currentStage = stage;
  let action: "execute" | "persist" | "skip_execution" = "persist";
  const fail = (retryClass: "retryable" | "permanent" | "blocked", reasonCode: string) => {
    requireTransition(/^[a-z][a-z0-9_]*$/.test(reasonCode));
    current.state = { retryable: "retryable_failed", permanent: "permanently_failed", blocked: "blocked" }[retryClass] as typeof current.state;
    current.reasonCode = reasonCode;
    current.retryClass = retryClass;
    if (retryClass !== "retryable") {
      for (const later of ITEM_STAGES.slice(index + 1)) {
        stages[later] = { ...stages[later], state: "skipped", reasonCode, retryClass };
      }
    }
  };
  switch (event.type) {
    case "start":
      requireTransition((current.state === "pending" || current.state === "retryable_failed") && current.attemptCount < 3);
      requireTransition(ITEM_STAGES.slice(0, index).every((earlier) => stages[earlier].state === "succeeded"));
      Object.assign(current, { state: "running", attemptCount: current.attemptCount + 1, reasonCode: null, retryClass: "none" });
      action = "execute";
      break;
    case "succeed":
      requireTransition(current.state === "running");
      requireTransition(ITEM_STAGES.slice(0, index).every((earlier) => stages[earlier].state === "succeeded"));
      if (event.gameId !== undefined) requireTransition(stage === "import" && Number.isSafeInteger(event.gameId) && event.gameId > 0);
      Object.assign(current, { state: "succeeded", reasonCode: null, retryClass: "none" });
      currentStage = ITEM_STAGES[index + 1] ?? stage;
      break;
    case "fail":
      requireTransition(current.state === "running");
      fail(event.retryClass, event.reasonCode);
      break;
    case "recover_stale":
      requireTransition(current.state === "running");
      fail("retryable", "stale_attempt");
      break;
    case "reconcile":
      requireTransition(current.state === "succeeded");
      if (event.result === "consistent") action = "skip_execution";
      else fail(event.result === "missing" ? "retryable" : "blocked", event.result === "missing" ? "missing_effects" : "invariant_conflict");
      break;
    case "refresh":
      requireTransition(["succeeded", "retryable_failed", "permanently_failed", "blocked", "skipped"].includes(current.state));
      for (const affected of ITEM_STAGES.slice(index)) stages[affected] = pending();
      break;
    default: throw new Error("invalid pipeline event");
  }
  return { stages, currentStage, action };
}

export type RunEvent =
  | { type: "start" | "pause" | "resume" | "fatal" | "start_stage" }
  | { type: "admit_export" }
  | { type: "succeed"; artifactSha256: string }
  | { type: "fail"; retryClass: "retryable" | "permanent" | "run_fatal"; reasonCode: string };

export function transitionRun(source: RunState, event: RunEvent): RunState {
  const run = structuredClone(source);
  const stage = run.currentStage;
  const current = stage === null ? null : run.stages[stage];
  const startStage = () => {
    requireTransition(stage !== null && current !== null);
    requireTransition((current.state === "pending" || current.state === "retryable_failed") && current.attemptCount < 3);
    requireTransition(RUN_STAGES.slice(0, RUN_STAGES.indexOf(stage)).every((earlier) => run.stages[earlier].state === "succeeded"));
    Object.assign(current, { state: "running", attemptCount: current.attemptCount + 1, reasonCode: null, retryClass: "none" });
  };
  switch (event.type) {
    case "start":
      requireTransition(run.status === "created");
      run.status = "running";
      break;
    case "resume":
      requireTransition(run.status === "paused");
      if (current) startStage();
      run.status = "running";
      break;
    case "pause":
      requireTransition(run.status === "running");
      if (current?.state === "running") Object.assign(current, { state: "retryable_failed", retryClass: "retryable", reasonCode: "interrupted" });
      run.status = "paused";
      break;
    case "fatal":
      requireTransition(run.status === "running");
      if (current?.state === "running") Object.assign(current, { state: "permanently_failed", retryClass: "run_fatal", reasonCode: "run_fatal" });
      run.status = "failed";
      break;
    case "admit_export":
      requireTransition(run.status === "running" && stage === null && run.artifactSha256 === null);
      requireTransition(RUN_STAGES.every((key) => run.stages[key].state === "pending"));
      run.currentStage = "export";
      break;
    case "start_stage":
      requireTransition(run.status === "running");
      startStage();
      break;
    case "succeed": {
      requireTransition(run.status === "running" && stage !== null && current?.state === "running");
      requireTransition(/^[0-9a-f]{64}$/.test(event.artifactSha256));
      requireTransition(stage === "export" ? run.artifactSha256 === null : run.artifactSha256 === event.artifactSha256);
      Object.assign(current, { state: "succeeded", reasonCode: null, retryClass: "none" });
      run.artifactSha256 = event.artifactSha256;
      if (stage === "publish-ready") run.status = "ready";
      else run.currentStage = RUN_STAGES[RUN_STAGES.indexOf(stage) + 1];
      break;
    }
    case "fail":
      requireTransition(run.status === "running" && current?.state === "running");
      requireTransition(/^[a-z][a-z0-9_]*$/.test(event.reasonCode));
      Object.assign(current, { state: event.retryClass === "retryable" ? "retryable_failed" : "permanently_failed",
        retryClass: event.retryClass, reasonCode: event.reasonCode });
      run.status = event.retryClass === "retryable" ? "paused" : "failed";
      break;
    default: throw new Error("invalid pipeline event");
  }
  return run;
}
