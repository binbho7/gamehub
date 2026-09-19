import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { AnyD1Database } from "drizzle-orm/d1";
import { createRunRepository } from "../lib/pipeline/run-repository";
import { runPipelineCommand } from "../lib/pipeline/command";
import { resumePipeline, retryPipeline } from "../lib/pipeline/recovery";
import type { PipelineRunnerComposition, PipelineRunnerRepository } from "../lib/pipeline/runner";
import { composePipelineStages } from "../lib/pipeline/stages/composition";
import { pipelineStageError } from "../lib/pipeline/stages/ports";
import { createLocalBulkSyncDependencies, validateBulkSyncConfig, type BulkSyncDependencies } from "./sync-composition";
import { readFile } from "node:fs/promises";
import { parseInputManifest, parsePublicationSelection, type PublicationSelection } from "../lib/pipeline/contracts";
import type { RunSnapshot } from "../lib/pipeline/run-repository";
import { createDatabase } from "../lib/db/client";
import { evaluateGames } from "../lib/site-data/eligibility";
import { readSiteSnapshot } from "../lib/site-data/read-model";

const RUN_ID = /^pipeline-v2\.10:[0-9a-f]{64}$/;

export type PipelineCliDependencies = {
  repository: PipelineRunnerRepository;
  composition: PipelineRunnerComposition;
  run?: typeof import("../lib/pipeline/runner").runPipeline;
  resume?: typeof resumePipeline;
  retry?: typeof retryPipeline;
  readSelection?: (path: string) => Promise<unknown>;
  preflightEvaluate?: (input: { snapshot: RunSnapshot; selection: PublicationSelection }) => { diagnostics: readonly Record<string, unknown>[] } | Promise<{ diagnostics: readonly Record<string, unknown>[] }>;
  stdout(text: string): void | Promise<void>;
  stderr(text: string): void | Promise<void>;
};

export type PipelineCliCompositionOptions = {
  createDependencies?: (config: ReturnType<typeof validateBulkSyncConfig>) => Promise<BulkSyncDependencies>;
  env?: Readonly<Record<string, string | undefined>>;
};

export function createPipelinePreflightEvaluator(binding: AnyD1Database): NonNullable<PipelineCliDependencies["preflightEvaluate"]> {
  return async ({ snapshot, selection }) => {
    try {
      const siteSnapshot = await readSiteSnapshot(createDatabase(binding));
      const bySteamId = new Map(siteSnapshot.games.map((game) => [
        game.externalIds.find((id) => id.provider === "steam")?.externalId,
        game,
      ]));
      const selected = selection.items.filter((item) => item.decision === "include");
      const missing = selected
        .filter((item) => !bySteamId.has(item.steamAppId))
        .map((item) => ({ steamAppId: item.steamAppId, code: "snapshot_game_unavailable", message: "canonical game snapshot is unavailable" }));
      const evaluated = evaluateGames(
        selected.flatMap((item) => { const game = bySteamId.get(item.steamAppId); return game ? [game] : []; }),
        snapshot.run.snapshot_date,
      ).flatMap((result) => result.diagnostics);
      return { diagnostics: [...missing, ...evaluated] };
    } catch {
      return { diagnostics: [{ code: "evaluation_snapshot_unavailable", message: "canonical evaluation snapshot is unavailable" }] };
    }
  };
}

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
  return {
    runStage: pipeline.runStage,
    async runRunStage() {
      throw new Error("run-level export/preview executor is local-only and not configured for publication");
    },
    dispose: dependencies.dispose,
  };
}

export function parsePipelineArgs(argv: readonly string[]): { command: "run" | "resume" | "retry" | "evaluate"; runId: string; write: boolean; selection?: string } {
  const command = argv[0];
  if (command !== "run" && command !== "resume" && command !== "retry" && command !== "evaluate") {
    throw new Error("pipeline command must be run, resume, retry, or evaluate");
  }
  let runId: string | undefined;
  let write = false;
  let selection: string | undefined;
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
    if (argument === "--selection") {
      if (selection !== undefined) throw new Error("--selection must be provided once");
      selection = argv[++index];
      if (!selection) throw new Error("selection path is required");
      continue;
    }
    throw new Error(`unsupported argument ${argument}`);
  }
  if (!runId || !RUN_ID.test(runId)) throw new Error("run ID must be an exact pipeline-v2.10 durable run ID");
  if (command === "evaluate" && (!selection || write)) throw new Error("evaluate requires --selection and is strictly read-only");
  if (command !== "evaluate" && selection) throw new Error("--selection is only supported by evaluate");
  return { command, runId, write, ...(selection ? { selection } : {}) };
}

export async function runPipelineCli(argv: readonly string[], deps: PipelineCliDependencies): Promise<number> {
  try {
    const args = parsePipelineArgs(argv);
    if (args.command === "evaluate") {
      const snapshot = await deps.repository.load(args.runId);
      const value = await (deps.readSelection ?? (async (path) => JSON.parse(await readFile(path, "utf8"))))(args.selection!);
      const manifest = parseInputManifest({ manifestVersion: "1", pipelineVersion: snapshot.run.pipeline_version, policyVersion: snapshot.run.policy_version,
        snapshotDate: snapshot.run.snapshot_date, items: snapshot.items.map((item) => ({ ordinal: item.ordinal, steamAppId: item.steam_app_id })) });
      const selection = parsePublicationSelection(value, { manifest, manifestHash: snapshot.run.manifest_hash });
      const result = await deps.preflightEvaluate?.({ snapshot, selection });
      if (!result) throw new Error("evaluate preflight evaluator unavailable");
      const diagnostics = [...result.diagnostics].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      await deps.stdout(`${JSON.stringify({ runId: args.runId, diagnostics })}\n`);
      return 0;
    }
    const result = args.command === "resume"
          ? await (deps.resume ?? resumePipeline)({ ...args, repository: deps.repository, composition: deps.composition, write: args.write })
          : args.command === "retry"
            ? await (deps.retry ?? retryPipeline)({ ...args, repository: deps.repository, composition: deps.composition, write: args.write })
        : await runPipelineCommand({ ...args, ...deps });
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
      preflightEvaluate: createPipelinePreflightEvaluator(platform.env.DB),
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
