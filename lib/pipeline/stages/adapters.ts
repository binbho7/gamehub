import { createIgdbStage } from "../../sync/igdb-stage";
import { createImageSyncStage } from "../../sync/image-stage";
import { createLinkStage } from "../../sync/link-stage";
import { createSteamStage } from "../../sync/steam-stage";
import { stageError } from "../../sync/stages";
import { pipelineStageError, type ExistingSyncPorts, type PipelineStagePorts, type PipelineStageResult } from "./ports";

const positiveId = (gameId: number | null): gameId is number => gameId !== null && Number.isSafeInteger(gameId) && gameId > 0;

function result(stage: PipelineStageResult["stage"], gameId: number | null, summary: string): PipelineStageResult {
  return { stage, status: "succeeded", gameId, summary };
}

export function createPipelineStagePorts(existing: ExistingSyncPorts): PipelineStagePorts {
  const steam = createSteamStage(existing.steam);
  const igdb = createIgdbStage(existing.igdb);
  const links = createLinkStage(existing.links);
  const images = createImageSyncStage(existing.images);

  return {
    discover: async ({ gameId, steamAppId }) => {
      return result("discover", gameId, `Discovered ${steamAppId}.`);
    },
    import: async ({ steamAppId, dryRun }) => {
      const value = await steam.execute(steamAppId, { dryRun });
      if (!positiveId(value.gameId)) throw stageError("steam", "invalid_result");
      return result("import", value.gameId, value.summary);
    },
    enrich: async ({ gameId, dryRun }) => {
      if (!positiveId(gameId)) throw stageError("igdb", "invalid_result");
      const value = await igdb.execute(gameId, { dryRun });
      return result("enrich", gameId, value.summary);
    },
    verify: async ({ gameId, dryRun }) => {
      if (!positiveId(gameId)) throw stageError("links", "invalid_result");
      const value = await links.execute(gameId, { dryRun });
      return result("verify", gameId, value.summary);
    },
    images: async ({ gameId, dryRun }) => {
      if (!positiveId(gameId)) throw stageError("images", "invalid_result");
      const value = await images.execute(gameId, { dryRun });
      return result("images", gameId, value.summary);
    },
    evaluate: async ({ gameId, steamAppId, dryRun }) => {
      if (!positiveId(gameId)) throw pipelineStageError("evaluate", "invalid_result");
      if (!existing.evaluate) throw pipelineStageError("evaluate", "evaluation_runtime_unavailable");
      return existing.evaluate({ steamAppId, gameId, dryRun });
    },
  };
}
