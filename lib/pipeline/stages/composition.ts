import { PIPELINE_ITEM_STAGES, type LocalPipelineConfig, type PipelineStagePorts, type PipelineStageResult } from "./ports";

export type { PipelineStageResult } from "./ports";
export type PipelineRunResult = {
  status: "succeeded";
  gameId: number;
  stages: PipelineStageResult[];
};

type CompositionInput = { config: LocalPipelineConfig } & PipelineStagePorts;

function exactResult(value: unknown, stage: PipelineStageResult["stage"], expectedGameId: number | null): PipelineStageResult {
  const invalid = () => { throw { stage, code: "invalid_result", message: `Pipeline ${stage} stage failed (invalid_result).` }; };
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "gameId,stage,status,summary" || record.stage !== stage || record.status !== "succeeded"
    || (stage === "discover" ? record.gameId !== null && (!Number.isSafeInteger(record.gameId) || (record.gameId as number) <= 0)
      : !Number.isSafeInteger(record.gameId) || (record.gameId as number) <= 0)
    || typeof record.summary !== "string"
    || (expectedGameId !== null && record.gameId !== expectedGameId)) {
    invalid();
  }
  return record as PipelineStageResult;
}

export function composePipelineStages(input: CompositionInput) {
  if (input.config.execution !== "local") throw new Error("V2.10 pipeline execution must be local.");
  if (input.config.productionR2 === true) throw new Error("Production R2 is not a V2.10 pipeline path.");

  return {
    async runStage(stageInput: { steamAppId: string; stage: typeof PIPELINE_ITEM_STAGES[number]; gameId: number | null; dryRun: boolean; snapshotDate?: string }) {
      const value = await input[stageInput.stage]({ steamAppId: stageInput.steamAppId, gameId: stageInput.gameId, dryRun: stageInput.dryRun });
      return exactResult(value, stageInput.stage, stageInput.stage === "discover" ? null : stageInput.gameId);
    },
    async run(steamAppId: string, options: { dryRun?: boolean } = {}): Promise<PipelineRunResult> {
      let gameId: number | null = null;
      const stages: PipelineStageResult[] = [];
      for (const stage of PIPELINE_ITEM_STAGES) {
        const checked = await this.runStage({ steamAppId, stage, gameId, dryRun: options.dryRun ?? false });
        gameId = checked.gameId;
        stages.push(checked);
      }
      return { status: "succeeded", gameId: gameId!, stages };
    },
  };
}
