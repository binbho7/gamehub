import { classifyRetry, MAX_ATTEMPTS, type RetryClass } from "./retry";
import { ITEM_STAGES, type ItemStage, type RunStage } from "./state";
import type { ItemEvent } from "./transitions";
import type { ItemRow, RunRow, RunSnapshot } from "./run-repository";

export type PipelineRunnerRepository = {
  load(runId: string): Promise<RunSnapshot>;
  transitionRun(expected: RunRow, event: Exclude<import("./transitions").RunEvent, { type: "admit_export" }>, now: number): Promise<RunRow>;
  transitionItem(expected: ItemRow, stage: ItemStage, event: ItemEvent, now: number): Promise<{ item: ItemRow; action: "execute" | "persist" | "skip_execution" }>;
  requeueItem?: (expected: ItemRow, stage: ItemStage, now: number) => Promise<{ item: ItemRow; action: "execute" | "persist" | "skip_execution" }>;
  reconcileUncertain?: (expected: ItemRow, stage: ItemStage, now: number) => Promise<{ item: ItemRow; action: "execute" | "persist" | "skip_execution" }>;
};

export type PipelineRunnerComposition = {
  runStage(input: { steamAppId: string; stage: ItemStage; gameId: number | null; dryRun: boolean }): Promise<{ status: "succeeded"; gameId: number | null; summary: string }>;
  reconcileStage?: (input: { steamAppId: string; stage: ItemStage; gameId: number | null }) => Promise<"consistent" | "missing" | "conflict">;
  runRunStage?: (input: { stage: RunStage; artifactSha256: string | null }) => Promise<{ artifactSha256: string }>;
  reconcileRunStage?: (input: { stage: RunStage; artifactSha256: string | null }) => Promise<{ outcome: "consistent"; artifactSha256: string } | { outcome: "missing" | "conflict" }>;
};

export type RunPipelineInput = {
  runId: string;
  repository: PipelineRunnerRepository;
  composition: PipelineRunnerComposition;
  write: boolean;
  now?: () => number;
  mode?: "run" | "resume" | "retry";
};

const WORKERS = 4;
const PROVIDER_CAPS: Partial<Record<ItemStage, number>> = { import: 4, enrich: 2, verify: 2, images: 2 };

function reason(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
  return "composition_failure";
}

function semaphore(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try { return await operation(); } finally { active--; queue.shift()?.(); }
  };
}

