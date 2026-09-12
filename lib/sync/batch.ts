import { runBulkSyncGame } from "./game-pipeline";
import { normalizeBulkSyncAppIds } from "./input";
import { publicError } from "./errors";
import {
  STAGE_FAILURE_CODES,
  stageError,
  type BulkSyncStages,
  type StageFailureCode,
} from "./stages";
import {
  STAGE_NAMES,
  type BulkGameResult,
  type BulkGameSyncResult,
  type BulkStageResult,
  type NotRunReason,
} from "./types";

const RESULT_KEYS = ["dryRun", "failed", "games", "succeeded", "total"];
const GAME_KEYS = ["appId", "gameId", "stages", "status"];
const SUCCEEDED_STAGE_KEYS = ["name", "status", "summary"];
const FAILED_STAGE_KEYS = ["error", "name", "status", "summary"];
const NOT_RUN_STAGE_KEYS = ["name", "reason", "status", "summary"];
const ERROR_KEYS = ["code", "message"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index]);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isKnownStageFailureCode(value: unknown): value is StageFailureCode {
  return typeof value === "string"
    && (STAGE_FAILURE_CODES as readonly string[]).includes(value);
}

function validPublicStageError(value: unknown, name: typeof STAGE_NAMES[number]): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ERROR_KEYS)) return false;
  if (!isKnownStageFailureCode(value.code) || typeof value.message !== "string") return false;
  return value.message === stageError(name, value.code).message;
}

function validStageResult(
  value: unknown,
  name: typeof STAGE_NAMES[number],
): value is BulkStageResult {
  if (!isRecord(value) || value.name !== name || typeof value.summary !== "string") return false;

  if (value.status === "succeeded") {
    return hasExactKeys(value, SUCCEEDED_STAGE_KEYS);
  }
  if (value.status === "failed") {
    return hasExactKeys(value, FAILED_STAGE_KEYS)
      && validPublicStageError(value.error, name);
  }
  if (value.status === "not_run") {
    return hasExactKeys(value, NOT_RUN_STAGE_KEYS)
      && (value.reason === "canonical_game_not_persisted"
        || value.reason === "previous_stage_failed");
  }
  return false;
}

function validGameResult(
  value: unknown,
  expectedAppId: string,
  dryRun: boolean,
): value is BulkGameResult {
  if (!isRecord(value) || !hasExactKeys(value, GAME_KEYS)) return false;
  if (value.appId !== expectedAppId) return false;
  if (value.status !== "succeeded" && value.status !== "failed") return false;
  if (value.gameId !== null && !isPositiveSafeInteger(value.gameId)) return false;
  if (!Array.isArray(value.stages) || value.stages.length !== STAGE_NAMES.length) return false;

  let failed = false;
  let skip: NotRunReason | undefined;

  for (let index = 0; index < STAGE_NAMES.length; index += 1) {
    const name = STAGE_NAMES[index]!;
    const stage = value.stages[index];
    if (!validStageResult(stage, name)) return false;

    if (stage.status === "succeeded") {
      if (failed || skip) return false;
      continue;
    }

    if (stage.status === "failed") {
      if (failed || skip) return false;
      failed = true;
      skip = "previous_stage_failed";
      continue;
    }

    if (!skip && stage.reason === "canonical_game_not_persisted") {
      skip = stage.reason;
    }
    if (!skip || stage.reason !== skip) return false;
    if (stage.summary !== `Stage not run: ${stage.reason}.`) return false;

    if (stage.reason === "canonical_game_not_persisted") {
      if (!dryRun || value.gameId !== null || index < 1) return false;
    }
  }

  if (failed !== (value.status === "failed")) return false;
  if (failed) {
    const failedIndex = value.stages.findIndex((stage) => stage.status === "failed");
    return failedIndex === 0 ? value.gameId === null : isPositiveSafeInteger(value.gameId);
  }

  if (value.gameId === null) {
    return dryRun
      && value.stages[0]?.status === "succeeded"
      && value.stages.slice(1).every((stage) =>
        stage.status === "not_run" && stage.reason === "canonical_game_not_persisted");
  }

  return value.stages.every((stage) => stage.status === "succeeded");
}

function failIncompleteBatch(): never {
  throw publicError("batch_execution_failed");
}

export function assertCompleteBatch(
  result: BulkGameSyncResult,
  appIds: readonly string[],
  dryRun: boolean,
): void {
  let expectedAppIds: string[];
  try {
    expectedAppIds = normalizeBulkSyncAppIds(appIds);
  } catch {
    failIncompleteBatch();
  }

  if (!isRecord(result) || !hasExactKeys(result, RESULT_KEYS)) failIncompleteBatch();
  if (result.dryRun !== dryRun || !Array.isArray(result.games)) failIncompleteBatch();
  if (!isNonNegativeSafeInteger(result.total)
    || !isNonNegativeSafeInteger(result.succeeded)
    || !isNonNegativeSafeInteger(result.failed)) failIncompleteBatch();
  if (result.total !== result.games.length || result.total !== expectedAppIds.length) {
    failIncompleteBatch();
  }

  let failed = 0;
  for (let index = 0; index < expectedAppIds.length; index += 1) {
    if (!validGameResult(result.games[index], expectedAppIds[index]!, dryRun)) {
      failIncompleteBatch();
    }
    if (result.games[index]!.status === "failed") failed += 1;
  }

  if (result.failed !== failed || result.succeeded !== result.total - failed) {
    failIncompleteBatch();
  }
}

export async function runBulkSyncBatch(input: {
  appIds: readonly string[];
  dryRun: boolean;
  stages: BulkSyncStages;
}): Promise<BulkGameSyncResult> {
  const appIds = normalizeBulkSyncAppIds(input.appIds);
  const games: BulkGameResult[] = [];

  for (const appId of appIds) {
    games.push(await runBulkSyncGame({
      appId,
      dryRun: input.dryRun,
      stages: input.stages,
    }));
  }

  const failed = games.filter((game) => game.status === "failed").length;
  const result: BulkGameSyncResult = {
    dryRun: input.dryRun,
    total: games.length,
    succeeded: games.length - failed,
    failed,
    games,
  };
  assertCompleteBatch(result, appIds, input.dryRun);
  return result;
}
