import { classifyRetry, classifyStageFailure, MAX_ATTEMPTS, retryDelayMs, type RetryClass } from "./retry";
import { ITEM_STAGES, type ItemStage, type RunStage } from "./state";
import type { ItemEvent } from "./transitions";
import type { ItemRow, RunRow, RunSnapshot } from "./run-repository";
import { STAGE_FAILURE_CODES } from "../sync/stages";

export type PipelineRunnerRepository = {
  load(runId: string): Promise<RunSnapshot>;
  transitionRun(expected: RunRow, event: Exclude<import("./transitions").RunEvent, { type: "admit_export" }>, now: number): Promise<RunRow>;
  transitionItem(expected: ItemRow, stage: ItemStage, event: ItemEvent, now: number): Promise<{ item: ItemRow; action: "execute" | "persist" | "skip_execution" }>;
  requeueItem?: (expected: ItemRow, stage: ItemStage, now: number) => Promise<{ item: ItemRow; action: "execute" | "persist" | "skip_execution" }>;
  reconcileUncertain?: (expected: ItemRow, stage: ItemStage, now: number) => Promise<{ item: ItemRow; action: "execute" | "persist" | "skip_execution" }>;
};

export type PipelineRunnerComposition = {
  runStage(input: { steamAppId: string; stage: ItemStage; gameId: number | null; dryRun: boolean; snapshotDate?: string }): Promise<{ status: "succeeded"; gameId: number | null; summary: string }>;
  reconcileStage?: (input: { steamAppId: string; stage: ItemStage; gameId: number | null }) => Promise<StageReconciliation>;
  runRunStage?: (input: { runId: string; stage: RunStage; artifactSha256: string | null }) => Promise<{ artifactSha256: string }>;
  reconcileRunStage?: (input: { runId: string; stage: RunStage; artifactSha256: string | null }) => Promise<{ outcome: "consistent"; artifactSha256: string } | { outcome: "missing" | "conflict" }>;
};

export type StageReconciliation = "consistent" | "missing" | "conflict" | { outcome: "consistent"; gameId?: number };

export type RunPipelineInput = {
  runId: string;
  repository: PipelineRunnerRepository;
  composition: PipelineRunnerComposition;
  write: boolean;
  now?: () => number;
  mode?: "run" | "resume" | "retry";
  sleep?: (milliseconds: number) => Promise<void>;
  requestedRunStage?: RunStage;
  /** Internal hand-off: resume already persisted the run-stage as running. */
  runStageAlreadyStarted?: boolean;
};

const WORKERS = 4;
const PROVIDER_CAPS: Partial<Record<ItemStage, number>> = { import: 4, enrich: 2, verify: 2, images: 2 };

function reason(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : null;
  if (code && (STAGE_FAILURE_CODES as readonly string[]).includes(code)) return code;
  if (code && ["steam_429", "steam_5xx", "steam_timeout", "steam_network", "steam_invalid_app", "steam_malformed_response", "steam_identity_conflict", "igdb_timeout", "igdb_429", "igdb_5xx", "igdb_network", "igdb_no_match", "igdb_malformed_response", "igdb_ambiguous", "igdb_invalid_credentials", "igdb_taxonomy_company_conflict", "link_dns_transient", "link_timeout", "link_429", "link_5xx", "link_malformed_url", "link_malformed_response", "link_unsafe_destination", "link_protocol_downgrade", "link_policy_rejected", "image_source_timeout", "image_download_failed", "image_network_transient", "image_service_unavailable", "image_unsupported_format", "image_malformed_result", "image_unsafe_source", "image_source_policy_rejected", "image_storage_conflict", "composition_failure", "config_failure", "d1_failure", "verifier_composition_failure", "image_composition_failure", "database_busy", "idempotent_existing", "evaluation_ineligible"].includes(code)) return code;
  if (code === "ENOENT" || code === "EACCES") return "artifact_unavailable";
  if (code === "ECONNRESET" || code === "ETIMEDOUT") return "gate_execution_failed";
  return "composition_failure";
}

function reconciliationOutcome(result: StageReconciliation): "consistent" | "missing" | "conflict" {
  return typeof result === "string" ? result : result.outcome;
}

