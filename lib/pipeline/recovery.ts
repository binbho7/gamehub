import { ITEM_STAGES, type ItemStage } from "./state";
import { runPipeline, type PipelineRunnerRepository, type RunPipelineInput } from "./runner";
import type { ItemEvent } from "./transitions";
import type { ItemRow, RetryItemPlan, RunRow, RunSnapshot } from "./run-repository";

export type PipelineRecoveryRepository = PipelineRunnerRepository & {
  recoverItem?: (expected: ItemRow, stage: ItemStage, now: number) => Promise<{ item: ItemRow; action: "persist" }>;
  reconcileItem?: (expected: ItemRow, stage: ItemStage, result: "consistent" | "missing" | "conflict", now: number) => Promise<{ item: ItemRow; action: "skip_execution" | "persist" | "execute" }>;
  commitRetryPlan?: (plans: RetryItemPlan[], now: number) => Promise<ItemRow[]>;
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

async function recoverRunningItems(repository: PipelineRecoveryRepository, snapshot: RunSnapshot, now: number, reconcileStage?: RecoveryInput["composition"]["reconcileStage"]) {
  let current = snapshot;
  for (const original of snapshot.items) {
    if (original.current_state !== "running") continue;
    const stage = original.current_stage;
    if (!ITEM_STAGES.includes(stage)) continue;
    // Provider-backed stages have uncertain external side effects. Without a
    // reconciliation capability, leave the running row untouched rather than
    // converting it into a replayable stale attempt.
    if (["import", "enrich", "verify", "images"].includes(stage) && !reconcileStage) continue;
    const recovered = await recoverInterruptedItem(repository, original, stage, now);
    current = { ...current, items: current.items.map((item) => item.ordinal === recovered.item.ordinal ? recovered.item : item) };
  }
  return current;
}

export async function resumePipeline(input: RecoveryInput) {
  const snapshot = await input.repository.load(input.runId);
  if (!input.write) return { status: snapshot.run.status, run: snapshot.run, items: snapshot.items };
  await recoverRunningItems(input.repository, snapshot, (input.now ?? (() => Date.now()))(), input.composition.reconcileStage);
  const runStageState = snapshot.run.current_stage === null ? null
    : (JSON.parse(snapshot.run.run_stage_states_json) as Record<string, { state: string }>)[snapshot.run.current_stage]?.state;
  let runStageAlreadyStarted = false;
  if (snapshot.run.status === "running" && snapshot.run.current_stage !== null && runStageState === "running") {
    const recovered = input.repository.recoverRun
      ? await input.repository.recoverRun(snapshot.run, (input.now ?? (() => Date.now()))())
      : undefined;
    if (recovered) {
      if (recovered.status === "paused") {
        // Leave the recovered stage paused. The runner must reconcile its
        // uncertain completion before any resume/start transition.
        runStageAlreadyStarted = false;
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
  if (snapshot.run.current_stage !== null) return runPipeline({ ...input, mode: "retry" });
  const retryable = snapshot.items.filter((item) => item.current_state === "retryable_failed");
  if (retryable.length === 0) return { status: snapshot.run.status, run: snapshot.run, items: snapshot.items };
  const staleItems = retryable.filter((item) => item.reason_code === "stale_attempt");
  if (staleItems.length > 0 && !input.composition.reconcileStage) {
    return { status: snapshot.run.status, run: snapshot.run, items: snapshot.items };
  }

  const observations: Array<{ expected: ItemRow; outcome: "consistent" | "missing" | "conflict"; gameId?: number }> = [];
  for (const expected of staleItems) {
    const result = await input.composition.reconcileStage!({ steamAppId: expected.steam_app_id, stage: expected.current_stage, gameId: expected.game_id });
    const outcome = typeof result === "string" ? result : result.outcome;
    const gameId = typeof result === "string" ? undefined : result.gameId;
    observations.push({ expected, outcome, ...(gameId === undefined ? {} : { gameId }) });
  }
  const plans: RetryItemPlan[] = [
    ...observations.map(({ expected, outcome, gameId }) => ({ expected, stage: expected.current_stage, events: [
      { type: "reconcile" as const, result: outcome, ...(gameId === undefined ? {} : { gameId }) },
      ...(outcome === "missing" ? [{ type: "refresh" as const }] : []),
    ] })),
    ...retryable.filter((item) => item.reason_code !== "stale_attempt")
      .map((expected) => ({ expected, stage: expected.current_stage, events: [{ type: "refresh" as const }] })),
  ];
  if (!input.repository.commitRetryPlan) throw new Error("atomic retry preparation unavailable");
  const committed = await input.repository.commitRetryPlan(plans, (input.now ?? (() => Date.now()))());
  const candidateOrdinals = plans
    .filter(({ events }) => events.some((event) => event.type === "refresh"))
    .map(({ expected }) => expected.ordinal);
  const committedByOrdinal = new Map(committed.map((item) => [item.ordinal, item]));
  if (candidateOrdinals.some((ordinal) => committedByOrdinal.get(ordinal)?.current_state !== "pending")) {
    throw new Error("committed retry plan did not produce expected pending items");
  }
  if (candidateOrdinals.length === 0) {
    const refreshed = await input.repository.load(input.runId);
    return { status: refreshed.run.status, run: refreshed.run, items: refreshed.items };
  }
  return runPipeline({ ...input, mode: "retry", retryExecutionOrdinals: candidateOrdinals });
}
