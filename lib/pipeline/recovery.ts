import { ITEM_STAGES, type ItemStage } from "./state";
import { runPipeline, type PipelineRunnerRepository, type RunPipelineInput } from "./runner";
import type { ItemEvent } from "./transitions";
import type { ItemRow, RunRow, RunSnapshot } from "./run-repository";

export type PipelineRecoveryRepository = PipelineRunnerRepository & {
  recoverItem?: (expected: ItemRow, stage: ItemStage, now: number) => Promise<{ item: ItemRow; action: "persist" }>;
  reconcileItem?: (expected: ItemRow, stage: ItemStage, result: "consistent" | "missing" | "conflict", now: number) => Promise<{ item: ItemRow; action: "skip_execution" | "persist" }>;
  recoverRun?: (expected: RunRow, now: number) => Promise<RunRow>;
};

function itemTransition(repository: PipelineRecoveryRepository, expected: ItemRow, stage: ItemStage, event: ItemEvent, now: number) {
  return repository.transitionItem(expected, stage, event, now);
}

export function recoverInterruptedItem(repository: PipelineRecoveryRepository, expected: ItemRow, stage: ItemStage, now: number) {
  return repository.recoverItem?.(expected, stage, now) ?? itemTransition(repository, expected, stage, { type: "recover_stale" }, now);
}

export function reconcileItem(repository: PipelineRecoveryRepository, expected: ItemRow, stage: ItemStage,
  result: "consistent" | "missing" | "conflict", now: number) {
  return repository.reconcileItem?.(expected, stage, result, now) ?? itemTransition(repository, expected, stage, { type: "reconcile", result }, now);
}

export type RecoveryInput = Omit<RunPipelineInput, "repository"> & { repository: PipelineRecoveryRepository };

async function recoverRunningItems(repository: PipelineRecoveryRepository, snapshot: RunSnapshot, now: number) {
  let current = snapshot;
  for (const original of snapshot.items) {
    if (original.current_state !== "running") continue;
    const stage = original.current_stage;
    if (!ITEM_STAGES.includes(stage)) continue;
    const recovered = await recoverInterruptedItem(repository, original, stage, now);
    current = { ...current, items: current.items.map((item) => item.ordinal === recovered.item.ordinal ? recovered.item : item) };
  }
  return current;
}

export async function resumePipeline(input: RecoveryInput) {
  const snapshot = await input.repository.load(input.runId);
  if (!input.write) return { status: snapshot.run.status, run: snapshot.run, items: snapshot.items };
  await recoverRunningItems(input.repository, snapshot, (input.now ?? (() => Date.now()))());
  const runStageState = snapshot.run.current_stage === null ? null
    : (JSON.parse(snapshot.run.run_stage_states_json) as Record<string, { state: string }>)[snapshot.run.current_stage]?.state;
  let runStageAlreadyStarted = false;
  if (snapshot.run.status === "running" && snapshot.run.current_stage !== null && runStageState === "running") {
    const recovered = input.repository.recoverRun
      ? await input.repository.recoverRun(snapshot.run, (input.now ?? (() => Date.now()))())
      : undefined;
    if (recovered) {
      if (recovered.status === "paused") {
        await input.repository.transitionRun(recovered, { type: "resume" }, (input.now ?? (() => Date.now()))());
        runStageAlreadyStarted = true;
      } else if (recovered.status === "running") {
        // A repository may atomically recover and re-admit the stage. Do not
        // issue `resume`, which is valid only for paused runs.
        runStageAlreadyStarted = true;
      }
    }
  }
  return runPipeline({ ...input, mode: "resume", runStageAlreadyStarted });
}

export async function retryPipeline(input: RecoveryInput) {
  const snapshot = await input.repository.load(input.runId);
  if (!input.write) return { status: snapshot.run.status, run: snapshot.run, items: snapshot.items };
  let reconciled = 0;
  for (const expected of snapshot.items.filter((item) => item.current_state === "retryable_failed")) {
    const stage = expected.current_stage;
    if (input.repository.requeueItem) await input.repository.requeueItem(expected, stage, (input.now ?? (() => Date.now()))());
    else {
      const result = input.repository.reconcileUncertain
        ? await input.repository.reconcileUncertain(expected, stage, (input.now ?? (() => Date.now()))())
        : undefined;
      if (result?.action === "skip_execution") reconciled++;
      else await input.repository.transitionItem(expected, stage, { type: "refresh" }, (input.now ?? (() => Date.now()))());
    }
  }
  const retryableCount = snapshot.items.filter((item) => item.current_state === "retryable_failed").length;
  if (retryableCount > 0 && reconciled === retryableCount) {
    const refreshed = await input.repository.load(input.runId);
    return { status: refreshed.run.status, run: refreshed.run, items: refreshed.items };
  }
  return runPipeline({ ...input, mode: "retry" });
}