export async function runPipeline(input: RunPipelineInput): Promise<{ status: RunRow["status"]; run: RunRow; items: ItemRow[] }> {
  const now = input.now ?? (() => Date.now());
  const snapshot = await input.repository.load(input.runId);
  if (!input.write) return { status: snapshot.run.status, run: snapshot.run, items: snapshot.items };

  let run = snapshot.run;
  if (run.current_stage !== null) {
    const runStages = JSON.parse(run.run_stage_states_json) as Record<string, { state: string; attemptCount?: number }>;
    if (runStages[run.current_stage]?.state === "retryable_failed"
      && runStages[run.current_stage]?.attemptCount !== undefined
      && runStages[run.current_stage]!.attemptCount! >= MAX_ATTEMPTS) {
      run = await input.repository.transitionRun(run, { type: "fatal" }, now());
      return { status: run.status, run, items: snapshot.items };
    }
  }
  if (run.status === "created") run = await input.repository.transitionRun(run, { type: "start" }, now());
  else if (input.mode === "resume" || input.mode === "retry") {
    const states = run.current_stage === null ? null : JSON.parse(run.run_stage_states_json) as Record<string, { state: string }>;
    const uncertain = run.status === "paused" && run.current_stage !== null && states?.[run.current_stage]?.state === "retryable_failed";
    if (uncertain && !input.composition.reconcileRunStage) return { status: run.status, run, items: snapshot.items };
    if (uncertain) {
      const reconciliation = await input.composition.reconcileRunStage!({ stage: run.current_stage!, artifactSha256: run.artifact_sha256 });
      if (reconciliation.outcome !== "consistent") {
        run = await input.repository.transitionRun(run, { type: "fail", retryClass: reconciliation.outcome === "conflict" ? "permanent" : "retryable", reasonCode: reconciliation.outcome === "conflict" ? "reconciliation_conflict" : "completion_missing" }, now());
        return { status: run.status, run, items: snapshot.items };
      }
      run = await input.repository.transitionRun(run, { type: "resume" }, now());
      run = await input.repository.transitionRun(run, { type: "succeed", artifactSha256: reconciliation.artifactSha256 }, now());
      return { status: run.status, run, items: snapshot.items };
    }
    if (run.status === "paused") run = await input.repository.transitionRun(run, { type: "resume" }, now());
    else if (run.status !== "running") return { status: run.status, run, items: [] };
  } else if (run.status !== "running") return { status: run.status, run, items: [] };
  const items = [...snapshot.items].sort((left, right) => left.ordinal - right.ordinal);
  if (run.current_stage !== null) {
    if (!input.composition.runRunStage) throw new Error("run-stage executor unavailable");
    if (run.status !== "running") return { status: run.status, run, items: [] };
    const stage = run.current_stage;
    const stageState = JSON.parse(run.run_stage_states_json) as Record<string, { state: string }>;
    if (stageState[stage]?.state === "retryable_failed") {
      if (!input.composition.reconcileRunStage) return { status: run.status, run, items };
      const reconciliation = await input.composition.reconcileRunStage({ stage, artifactSha256: run.artifact_sha256 });
      if (reconciliation.outcome !== "consistent") {
        run = await input.repository.transitionRun(run, { type: "fail", retryClass: reconciliation.outcome === "conflict" ? "permanent" : "retryable", reasonCode: reconciliation.outcome === "conflict" ? "reconciliation_conflict" : "completion_missing" }, now());
        return { status: run.status, run, items };
      }
      run = await input.repository.transitionRun(run, { type: "start_stage" }, now());
      run = await input.repository.transitionRun(run, { type: "succeed", artifactSha256: reconciliation.artifactSha256 }, now());
      return { status: run.status, run, items };
    }
    run = await input.repository.transitionRun(run, { type: "start_stage" }, now());
    try {
      const result = await input.composition.runRunStage({ stage, artifactSha256: run.artifact_sha256 });
      run = await input.repository.transitionRun(run, { type: "succeed", artifactSha256: result.artifactSha256 }, now());
    } catch (error) {
      run = await input.repository.transitionRun(run, { type: "fail", retryClass: "retryable", reasonCode: reason(error) }, now());
    }
    return { status: run.status, run, items: [] };
  }
  if (items.some((item) => item.current_state === "retryable_failed" && item.attempt_count >= MAX_ATTEMPTS)) {
    run = await input.repository.transitionRun(run, { type: "fatal" }, now());
    return { status: run.status, run, items: [] };
  }
  const providerQueues = new Map<ItemStage, ReturnType<typeof semaphore>>(
    Object.entries(PROVIDER_CAPS).map(([stage, cap]) => [stage as ItemStage, semaphore(cap!)]),
  );
  const writeQueue = semaphore(1);
  let fatal = false;
  let next = 0;
  const completed: ItemRow[] = [];

  const processItem = async (initial: ItemRow) => {
    let current = initial;
    if (input.mode === "resume" && input.composition.reconcileStage) {
      for (const completedStage of ITEM_STAGES.slice(0, ITEM_STAGES.indexOf(current.current_stage))) {
        const completed = current.stage_states_json;
        const parsed = JSON.parse(completed) as Record<string, { state: string }>;
        if (parsed[completedStage]?.state !== "succeeded") continue;
        const result = await input.composition.reconcileStage({ steamAppId: current.steam_app_id, stage: completedStage, gameId: current.game_id });
        const reconciled = await writeQueue(() => input.repository.transitionItem(current, completedStage, { type: "reconcile", result }, now()));
        current = reconciled.item;
        if (result !== "consistent") return;
      }
    }
    for (const stage of ITEM_STAGES) {
      if (stage === "discover" || current.current_stage !== stage
        || (input.mode === "retry" && !["pending", "retryable_failed"].includes(current.current_state))
        || (current.current_state !== "pending" && current.current_state !== "retryable_failed")) continue;
      try {
        const started = await writeQueue(() => input.repository.transitionItem(current, stage, { type: "start" }, now()));
        current = started.item;
        const runWithCap: (operation: () => Promise<{ status: "succeeded"; gameId: number | null; summary: string }>) => Promise<{ status: "succeeded"; gameId: number | null; summary: string }> =
          providerQueues.get(stage) ?? ((operation) => operation());
        const result = await runWithCap(() =>
          input.composition.runStage({ steamAppId: current.steam_app_id, stage, gameId: current.game_id, dryRun: false }));
        const succeeded = await writeQueue(() => input.repository.transitionItem(current, stage,
          { type: "succeed", ...(stage === "import" ? { gameId: result.gameId! } : {}) }, now()));
        current = succeeded.item;
      } catch (error) {
        const code = reason(error);
        const classification = classifyRetry(code) as RetryClass;
        await writeQueue(() => input.repository.transitionItem(current, stage,
          { type: "fail", retryClass: classification === "run_fatal" ? "permanent" : classification, reasonCode: code }, now()));
        if (classification === "run_fatal" || (classification === "retryable" && current.attempt_count >= MAX_ATTEMPTS)) fatal = true;
        return;
      }
    }
    completed.push(current);
  };

  const worker = async () => {
    while (!fatal) {
      const index = next++;
      if (index >= items.length) return;
      await processItem(items[index]);
    }
  };
  // Fixed worker count is intentional: candidates are claimed one at a time and never spread into an unbounded promise array.
  const workers: Array<Promise<void>> = [];
  for (let index = 0; index < Math.min(WORKERS, items.length); index++) workers.push(worker());
  for (const workerPromise of workers) await workerPromise;
  if (fatal) run = await input.repository.transitionRun(run, { type: "fatal" }, now());
  return { status: run.status, run, items: completed };
}
