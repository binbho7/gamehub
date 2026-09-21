import { runPipeline, type PipelineRunnerComposition, type PipelineRunnerRepository } from "./runner";

export type RunPipelineCommandInput = {
  runId: string;
  repository: PipelineRunnerRepository;
  composition: PipelineRunnerComposition;
  write: boolean;
  requestedRunStage?: import("./state").RunStage;
  run?: typeof runPipeline;
};

/** The command/runtime seam: command parsing supplies only the durable run ID. */
export function runPipelineCommand(input: RunPipelineCommandInput) {
  const execute = input.run ?? runPipeline;
  return execute({ runId: input.runId, repository: input.repository, composition: input.composition, write: input.write, requestedRunStage: input.requestedRunStage });
}
