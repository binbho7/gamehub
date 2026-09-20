import type { ImageWorkerClient, LinkVerifierPort, IgdbEnricherPort, SteamImporterPort } from "../../sync/stages";

export const PIPELINE_ITEM_STAGES = ["discover", "import", "enrich", "verify", "images", "evaluate"] as const;
export type PipelineItemStage = typeof PIPELINE_ITEM_STAGES[number];

export type PipelineStageResult = {
  stage: PipelineItemStage;
  status: "succeeded";
  gameId: number | null;
  summary: string;
};

export type PipelineStagePort = (input: { steamAppId: string; gameId: number | null; dryRun: boolean; snapshotDate?: string }) =>
  Promise<PipelineStageResult>;

export type PipelineStageFailureCode = "invalid_result" | "evaluation_runtime_unavailable" | "evaluation_ineligible";
export type PipelineStageError = {
  stage: PipelineItemStage;
  code: PipelineStageFailureCode;
  message: string;
};

export function pipelineStageError(stage: PipelineItemStage, code: PipelineStageFailureCode): PipelineStageError {
  return Object.freeze({ stage, code, message: `Pipeline ${stage} stage failed (${code}).` });
}

export type PipelineStagePorts = {
  discover: PipelineStagePort;
  import: PipelineStagePort;
  enrich: PipelineStagePort;
  verify: PipelineStagePort;
  images: PipelineStagePort;
  evaluate: PipelineStagePort;
};

export type PipelineEvaluatePort = PipelineStagePort;

export type LocalPipelineConfig = {
  execution: "local";
  productionR2?: boolean;
};

export type PipelineStageDependencies = {
  config: LocalPipelineConfig;
  ports: PipelineStagePorts;
};

export type ExistingSyncPorts = {
  steam: SteamImporterPort;
  igdb: IgdbEnricherPort;
  links: LinkVerifierPort;
  images: ImageWorkerClient;
  evaluate?: PipelineEvaluatePort;
};
