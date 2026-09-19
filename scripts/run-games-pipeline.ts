import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { AnyD1Database } from "drizzle-orm/d1";
import { createRunRepository } from "../lib/pipeline/run-repository";
import { runPipelineCommand } from "../lib/pipeline/command";
import type { PipelineRunnerComposition, PipelineRunnerRepository } from "../lib/pipeline/runner";
import { composePipelineStages } from "../lib/pipeline/stages/composition";
import { pipelineStageError } from "../lib/pipeline/stages/ports";
import { createLocalBulkSyncDependencies, validateBulkSyncConfig, type BulkSyncDependencies } from "./sync-composition";

const RUN_ID = /^pipeline-v2\.10:[0-9a-f]{64}$/;

export type PipelineCliDependencies = {
  repository: PipelineRunnerRepository;
  composition: PipelineRunnerComposition;
  run?: typeof import("../lib/pipeline/runner").runPipeline;
  stdout(text: string): void | Promise<void>;
  stderr(text: string): void | Promise<void>;
};

export type PipelineCliCompositionOptions = {
  createDependencies?: (config: ReturnType<typeof validateBulkSyncConfig>) => Promise<BulkSyncDependencies>;
  env?: Readonly<Record<string, string | undefined>>;
};

export async function createPipelineCliComposition(options: PipelineCliCompositionOptions = {}): Promise<PipelineRunnerComposition & { dispose(): Promise<void> }> {
  const dependencies = await (options.createDependencies ?? createLocalBulkSyncDependencies)(
    validateBulkSyncConfig(options.env ?? process.env),
  );
  const pipeline = composePipelineStages({
    config: { execution: "local", productionR2: false },
    discover: async ({ steamAppId }) => ({ stage: "discover", status: "succeeded", gameId: null, summary: `Discovered ${steamAppId}.` }),
    import: async ({ steamAppId, dryRun }) => {
      const value = await dependencies.stages.steam.execute(steamAppId, { dryRun });
      return { stage: "import", status: "succeeded", gameId: value.gameId, summary: value.summary };
    },
    enrich: async ({ gameId, dryRun }) => {
      if (gameId === null) throw new Error("missing game identity");
      const value = await dependencies.stages.igdb.execute(gameId, { dryRun });
      return { stage: "enrich", status: "succeeded", gameId, summary: value.summary };
    },
    verify: async ({ gameId, dryRun }) => {
      if (gameId === null) throw new Error("missing game identity");
      const value = await dependencies.stages.links.execute(gameId, { dryRun });
      return { stage: "verify", status: "succeeded", gameId, summary: value.summary };
    },
    images: async ({ gameId, dryRun }) => {
      if (gameId === null) throw new Error("missing game identity");
      const value = await dependencies.stages.images.execute(gameId, { dryRun });
      return { stage: "images", status: "succeeded", gameId, summary: value.summary };
    },
    evaluate: async ({ gameId }) => {
      if (gameId === null) throw new Error("missing game identity");
      throw pipelineStageError("evaluate", "evaluation_runtime_unavailable");
    },
  });
  return { runStage: pipeline.runStage, dispose: dependencies.dispose };
}

export function parsePipelineArgs(argv: readonly string[]): { runId: string; write: boolean } {
  if (argv[0] !== "run") throw new Error("only the run command is available");
  let runId: string | undefined;
  let write = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--write") {
      if (write) throw new Error("--write must be provided once");
      write = true;
      continue;
    }
    if (argument === "--run-id") {
      if (runId !== undefined) throw new Error("--run-id must be provided once");
      runId = argv[++index];
      if (!runId) throw new Error("run ID is required");
      continue;
    }
    throw new Error(`unsupported argument ${argument}`);
  }
  if (!runId || !RUN_ID.test(runId)) throw new Error("run ID must be an exact pipeline-v2.10 durable run ID");
  return { runId, write };
}

export async function runPipelineCli(argv: readonly string[], deps: PipelineCliDependencies): Promise<number> {
  try {
    const args = parsePipelineArgs(argv);
    const result = await runPipelineCommand({ ...args, ...deps });
    await deps.stdout(`${JSON.stringify({ runId: args.runId, status: result.status })}\n`);
    return 0;
  } catch (error) {
    await deps.stderr(`${error instanceof Error ? error.message : "pipeline command failed"}\n`);
    return 1;
  }
}

async function main() {
  const { getPlatformProxy } = await import("wrangler");
  const platform = await getPlatformProxy<{ DB: AnyD1Database }>({
    configPath: resolve("wrangler.jsonc"),
    persist: true,
    remoteBindings: false,
  });
  try {
    const repository = createRunRepository(platform.env.DB);
    const composition = await createPipelineCliComposition();
    const code = await runPipelineCli(process.argv.slice(2), {
      repository,
      composition,
      stdout: (text) => { process.stdout.write(text); },
      stderr: (text) => { process.stderr.write(text); },
    });
    await composition.dispose();
    process.exitCode = code;
  } finally {
    await platform.dispose();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
