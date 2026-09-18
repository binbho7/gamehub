import { z } from "zod";
import { assertCompleteBatch } from "../sync/batch";
import { safeCronError } from "./errors";
import type { CronExecutionResult } from "./types";

const failureCode = z.enum([
  "configuration_error", "composition_failed", "lease_acquire_failed", "lease_lost", "fence_lost",
  "candidate_read_failed", "state_write_failed", "state_conflict", "pipeline_contract_error", "lease_release_failed",
]);
const safeError = z.strictObject({ code: failureCode, message: z.string() })
  .refine((error) => error.message === safeCronError(error.code).message);
const secondaryError = z.strictObject({ code: z.enum(["lease_release_failed", "lease_lost", "fence_lost"]), message: z.string() })
  .refine((error) => error.message === safeCronError(error.code).message);
const count = z.number().int().safe().nonnegative();
const resultSchema = z.strictObject({
  executionId: z.string().min(1),
  status: z.enum(["completed", "partial", "skipped", "failed"]),
  selected: count, attempted: count, succeeded: count, failed: count, notStarted: count,
  stopReason: z.enum(["none", "active_lease", "soft_deadline", "unsettled_remote_work", "authority_lost", "infrastructure_failure"]),
  games: z.array(z.unknown()), primaryError: safeError.nullable(), secondaryErrors: z.array(secondaryError),
  leaseDisposition: z.enum(["not_acquired", "released", "retained_until_expiry", "no_longer_owned"]),
});

export function assertCronResult(result: CronExecutionResult, batchSize: number): void {
  const invalid = () => { throw safeCronError("pipeline_contract_error"); };
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 25 || !resultSchema.safeParse(result).success) invalid();
  if ([result.selected, result.attempted, result.succeeded, result.failed, result.notStarted].some((value) => value > batchSize)
    || result.attempted > result.selected
    || result.notStarted !== result.selected - result.attempted
    || result.succeeded + result.failed !== result.games.length
    || result.attempted < result.games.length
    || result.attempted > result.games.length + 1
    || (result.attempted !== result.games.length && result.status !== "failed")) invalid();

  let succeeded = 0;
  for (const game of result.games) {
    try {
      assertCompleteBatch({ dryRun: false, total: 1, succeeded: game.status === "succeeded" ? 1 : 0, failed: game.status === "failed" ? 1 : 0, games: [game] }, [game.appId], false);
    } catch { invalid(); }
    if (game.status === "succeeded") succeeded += 1;
  }
  if (succeeded !== result.succeeded || new Set(result.games.map((game) => game.appId)).size !== result.games.length) invalid();

  const errors = [result.primaryError, ...result.secondaryErrors].filter((error) => error !== null);
  const lost = errors.some((error) => error.code === "lease_lost" || error.code === "fence_lost");
  if (lost !== (result.stopReason === "authority_lost") || lost !== (result.leaseDisposition === "no_longer_owned")) invalid();
  if (!lost && errors.some((error) => error.code === "lease_release_failed") && result.leaseDisposition !== "retained_until_expiry") invalid();
  if ((result.primaryError?.code === "configuration_error" || result.primaryError?.code === "lease_acquire_failed")
    && result.leaseDisposition !== "not_acquired") invalid();
  if (result.status === "failed") {
    if (!result.primaryError || !["authority_lost", "infrastructure_failure"].includes(result.stopReason)) invalid();
  } else if (result.primaryError || result.secondaryErrors.length) invalid();

  if (result.status === "skipped") {
    if (result.selected !== 0 || result.stopReason !== "active_lease" || result.leaseDisposition !== "not_acquired") invalid();
  } else if (result.stopReason === "active_lease") invalid();

  if (result.status === "completed") {
    if (result.failed !== 0 || result.notStarted !== 0 || result.stopReason !== "none" || result.leaseDisposition !== "released") invalid();
  }
  if (result.status === "partial") {
    if (!result.failed && !result.notStarted && result.stopReason !== "unsettled_remote_work") invalid();
    if (!["none", "soft_deadline", "unsettled_remote_work"].includes(result.stopReason)) invalid();
    if (result.stopReason === "soft_deadline" && !result.notStarted) invalid();
    if (result.stopReason === "none" && result.notStarted) invalid();
    if (result.leaseDisposition !== (result.stopReason === "unsettled_remote_work" ? "retained_until_expiry" : "released")) invalid();
  }
  if (result.leaseDisposition === "not_acquired" && result.selected !== 0) invalid();
}
