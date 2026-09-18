import { assertCompleteBatch, runBulkSyncBatch } from "../sync/batch";
import { stageError } from "../sync/stages";
import { STAGE_NAMES, type BulkGameResult } from "../sync/types";
import { parseCronSyncConfig } from "./config";
import { safeCronError } from "./errors";
import { assertCronResult } from "./result";
import { createCronSignals } from "./signals";
import {
  parseScheduledMutationAuthority,
  type AttemptStamp, type CandidateRepository, type CronExecutionInput, type CronExecutionResult,
  type CronFailureCode, type CronGameRuntime, type CronSignals, type CronSyncConfig, type LeaseHandle,
  type LeaseRepository, type ScheduledMutationAuthority, type SchedulerStateRepository, type SyncCandidate,
} from "./types";

export type CronSyncDependencies = {
  config: CronSyncConfig;
  lease: LeaseRepository;
  candidates: CandidateRepository;
  state: SchedulerStateRepository;
  gameExists(gameId: number): Promise<boolean>;
  createGameRuntime(candidate: SyncCandidate, authority: ScheduledMutationAuthority, signals: CronSignals): CronGameRuntime;
  runBatch: typeof runBulkSyncBatch;
  elapsedMs: () => number;
  newOwnerToken: () => string;
};

function lostCandidate(candidate: SyncCandidate): BulkGameResult {
  const error = stageError("steam", "write_conflict");
  return {
    appId: candidate.appId, gameId: null, status: "failed",
    stages: STAGE_NAMES.map((name) => name === "steam"
      ? { name, status: "failed", summary: "Stage failed.", error: { code: error.code, message: error.message } }
      : { name, status: "not_run", summary: "Stage not run: previous_stage_failed.", reason: "previous_stage_failed" }),
  };
}

function errorCode(cause: unknown, fallback: CronFailureCode): CronFailureCode {
  const code = cause && typeof cause === "object" && "code" in cause ? cause.code : null;
  if (code === "lease_lost" || code === "fence_lost") return code;
  if (fallback === "state_write_failed" && code === "state_conflict") return code;
  return fallback;
}