function reconciliationGameId(result: StageReconciliation): number | undefined {
  return typeof result === "string" ? undefined : result.gameId;
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
  const sleep = input.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const snapshot = await input.repository.load(input.runId);
  if (input.requestedRunStage !== undefined && snapshot.run.current_stage !== input.requestedRunStage) {
    throw new Error("requested run stage does not match durable current stage");
  }
  if (!input.write) return { status: snapshot.run.status, run: snapshot.run, items: snapshot.items };

  let run = snapshot.run;
  let runStageAlreadyStarted = input.runStageAlreadyStarted === true;
  if (run.status === "created") run = await input.repository.transitionRun(run, { type: "start" }, now());
  else if (input.mode === "resume" || input.mode === "retry") {
    const states = run.current_stage === null ? null : JSON.parse(run.run_stage_states_json) as Record<string, { state: string; attemptCount?: number }>;
    const uncertain = run.status === "paused" && run.current_stage !== null && states?.[run.current_stage]?.state === "retryable_failed";
    if (uncertain && !input.composition.reconcileRunStage) return { status: run.status, run, items: snapshot.items };
    if (uncertain) {
      const reconciliation = await input.composition.reconcileRunStage!({ runId: input.runId, stage: run.current_stage!, artifactSha256: run.artifact_sha256 });
      if (reconciliation.outcome !== "consistent") {
        if (reconciliation.outcome === "conflict") {
          run = await input.repository.transitionRun(run, { type: "reconcile_conflict", reasonCode: "reconciliation_conflict" }, now());
          return { status: run.status, run, items: snapshot.items };
        }
        if ((states?.[run.current_stage!]?.attemptCount ?? 0) >= MAX_ATTEMPTS) {
          run = await input.repository.transitionRun(run, { type: "retry_exhausted", reasonCode: "retry_exhausted" }, now());
          return { status: run.status, run, items: snapshot.items };
        }
        run = await input.repository.transitionRun(run, { type: "resume" }, now());
        runStageAlreadyStarted = true;
      } else {
        run = await input.repository.transitionRun(run, { type: "reconcile_succeed", artifactSha256: reconciliation.artifactSha256 }, now());
        return { status: run.status, run, items: snapshot.items };
      }
    }
    if (run.status === "paused") run = await input.repository.transitionRun(run, { type: "resume" }, now());
    else if (run.status !== "running") return { status: run.status, run, items: [] };
  } else if (run.status !== "running") return { status: run.status, run, items: [] };
  const items = [...snapshot.items].sort((left, right) => left.ordinal - right.ordinal);
  if (run.current_stage !== null) {
    if (!input.composition.runRunStage) throw new Error("run-stage executor unavailable");
    if (run.status !== "running") return { status: run.status, run, items: [] };
    const stage = run.current_stage;
    const stageState = JSON.parse(run.run_stage_states_json) as Record<string, { state: string; attemptCount?: number }>;
    if (stageState[stage]?.state === "retryable_failed" && !runStageAlreadyStarted) {
      if (!input.composition.reconcileRunStage) return { status: run.status, run, items };
      const reconciliation = await input.composition.reconcileRunStage({ runId: input.runId, stage, artifactSha256: run.artifact_sha256 });
      if (reconciliation.outcome !== "consistent") {
        run = await input.repository.transitionRun(run, { type: "fail", retryClass: reconciliation.outcome === "conflict" ? "permanent" : "retryable", reasonCode: reconciliation.outcome === "conflict" ? "reconciliation_conflict" : "completion_missing" }, now());
        return { status: run.status, run, items };
      }
      run = await input.repository.transitionRun(run, { type: "start_stage" }, now());
      run = await input.repository.transitionRun(run, { type: "succeed", artifactSha256: reconciliation.artifactSha256 }, now());
      return { status: run.status, run, items };
    }
    let runStageAttempt = (stageState[stage]?.attemptCount ?? 0);
    while (true) {
      // `resume` admits a paused run-level stage and persists it as running.
      if (!runStageAlreadyStarted) run = await input.repository.transitionRun(run, { type: "start_stage" }, now());
      runStageAlreadyStarted = false;
      try {
        const result = await input.composition.runRunStage({ runId: input.runId, stage, artifactSha256: run.artifact_sha256 });
        run = await input.repository.transitionRun(run, { type: "succeed", artifactSha256: result.artifactSha256 }, now());
        break;
      } catch (error) {
        const reasonCode = reason(error);
        run = await input.repository.transitionRun(run, { type: "fail", retryClass: "retryable", reasonCode }, now());
        runStageAttempt += 1;
        if (runStageAttempt >= MAX_ATTEMPTS || !input.composition.reconcileRunStage) break;
        const reconciliation = await input.composition.reconcileRunStage({ runId: input.runId, stage, artifactSha256: run.artifact_sha256 });
        if (reconciliation.outcome === "consistent") {
          run = await input.repository.transitionRun(run, { type: "resume" }, now());
          run = await input.repository.transitionRun(run, { type: "succeed", artifactSha256: reconciliation.artifactSha256 }, now());
          break;
        }
        if (reconciliation.outcome === "conflict") break;
        run = await input.repository.transitionRun(run, { type: "resume" }, now());
        runStageAlreadyStarted = true;
        const delay = retryDelayMs(runStageAttempt + 1);
        if (delay !== null) await sleep(delay);
      }
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
        const outcome = reconciliationOutcome(result);
        const reconciled = await writeQueue(() => input.repository.transitionItem(current, completedStage, { type: "reconcile", result: outcome }, now()));
        current = reconciled.item;
        if (outcome !== "consistent") return;
      }
    }
    const interruptedStage = current.current_stage;
    const interrupted = input.mode === "resume"
      && ["import", "enrich", "verify", "images"].includes(interruptedStage)
      && current.current_state === "retryable_failed"
      && current.reason_code === "stale_attempt";
    if (interrupted) {
      if (!input.composition.reconcileStage) return;
      const result = await input.composition.reconcileStage({ steamAppId: current.steam_app_id, stage: interruptedStage, gameId: current.game_id });
      const outcome = reconciliationOutcome(result);
      const gameId = reconciliationGameId(result);
      const reconciled = await writeQueue(() => input.repository.transitionItem(current, interruptedStage, {
        type: "reconcile", result: outcome, ...(gameId === undefined ? {} : { gameId }),
      }, now()));
      current = reconciled.item;
      if (outcome !== "consistent") return;
    }
    for (const stage of ITEM_STAGES) {
      if (stage === "discover" || current.current_stage !== stage
        || (input.mode === "retry" && !["pending", "retryable_failed"].includes(current.current_state))
        || (current.current_state !== "pending" && current.current_state !== "retryable_failed")) continue;
      const started = await writeQueue(() => input.repository.transitionItem(current, stage, { type: "start" }, now()));
      current = started.item;
      const runWithCap: (operation: () => Promise<{ status: "succeeded"; gameId: number | null; summary: string }>) => Promise<{ status: "succeeded"; gameId: number | null; summary: string }> =
        providerQueues.get(stage) ?? ((operation) => operation());
      let attempt = current.attempt_count;
      while (true) {
        let result: { status: "succeeded"; gameId: number | null; summary: string };
        try {
          result = await runWithCap(() => input.composition.runStage({ steamAppId: current.steam_app_id, stage, gameId: current.game_id, dryRun: false, snapshotDate: snapshot.run.snapshot_date }));
        } catch (error) {
          const code = reason(error);
          const stageClassification = classifyStageFailure(code);
          const classification = stageClassification === "run_fatal" ? classifyRetry(code) as RetryClass : stageClassification;
          current = (await writeQueue(() => input.repository.transitionItem(current, stage,
            { type: "fail", retryClass: classification === "run_fatal" ? "permanent" : classification, reasonCode: code }, now()))).item;
          if (classification === "run_fatal") { fatal = true; return; }
          if (classification !== "retryable" || attempt >= MAX_ATTEMPTS) return;
          attempt += 1;
          const delay = retryDelayMs(attempt);
          if (delay !== null) await sleep(delay);
          current = (await writeQueue(() => input.repository.transitionItem(current, stage, { type: "start" }, now()))).item;
          continue;
        }
        current = (await writeQueue(() => input.repository.transitionItem(current, stage,
          { type: "succeed", ...(stage === "import" ? { gameId: result.gameId! } : {}) }, now()))).item;
        break;
      }
    }
    completed.push(current);
  };

  const worker = async () => {
    try {
      while (!fatal) {
        const index = next++;
        if (index >= items.length) return;
        await processItem(items[index]);
      }
    } catch (error) {
      fatal = true;
      throw error;
    }
  };
  // Fixed worker count is intentional: candidates are claimed one at a time and never spread into an unbounded promise array.
  const workers: Array<Promise<void>> = [];
  for (let index = 0; index < Math.min(WORKERS, items.length); index++) workers.push(worker());
  const settled = await Promise.allSettled(workers);
  const firstFailure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (firstFailure) throw firstFailure.reason;
  if (fatal) run = await input.repository.transitionRun(run, { type: "fatal" }, now());
  return { status: run.status, run, items: completed.sort((left, right) => left.ordinal - right.ordinal) };
}
