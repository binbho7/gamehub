import { sanitizeTextForPresentation } from "../verifiers/official-links/presentation";
import type { BulkGameSyncResult } from "./types";

export function presentBulkSyncResult(result: BulkGameSyncResult): BulkGameSyncResult {
  return {
    dryRun: result.dryRun,
    total: result.total,
    succeeded: result.succeeded,
    failed: result.failed,
    games: result.games.map((game) => ({
      appId: game.appId,
      gameId: game.gameId,
      status: game.status,
      stages: game.stages.map((stage) => ({
        name: stage.name,
        status: stage.status,
        summary: sanitizeTextForPresentation(stage.summary),
        ...(stage.reason ? { reason: stage.reason } : {}),
        ...(stage.error ? {
          error: {
            code: sanitizeTextForPresentation(stage.error.code),
            message: sanitizeTextForPresentation(stage.error.message),
          },
        } : {}),
      })),
    })),
  };
}

export function formatBulkSyncResultJson(result: BulkGameSyncResult): string {
  return JSON.stringify(presentBulkSyncResult(result));
}

export function formatBulkSyncResultHuman(result: BulkGameSyncResult): string {
  const value = presentBulkSyncResult(result);
  return [
    `Bulk sync ${value.dryRun ? "dry-run" : "write"}: total=${value.total} succeeded=${value.succeeded} failed=${value.failed}`,
    ...value.games.flatMap((game) => [
      `App ${game.appId} game=${game.gameId ?? "none"} ${game.status}`,
      ...game.stages.map((stage) => `  ${stage.name} ${stage.status} ${stage.summary}`
        + (stage.reason ? ` reason=${stage.reason}` : "")
        + (stage.error ? ` ${stage.error.code}: ${stage.error.message}` : "")),
    ]),
    `Failed App IDs: ${value.games.filter((game) => game.status === "failed").map((game) => game.appId).join(" ") || "none"}`,
  ].join("\n");
}
