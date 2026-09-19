import { ITEM_STAGES, type ItemStage } from "./state";
import { runPipeline, type PipelineRunnerRepository, type RunPipelineInput } from "./runner";
import type { ItemEvent } from "./transitions";
import type { ItemRow, RunSnapshot } from "./run-repository";

export type PipelineRecoveryRepository = PipelineRunnerRepository & {
  recoverItem?: (expected: ItemRow, stage: ItemStage, now: number) => Promise<{ item: ItemRow; action: "persist" }>;
  reconcileItem?: (expected: ItemRow, stage: ItemStage, result: "consistent" | "missing" | "conflict", now: number) => Promise<{ item: ItemRow; action: "skip_execution" | "persist" }>;
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
  return runPipeline({ ...input, mode: "resume" });
}

export async function retryPipeline(input: RecoveryInput) {
  const snapshot = await input.repository.load(input.runId);
  if (!input.write) return { status: snapshot.run.status, run: snapshot.run, items: snapshot.items };
  return runPipeline({ ...input, mode: "retry" });
}