export async function runCronSync(input: CronExecutionInput, deps: CronSyncDependencies): Promise<CronExecutionResult> {
  const result: CronExecutionResult = {
    executionId: input.executionId, status: "completed", selected: 0, attempted: 0, succeeded: 0, failed: 0,
    notStarted: 0, stopReason: "none", games: [], primaryError: null, secondaryErrors: [], leaseDisposition: "not_acquired",
  };
  const signals = createCronSignals();
  let config: CronSyncConfig | undefined;
  let lease: LeaseHandle | undefined;
  let phase: CronFailureCode = "configuration_error";

  function fail(code: CronFailureCode) {
    if (!result.primaryError) result.primaryError = safeCronError(code);
    else if ((code === "lease_lost" || code === "fence_lost" || code === "lease_release_failed")
      && code !== result.primaryError.code && !result.secondaryErrors.some((error) => error.code === code)) {
      result.secondaryErrors.push({ code, message: safeCronError(code).message });
    }
    result.status = "failed";
    if (code === "lease_lost" || code === "fence_lost") signals.markAuthorityLoss(code);
    result.stopReason = signals.readAuthorityLoss() ? "authority_lost" : "infrastructure_failure";
  }

  function observe(runtime?: CronGameRuntime) {
    // Candidate closures can hold evidence hidden by the pipeline's first-error result.
    // Always merge both channels, including when the singleton throws or is malformed.
    try {
      const loss = runtime?.readAuthorityLoss();
      if (loss) signals.markAuthorityLoss(loss);
    } finally {
      for (const reason of runtime?.readUnsettledImageWork() ?? []) signals.markUnsettled(reason);
    }
    const loss = signals.readAuthorityLoss();
    if (loss) fail(loss);
  }

  function addGame(game: BulkGameResult) {
    result.games.push(game);
    if (game.status === "succeeded") result.succeeded += 1;
    else result.failed += 1;
  }

  try {
    config = parseCronSyncConfig(deps.config);
    phase = "composition_failed";
    if ([deps.lease?.acquire, deps.lease?.assertOwned, deps.lease?.release, deps.candidates?.select,
      deps.candidates?.stillMatches, deps.state?.startAttempt, deps.state?.finishAttempt,
      deps.gameExists, deps.createGameRuntime, deps.runBatch, deps.elapsedMs, deps.newOwnerToken]
      .some((value) => typeof value !== "function")) throw safeCronError(phase);

    phase = "lease_acquire_failed";
    const acquired = await deps.lease.acquire(deps.newOwnerToken(), config.leaseDurationMs);
    if (acquired.status === "held") {
      result.status = "skipped";
      result.stopReason = "active_lease";
    } else {
      lease = parseScheduledMutationAuthority(acquired.lease);
      result.leaseDisposition = "retained_until_expiry";
      phase = "candidate_read_failed";
      // Freeze the chosen slice for this invocation; later state updates only affect later runs.
      const candidates = (await deps.candidates.select(config.batchSize)).slice(0, config.batchSize).map((candidate) => ({ ...candidate }));
      result.selected = candidates.length;
      for (const candidate of candidates) {
        observe();
        if (signals.readAuthorityLoss() || signals.readUnsettledImageWork().length) break;
        phase = "lease_lost";
        const owned = await deps.lease.assertOwned(lease);
        if (!Number.isSafeInteger(owned.dbNowMs) || owned.dbNowMs < 0
          || !Number.isSafeInteger(owned.leaseExpiresAtMs) || owned.leaseExpiresAtMs <= owned.dbNowMs) {
          throw safeCronError("lease_lost");
        }
        const elapsed = deps.elapsedMs();
        const reserve = config.gameAdmissionReserveMs + config.finishReserveMs;
        if (!Number.isFinite(elapsed) || elapsed < 0) throw safeCronError("lease_lost");
        if (elapsed >= config.softDeadlineMs || config.platformWallBudgetMs - elapsed < reserve
          || owned.leaseExpiresAtMs - owned.dbNowMs < reserve) {
          result.stopReason = "soft_deadline";
          break;
        }

        let stamp: AttemptStamp | undefined;
        let runtime: CronGameRuntime | undefined;
        try {
          phase = "candidate_read_failed";
          const matches = await deps.candidates.stillMatches(candidate);
          const exists = matches || await deps.gameExists(candidate.gameId);
          if (exists) {
            phase = "state_write_failed";
            stamp = await deps.state.startAttempt(candidate.gameId, lease);
          }
          result.attempted += 1;
          if (!matches) {
            addGame(lostCandidate(candidate));
          } else {
            phase = "composition_failed";
            runtime = deps.createGameRuntime(candidate, lease, signals);
            phase = "pipeline_contract_error";
            const batch = await deps.runBatch({ appIds: [candidate.appId], dryRun: false, stages: runtime.stages });
            assertCompleteBatch(batch, [candidate.appId], false);
            const game = batch.games[0]!;
            if (game.gameId !== null && game.gameId !== candidate.gameId) throw safeCronError(phase);
            addGame(game);
          }
        } catch (cause) {
          fail(errorCode(cause, phase));
        } finally {
          observe(runtime);
        }
        if (result.primaryError || signals.readAuthorityLoss()) break;
        if (stamp) {
          phase = "state_write_failed";
          await deps.state.finishAttempt(stamp, result.games[result.games.length - 1]!.status);
        }
        if (signals.readUnsettledImageWork().length) break;
      }
    }
  } catch (cause) {
    fail(errorCode(cause, phase));
  } finally {
    observe();
    if (lease) {
      if (signals.readAuthorityLoss()) {
        result.leaseDisposition = "no_longer_owned";
      } else if (signals.readUnsettledImageWork().length) {
        result.leaseDisposition = "retained_until_expiry";
      } else {
        try {
          const released = await deps.lease.release(lease);
          if (released === "fence_lost") {
            fail("fence_lost");
            result.leaseDisposition = "no_longer_owned";
          } else if (released === "released") result.leaseDisposition = "released";
          else throw safeCronError("lease_release_failed");
        } catch (cause) {
          fail(errorCode(cause, "lease_release_failed"));
          result.leaseDisposition = signals.readAuthorityLoss() ? "no_longer_owned" : "retained_until_expiry";
        }
      }
    }
    result.notStarted = result.selected - result.attempted;
    if (!result.primaryError && result.status !== "skipped") {
      if (signals.readUnsettledImageWork().length) result.stopReason = "unsettled_remote_work";
      result.status = result.failed || result.notStarted || result.stopReason === "unsettled_remote_work" ? "partial" : "completed";
    }
  }
  assertCronResult(result, config?.batchSize ?? 25);
  return result;
}
