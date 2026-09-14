import {
  isStageError,
  stageError,
  type BulkSyncStages,
  type StageOutput,
} from "./stages";
import {
  STAGE_NAMES,
  type BulkGameResult,
  type BulkStageResult,
  type NotRunReason,
} from "./types";

export async function runBulkSyncGame(input: {
  appId: string;
  dryRun: boolean;
  stages: BulkSyncStages;
}): Promise<BulkGameResult> {
  let gameId: number | null = null;
  let failed = false;
  let skip: NotRunReason | undefined;
  const results: BulkStageResult[] = [];
  const context = { dryRun: input.dryRun };

  for (const name of STAGE_NAMES) {
    if (skip) {
      results.push({
        name,
        status: "not_run",
        reason: skip,
        summary: `Stage not run: ${skip}.`,
      });
      continue;
    }

    try {
      let output: StageOutput;
      if (name === "steam") {
        const steam = await input.stages.steam.execute(input.appId, context);
        gameId = steam.gameId;
        const hasCanonicalGameId =
          gameId !== null && Number.isSafeInteger(gameId) && gameId > 0;

        if (!hasCanonicalGameId) {
          if (input.dryRun && steam.action === "create" && gameId === null) {
            skip = "canonical_game_not_persisted";
          } else {
            gameId = null;
            throw stageError(name, "invalid_result");
          }
        }
        output = steam;
      } else {
        if (gameId === null) throw stageError(name, "invalid_result");
        output = await input.stages[name].execute(gameId, context);
      }

      results.push({ name, status: "succeeded", summary: output.summary });
    } catch (cause) {
      const error = isStageError(cause, name)
        ? cause
        : stageError(name, "unexpected_error");
      results.push({
        name,
        status: "failed",
        summary: "Stage failed.",
        error: { code: error.code, message: error.message },
      });
      failed = true;
      skip = "previous_stage_failed";
    }
  }

  return {
    appId: input.appId,
    gameId,
    status: failed ? "failed" : "succeeded",
    stages: results,
  };
}
