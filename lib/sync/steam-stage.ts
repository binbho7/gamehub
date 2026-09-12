import type { SteamImportResult } from "../importers/candidate";
import { SteamImportError } from "../importers/errors";
import { SteamProviderError } from "../providers/steam/errors";
import {
  isStageError,
  stageError,
  type StageContext,
  type SteamImporterPort,
  type SteamStageOutput,
  type SteamSyncStage,
} from "./stages";

function isPositiveSafeInteger(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value > 0;
}

function isValidResult(result: SteamImportResult, appId: string, context: StageContext): boolean {
  if (result.appId !== appId || result.dryRun !== context.dryRun) return false;
  if (!["created", "updated", "existing"].includes(result.status)) return false;
  if (!["create", "update", "existing"].includes(result.plan.action)) return false;
  // A newly planned dry-run create has no canonical identity by definition.
  if (result.gameId === null) {
    return context.dryRun && result.status === "created"
      && result.plan.action === "create" && result.plan.existingGameId === null;
  }
  return isPositiveSafeInteger(result.gameId);
}

export function createSteamStage(importer: SteamImporterPort): SteamSyncStage {
  return {
    async execute(appId, context): Promise<SteamStageOutput> {
      try {
        const result = await importer.importGame(appId, { dryRun: context.dryRun });
        if (!isValidResult(result, appId, context)) throw stageError("steam", "invalid_result");
        return {
          gameId: result.gameId,
          action: result.plan.action,
          summary: `Steam ${result.status}.`,
        };
      } catch (error) {
        if (isStageError(error, "steam")) throw error;
        if (error instanceof SteamProviderError || error instanceof SteamImportError) {
          throw stageError("steam", error.code);
        }
        throw stageError("steam", "unexpected_error");
      }
    },
  };
}
