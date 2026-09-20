import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { AnyD1Database } from "drizzle-orm/d1";
import { createRunRepository } from "../lib/pipeline/run-repository";
import { runPipelineCommand } from "../lib/pipeline/command";
import { resumePipeline, retryPipeline } from "../lib/pipeline/recovery";
import type { PipelineRunnerComposition, PipelineRunnerRepository } from "../lib/pipeline/runner";
import { composePipelineStages } from "../lib/pipeline/stages/composition";
import { pipelineStageError } from "../lib/pipeline/stages/ports";
import type { BulkSyncDependencies } from "./sync-composition";
import { readFile } from "node:fs/promises";
import { writeFile as fsWriteFile, mkdir, readdir, symlink, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { reconcileLocalGate, runLocalGate, type LocalGateFs } from "../lib/pipeline/gates/local";
import { parseInputManifest, parsePublicationSelection, type PublicationSelection } from "../lib/pipeline/contracts";
import type { RunSnapshot } from "../lib/pipeline/run-repository";
import { createDatabase } from "../lib/db/client";
import { evaluateGames } from "../lib/site-data/eligibility";
import { readSiteSnapshot } from "../lib/site-data/read-model";
import { deriveRunId, hashManifest } from "../lib/pipeline/canonical";
import { buildPipelineReport, presentPipelineReport, type PipelineReport } from "../lib/pipeline/report";

const RUN_ID = /^pipeline-v2\.10:[0-9a-f]{64}$/;

export type PipelineCliDependencies = {
  repository: PipelineRunnerRepository & {
    create?: (manifest: unknown, now: number) => Promise<RunSnapshot>;
  };
  composition?: PipelineRunnerComposition;
  run?: typeof import("../lib/pipeline/runner").runPipeline;
  resume?: typeof resumePipeline;
  retry?: typeof retryPipeline;
  readSelection?: (path: string) => Promise<unknown>;
  readManifest?: (path: string) => Promise<unknown>;
  preflightEvaluate?: (input: { snapshot: RunSnapshot; selection: PublicationSelection }) => { diagnostics: readonly Record<string, unknown>[] } | Promise<{ diagnostics: readonly Record<string, unknown>[] }>;
  exportCommand?: (input: { selection: string; snapshotDate: string; json: boolean }) => Promise<Record<string, unknown>>;
  runStageCommand?: (input: { runId?: string; stage: "preview" | "publish-ready"; write: boolean; selection?: string }) => Promise<Record<string, unknown>>;
  now?: () => number;
  stdout(text: string): void | Promise<void>;
  stderr(text: string): void | Promise<void>;
};

export type PipelineCliCompositionOptions = {
  createDependencies?: (config: ReturnType<typeof import("./sync-composition").validateBulkSyncConfig>) => Promise<BulkSyncDependencies>;
  env?: Readonly<Record<string, string | undefined>>;
  artifact?: () => Promise<string>;
  gateFs?: LocalGateFs;
  tempRoot?: string;
  checkSiteData?: (artifactPath: string) => Promise<void>;
  build?: (artifactPath: string, outputPath: string) => Promise<void>;
  buildCommand?: (artifactPath: string, outputPath: string) => Promise<void>;
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
  const { createLocalBulkSyncDependencies, validateBulkSyncConfig } = await import("./sync-composition");
  const dependencies = await (options.createDependencies ?? createLocalBulkSyncDependencies)(
    validateBulkSyncConfig(options.env ?? process.env),
  );
  const gateFs = options.gateFs ?? {
    async read(path: string) {
      try { return await readFile(path, "utf8"); } catch { return undefined; }
    },
    async list(path: string) {
      const entries: string[] = [];
      async function visit(directory: string) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const child = `${directory}/${entry.name}`;
          if (entry.isDirectory()) await visit(child); else entries.push(child);
        }
      }
      try { await visit(path); } catch { return []; }
      return entries;
    },
    async remove(path: string) { await rm(path, { recursive: true, force: true }); },
    async write(path: string, value: string) {
      await mkdir(resolve(path, ".."), { recursive: true });
      await fsWriteFile(path, value, "utf8");
    },
  } satisfies LocalGateFs;
  const readArtifact = options.artifact ?? (() => readFile(resolve("generated/site-data.json"), "utf8"));
  const checkSiteData = options.checkSiteData ?? (async (artifactPath: string) => {
    const { checkSiteData: check } = await import("./check-site-data");
    const result = await check({ readText: () => gateFs.read(artifactPath) });
    if (!result.valid) throw new Error(`site-data check failed: ${result.diagnostics.join(",")}`);
  });
  const buildCommand = options.buildCommand ?? (async (artifactPath: string, outputPath: string) => {
    const buildRoot = resolve(outputPath, "..");
    await mkdir(buildRoot, { recursive: true });
    for (const entry of await readdir(resolve("."))) {
      if (entry === ".tmp" || entry === ".next" || entry === "out") continue;
      try { await symlink(resolve(entry), resolve(buildRoot, entry)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    await promisify(execFile)("npm", ["run", "build"], {
      cwd: buildRoot,
      env: { ...process.env, ...(options.env ?? {}), GAMEHUB_SITE_DATA_PATH: resolve(artifactPath), GAMEHUB_BUILD_OUTPUT_PATH: resolve(outputPath) },
      maxBuffer: 10 * 1024 * 1024,
    });
  });
  const build = options.build ?? buildCommand;
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
    async runRunStage({ runId, stage, artifactSha256 }) {
      if (stage === "export") throw new Error("export must be completed before preview");
      const artifact = await readArtifact();
      const result = await runLocalGate({ runId, stage, artifact, artifactSha256, fs: gateFs, tempRoot: options.tempRoot, checkSiteData, build });
      return { artifactSha256: result.artifactSha256 };
    },
    async reconcileRunStage({ runId, stage, artifactSha256 }) {
      if (stage === "export") throw new Error("export reconciliation is unavailable");
      const artifact = await readArtifact();
      return reconcileLocalGate({ runId, stage, artifact, artifactSha256, fs: gateFs, tempRoot: options.tempRoot });
    },
    dispose: dependencies.dispose,
  };
}

type PipelineCommand = "create" | "run" | "resume" | "retry" | "report" | "evaluate" | "export" | "preview" | "publish-ready";
export type PipelineArgs = { command: PipelineCommand; runId?: string; write: boolean; json: boolean; selection?: string; manifest?: string; snapshotDate?: string };

export function parsePipelineArgs(argv: readonly string[]): PipelineArgs {
  const command = argv[0] as PipelineCommand | undefined;
  const commands: readonly PipelineCommand[] = ["create", "run", "resume", "retry", "report", "evaluate", "export", "preview", "publish-ready"];
  if (!command || !commands.includes(command)) throw new Error("pipeline command must be create, run, resume, retry, or evaluate (also report, export, preview, publish-ready)");
  let runId: string | undefined;
  let write = false;
  let json = false;
  let selection: string | undefined;
  let manifest: string | undefined;
  let snapshotDate: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--write") {
      if (write) throw new Error("--write must be provided once");
      write = true;
      continue;
    }
    if (argument === "--json") {
      if (json) throw new Error("--json must be provided once");
      json = true;
      continue;
    }
    if (argument === "--run-id") {
      if (runId !== undefined) throw new Error("--run-id must be provided once");
      runId = argv[++index];
      if (!runId) throw new Error("run ID is required");
      continue;
    }
    if (argument === "--manifest") {
      if (manifest !== undefined) throw new Error("--manifest must be provided once");
      manifest = argv[++index];
      if (!manifest) throw new Error("manifest path is required");
      continue;
    }
    if (argument === "--selection") {
      if (selection !== undefined) throw new Error("--selection must be provided once");
      selection = argv[++index];
      if (!selection) throw new Error("selection path is required");
      continue;
    }
    if (argument === "--snapshot-date") {
      if (snapshotDate !== undefined) throw new Error("snapshot date must be provided once");
      snapshotDate = argv[++index];
      if (!snapshotDate) throw new Error("snapshot date is required");
      continue;
    }
    if (argument === "--remote" || argument === "--database-id" || argument === "--env" || argument === "--config") {
      throw new Error("--remote is not supported");
    }
    throw new Error(`unsupported argument ${argument}`);
  }
  if (["run", "resume", "retry", "report", "evaluate"].includes(command)
    && (!runId || !RUN_ID.test(runId))) throw new Error("run ID must be an exact pipeline-v2.10 durable run ID");
  if (command === "create" && !manifest) throw new Error("create requires --manifest");
  if (command === "export" && (!selection || !snapshotDate)) throw new Error("export requires --selection and --snapshot-date");
  if (command === "evaluate" && (!selection || write)) throw new Error("evaluate requires --selection and is strictly read-only");
  if (!["evaluate", "export", "preview", "publish-ready"].includes(command) && selection) throw new Error("--selection is only supported by evaluate, export, preview, or publish-ready");
  if (["preview", "publish-ready"].includes(command) && !runId && !selection) throw new Error(`${command} requires --selection or --run-id`);
  if (command !== "create" && manifest) throw new Error("--manifest is only supported by create");
  if (command !== "export" && snapshotDate) throw new Error("--snapshot-date is only supported by export");
  if (["report", "evaluate"].includes(command) && write) throw new Error(`${command} is strictly read-only`);
  return { command, write, json, ...(runId ? { runId } : {}), ...(selection ? { selection } : {}), ...(manifest ? { manifest } : {}), ...(snapshotDate ? { snapshotDate } : {}) };
}

export async function runPipelineCli(argv: readonly string[], deps: PipelineCliDependencies): Promise<number> {
  try {
    const args = parsePipelineArgs(argv);
    const readManifest = deps.readManifest ?? (async (path) => JSON.parse(await readFile(path, "utf8")));
    if (args.command === "create") {
      const manifest = parseInputManifest(await readManifest(args.manifest!));
      const result = { runId: deriveRunId(manifest), manifestHash: hashManifest(manifest), itemCount: manifest.items.length, write: args.write };
      if (args.write) {
        if (!deps.repository.create) throw new Error("create repository unavailable");
        await deps.repository.create(manifest, deps.now?.() ?? Date.now());
      }
      await deps.stdout(`${JSON.stringify(result)}\n`);
      return 0;
    }
    if (args.command === "evaluate") {
      const runId = args.runId!;
      const snapshot = await deps.repository.load(runId);
      const value = await (deps.readSelection ?? (async (path) => JSON.parse(await readFile(path, "utf8"))))(args.selection!);
      const manifest = parseInputManifest({ manifestVersion: "1", pipelineVersion: snapshot.run.pipeline_version, policyVersion: snapshot.run.policy_version,
        snapshotDate: snapshot.run.snapshot_date, items: snapshot.items.map((item) => ({ ordinal: item.ordinal, steamAppId: item.steam_app_id })) });
      const selection = parsePublicationSelection(value, { manifest, manifestHash: snapshot.run.manifest_hash });
      const result = await deps.preflightEvaluate?.({ snapshot, selection });
      if (!result) throw new Error("evaluate preflight evaluator unavailable");
      const diagnostics = [...result.diagnostics].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      await deps.stdout(`${JSON.stringify({ runId, diagnostics })}\n`);
      return 0;
    }
    if (args.command === "report") {
      const snapshot = await deps.repository.load(args.runId!);
      const stages = JSON.parse(snapshot.run.run_stage_states_json);
      const itemStages = snapshot.items.map((item) => ({ ordinal: item.ordinal, steamAppId: item.steam_app_id, gameId: item.game_id, slug: null,
        stages: JSON.parse(item.stage_states_json) }));
      const report = buildPipelineReport({ reportVersion: "1", runId: snapshot.run.run_id, manifestHash: snapshot.run.manifest_hash,
        pipelineVersion: "2.10", policyVersion: snapshot.run.policy_version, snapshotDate: snapshot.run.snapshot_date,
        lifecycleStatus: snapshot.run.status, currentRunStage: snapshot.run.current_stage, artifactSha256: snapshot.run.artifact_sha256,
        runStages: stages, items: itemStages }) as PipelineReport;
      await deps.stdout(`${args.json ? JSON.stringify(report) : presentPipelineReport(report)}\n`);
      return 0;
    }
    if (args.command === "export") {
      if (!deps.exportCommand) throw new Error("export command unavailable");
      await deps.stdout(`${JSON.stringify(await deps.exportCommand({ selection: args.selection!, snapshotDate: args.snapshotDate!, json: args.json }))}\n`);
      return 0;
    }
    if (args.command === "preview" || args.command === "publish-ready") {
      if (!deps.runStageCommand) throw new Error(`${args.command} command unavailable`);
      if (!args.runId && !args.selection) throw new Error(`${args.command} requires --selection or --run-id`);
      await deps.stdout(`${JSON.stringify(await deps.runStageCommand({ runId: args.runId, stage: args.command, write: args.write, ...(args.selection ? { selection: args.selection } : {}) }))}\n`);
      return 0;
    }
    const runId = args.runId!;
    const result = args.command === "resume"
          ? await (deps.resume ?? resumePipeline)({ runId, repository: deps.repository, composition: deps.composition!, write: args.write })
          : args.command === "retry"
            ? await (deps.retry ?? retryPipeline)({ runId, repository: deps.repository, composition: deps.composition!, write: args.write })
        : await runPipelineCommand({ runId, repository: deps.repository, composition: deps.composition!, write: args.write, run: deps.run });
    await deps.stdout(`${JSON.stringify({ runId, status: result.status })}\n`);
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
    const argv = process.argv.slice(2);
    const readOnlyCommand = ["create", "report", "evaluate", "export"].includes(argv[0] ?? "");
    const composition = readOnlyCommand ? undefined : await createPipelineCliComposition();
    const args = parsePipelineArgs(argv);
    const exportCommand = args.command === "export" ? async ({ selection, snapshotDate }: { selection: string; snapshotDate: string }) => {
      const { runExport } = await import("./export-site-data");
      const selectionValue = JSON.parse(await readFile(selection, "utf8"));
      const repository = createRunRepository(platform.env.DB);
      const selectionManifest = selectionValue as { manifestHash?: string };
      if (!selectionManifest.manifestHash) throw new Error("selection manifestHash is required");
      const snapshot = await repository.load(`pipeline-v2.10:${selectionManifest.manifestHash}`);
      const result = await runExport({ argv: ["--snapshot-date", snapshotDate, "--selection", selection, "--run-id", snapshot.run.run_id],
        readSnapshot: () => readSiteSnapshot(createDatabase(platform.env.DB)), publication: { selection: selectionValue, snapshot }, repository });
      return result;
    } : undefined;
    const runStageCommand = composition && ["preview", "publish-ready"].includes(args.command) ? async ({ runId, stage, write, selection }: { runId?: string; stage: "preview" | "publish-ready"; write: boolean; selection?: string }) => {
      let resolvedRunId = runId;
      if (!resolvedRunId && selection) {
        const value = JSON.parse(await readFile(selection, "utf8")) as { manifestHash?: unknown };
        if (typeof value.manifestHash !== "string" || !RUN_ID.test(`pipeline-v2.10:${value.manifestHash}`)) throw new Error("selection manifestHash must link to a durable run ID");
        resolvedRunId = `pipeline-v2.10:${value.manifestHash}`;
      }
      if (!resolvedRunId) throw new Error("selection-to-run linkage requires a durable run ID");
      const repository = createRunRepository(platform.env.DB);
      const result = await runPipelineCommand({ runId: resolvedRunId, repository, composition, write });
      return { runId: resolvedRunId, status: result.status, stage, selection: selection ?? null };
    } : undefined;
    const code = await runPipelineCli(argv, {
      repository,
      ...(composition ? { composition } : {}),
      ...(exportCommand ? { exportCommand } : {}),
      ...(runStageCommand ? { runStageCommand } : {}),
      preflightEvaluate: createPipelinePreflightEvaluator(platform.env.DB),
      ...(readOnlyCommand ? {} : {}),
      stdout: (text) => { process.stdout.write(text); },
      stderr: (text) => { process.stderr.write(text); },
    });
    await composition?.dispose();
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
