import { mkdir, readFile, rename, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createDatabase } from "../lib/db/client";
import { evaluateGames, type EligibilityResult } from "../lib/site-data/eligibility";
import { readSiteSnapshot, type SiteSnapshot } from "../lib/site-data/read-model";
import { assertArtifactLimits, normalizeArtifact, serializeArtifact } from "../lib/site-data/serialize";
import { parseSnapshotDate, validateArtifact } from "../lib/site-data/validation";
import { SITE_DATA_VERSION, type PublishedArtifact } from "../lib/site-data/contracts";
import { evaluatePublicationSelection } from "../lib/pipeline/publication";
import type { RunSnapshot } from "../lib/pipeline/run-repository";
import { createRunRepository } from "../lib/pipeline/run-repository";
import { acquirePublicationLock } from "../lib/pipeline/publication-lock";
import { parseRunStages } from "../lib/pipeline/state";
import { MAX_ATTEMPTS } from "../lib/pipeline/retry";
export { acquirePublicationLock } from "../lib/pipeline/publication-lock";

export function parseExportArgs(argv: string[]): { snapshotDate: string; selection?: string; runId?: string } {
  let snapshotDate: string | undefined;
  let selection: string | undefined;
  let runId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--snapshot-date") {
      if (snapshotDate !== undefined) throw new Error("snapshot date must be provided once");
      const value = argv[++index];
      if (!value) throw new Error("snapshot date is required");
      snapshotDate = value;
      continue;
    }
    if (argument === "--selection") {
      if (selection !== undefined) throw new Error("selection must be provided once");
      selection = argv[++index];
      if (!selection) throw new Error("selection path is required");
      continue;
    }
    if (argument === "--run-id") {
      if (runId !== undefined) throw new Error("run ID must be provided once");
      runId = argv[++index];
      if (!runId) throw new Error("run ID is required");
      continue;
    }
    if (["--remote", "--env", "-e", "--config", "--database-id"].includes(argument)) throw new Error(`unsupported argument ${argument}`);
    if (argument.startsWith("--")) throw new Error(`unsupported argument ${argument}`);
    throw new Error("unexpected positional argument");
  }
  if (!snapshotDate) throw new Error("snapshot date is required");
  try {
    parseSnapshotDate(snapshotDate);
  } catch (error) {
    throw new Error(/must be YYYY-MM-DD/.test(error instanceof Error ? error.message : "") ? "snapshot date must be YYYY-MM-DD" : "snapshot date is invalid");
  }
  if (selection && !runId) throw new Error("selection export requires durable run ID");
  if (runId && !/^pipeline-v2\.10:[0-9a-f]{64}$/.test(runId)) throw new Error("run ID must be an exact pipeline-v2.10 durable run ID");
  return { snapshotDate, ...(selection ? { selection } : {}), ...(runId ? { runId } : {}) };
}

type WriteFile = (path: string, content: string) => Promise<void>;
type Evaluate = (snapshot: SiteSnapshot, snapshotDate: string) => EligibilityResult[];
type ExportRepository = {
  admitExport?: (expected: RunSnapshot["run"], selection: unknown, items: RunSnapshot["items"], now: number) => Promise<RunSnapshot["run"]>;
  reconcileExportFailure?: (expected: RunSnapshot["run"], now: number) => Promise<RunSnapshot["run"]>;
  completeExport: (expected: RunSnapshot["run"], selection: unknown, artifactSha256: string, now: number) => Promise<RunSnapshot["run"]>;
  fenceExportCompletion?: (expected: RunSnapshot["run"], artifactSha256: string, now: number) => Promise<
    { outcome: "consistent"; run: RunSnapshot["run"] }
    | { outcome: "missing"; run: RunSnapshot["run"] }
    | { outcome: "conflict" }
  >;
  transitionRun?: (expected: RunSnapshot["run"], event: Exclude<import("../lib/pipeline/transitions").RunEvent, { type: "admit_export" }>, now: number) => Promise<RunSnapshot["run"]>;
};

async function completeExportDurably(repository: ExportRepository, expected: RunSnapshot["run"], selection: unknown,
  artifactSha256: string, now: number): Promise<
    { outcome: "consistent"; run: RunSnapshot["run"] }
    | { outcome: "missing"; run: RunSnapshot["run"]; error: unknown }
    | { outcome: "conflict"; error: unknown }
  > {
  try {
    return { outcome: "consistent" as const, run: await repository.completeExport(expected, selection, artifactSha256, now) };
  } catch (error) {
    if (!repository.fenceExportCompletion) {
      if (error instanceof Error && error.cause === undefined) error.cause = new Error("export completion reconciliation unavailable");
      return { outcome: "conflict" as const, error };
    }
    try {
      const reconciliation = await repository.fenceExportCompletion(expected, artifactSha256, now);
      if (reconciliation.outcome === "consistent") return reconciliation;
      if (reconciliation.outcome === "conflict" && error instanceof Error && error.cause === undefined) {
        error.cause = new Error("export completion reconciliation conflict");
      }
      return reconciliation.outcome === "missing"
        ? { outcome: "missing", run: reconciliation.run, error }
        : { outcome: "conflict", error };
    } catch (reconciliationError) {
      if (error instanceof Error && error.cause === undefined) error.cause = reconciliationError;
      return { outcome: "conflict" as const, error };
    }
  }
}

export type ExportOptions = {
  argv: string[];
  readSnapshot: () => Promise<SiteSnapshot>;
  writeFile?: WriteFile;
  evaluate?: Evaluate;
  publication?: { selection: unknown; snapshot: RunSnapshot };
  repository?: ExportRepository;
  readArtifact?: () => Promise<string | null>;
  now?: () => number;
  atomicReplace?: (path: string, content: string) => Promise<void>;
  acquirePublicationLock?: () => Promise<() => Promise<void>>;
  artifactPath?: string;
  removeArtifact?: (path: string) => Promise<void>;
};

export async function runExport(options: ExportOptions) {
  const args = parseExportArgs(options.argv);
  const { snapshotDate } = args;
  const readSnapshot = options.readSnapshot;
  const evaluate = options.evaluate ?? ((snapshot, date) => evaluateGames(snapshot.games, date));
  const siteSnapshot = await readSnapshot();
  if (options.publication && options.publication.snapshot.run.snapshot_date !== snapshotDate) {
    throw new Error("CLI snapshot date does not match durable publication run snapshot date");
  }
  const publication = options.publication
    ? evaluatePublicationSelection({ snapshot: options.publication.snapshot, selection: options.publication.selection, candidates: siteSnapshot.games })
    : null;
  if (publication && !publication.admitted) {
    throw new Error(`Publication selection rejected: ${publication.diagnostics.map((value) => `${value.steamAppId}:${value.code}`).join(",")}`);
  }
  const results = publication
    ? publication.artifactGames.map((published) => ({ published, diagnostics: [] }))
    : evaluate(siteSnapshot, snapshotDate);
  const eligible = results.flatMap((result) => result.published ? [result.published] : []);
  const diagnostics = results
    .flatMap((result) => result.diagnostics)
    .sort((left, right) => left.slug === right.slug ? left.code.localeCompare(right.code) : left.slug.localeCompare(right.slug));
  const report = `${JSON.stringify({
    totalGames: results.length,
    eligibleCount: eligible.length,
    excludedCount: results.length - eligible.length,
    exclusions: diagnostics.map(({ slug, code }) => ({ slug, code })),
    ...(publication ? { operatorExcluded: publication.excluded.map(({ steamAppId }) => steamAppId) } : {}),
  }, null, 2)}\n`;
  const write = options.writeFile ?? (async (path, content) => {
    await mkdir(resolve(path, ".."), { recursive: true });
    await fsWriteFile(path, content, "utf8");
  });
  if (args.selection && !options.publication) {
    throw new Error("selection export requires a durable publication snapshot");
  }
  await write("generated/export-report.json", report);
  if (eligible.length === 0) throw new Error("No eligible games; run the approved local import/enrichment workflow before exporting");
  if (diagnostics.length > 0) throw new Error("Snapshot contains ineligible games; export is fail-closed");

  const artifact: PublishedArtifact = normalizeArtifact({ version: SITE_DATA_VERSION, snapshotDate, games: eligible });
  validateArtifact(artifact);
  const serialized = serializeArtifact(artifact);
  assertArtifactLimits(serialized, eligible.length);
  const artifactSha256 = createHash("sha256").update(serialized, "utf8").digest("hex");
  const artifactPath = options.artifactPath ?? "generated/site-data.json";
  // The production lock covers every read/decision involving the shared
  // artifact, including the matching-artifact completion shortcut. Injected
  // writers remain lock-free test seams and never touch the real destination.
  const productionArtifactWriter = !options.writeFile && !options.atomicReplace;
  const releasePublicationLock = (productionArtifactWriter || options.acquirePublicationLock)
    ? await (options.acquirePublicationLock ?? (() => acquirePublicationLock(artifactPath)))()
    : async () => {};
  try {
    const priorArtifact = options.publication && options.repository
      ? await (options.readArtifact ?? (async () => {
        try { return await readFile(artifactPath, "utf8"); }
        catch (error) {
          if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
          throw error;
        }
      }))()
      : null;
    const durableStage = options.publication?.snapshot.run.current_stage ?? null;
    if (options.publication && options.repository?.admitExport && durableStage === null) {
      const selectedItems = (options.publication.selection as { items: Array<{ steamAppId: string; decision: string }> }).items;
      const includedIds = new Set(selectedItems.filter((item) => item.decision === "include").map((item) => item.steamAppId));
      const admittedRun = await options.repository.admitExport(options.publication.snapshot.run, options.publication.selection,
        options.publication.snapshot.items.filter((item) => includedIds.has(item.steam_app_id)), options.now?.() ?? Date.now());
      options.publication = { ...options.publication, snapshot: { ...options.publication.snapshot, run: admittedRun } };
    }
    if (options.publication && durableStage !== null && durableStage !== "export") {
      if (options.publication.snapshot.run.artifact_sha256 !== artifactSha256 || priorArtifact !== serialized) {
        throw new Error("durable export is already complete with a conflicting artifact");
      }
      return { totalGames: results.length, eligibleCount: eligible.length, excludedCount: results.length - eligible.length, artifactSha256 };
    }
    if (options.publication && durableStage === "export" && priorArtifact === serialized && options.repository) {
      const completion = await completeExportDurably(options.repository, options.publication.snapshot.run,
        options.publication.selection, artifactSha256, options.now?.() ?? Date.now());
      if (completion.outcome !== "consistent") throw completion.error;
      return { totalGames: results.length, eligibleCount: eligible.length, excludedCount: results.length - eligible.length, artifactSha256 };
    }
    if (options.publication && durableStage === "export" && options.repository?.transitionRun) {
      let run = options.publication.snapshot.run;
      let exportOutcome = parseRunStages(run.run_stage_states_json).export;
      if (exportOutcome.state === "running") {
        run = await options.repository.transitionRun(run, { type: "fail", retryClass: "retryable", reasonCode: "interrupted" }, options.now?.() ?? Date.now());
        exportOutcome = parseRunStages(run.run_stage_states_json).export;
      }
      if (exportOutcome.state === "retryable_failed") {
        if (exportOutcome.attemptCount >= MAX_ATTEMPTS) {
          run = await options.repository.transitionRun(run, { type: "retry_exhausted", reasonCode: "retry_exhausted" }, options.now?.() ?? Date.now());
          options.publication = { ...options.publication, snapshot: { ...options.publication.snapshot, run } };
          throw new Error("export retry budget exhausted");
        }
        run = await options.repository.transitionRun(run, { type: "resume" }, options.now?.() ?? Date.now());
        options.publication = { ...options.publication, snapshot: { ...options.publication.snapshot, run } };
      }
    }
    // The injected writer is the test seam and represents an atomic replace. The
    // production writer stages beside the artifact and renames only after all
    // preparation, validation, serialization, limits, and hashing succeeded.
    let ownedStagingPath: string | null = null;
    let artifactReplacedByThisInvocation = false;
    try {
      if (options.writeFile) {
        await write(artifactPath, serialized);
        artifactReplacedByThisInvocation = true;
      } else if (options.atomicReplace) {
        await options.atomicReplace(artifactPath, serialized);
        artifactReplacedByThisInvocation = true;
      }
      else {
        const runSuffix = options.publication?.snapshot.run.run_id.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80) ?? "standalone";
        ownedStagingPath = `${artifactPath}.tmp.${runSuffix}.${randomUUID()}`;
        await write(ownedStagingPath, serialized);
        await rename(ownedStagingPath, artifactPath);
        ownedStagingPath = null;
        artifactReplacedByThisInvocation = true;
      }
    } catch (error) {
      if (ownedStagingPath !== null) await rm(ownedStagingPath, { force: true }).catch(() => {});
      if (options.publication && options.repository?.reconcileExportFailure) {
        try {
          await options.repository.reconcileExportFailure(options.publication.snapshot.run, options.now?.() ?? Date.now());
        } catch (reconcileError) {
          if (error instanceof Error) error.cause = reconcileError;
        }
      }
      throw error;
    }
    if (options.publication && options.repository) {
      const completion = await completeExportDurably(options.repository, options.publication.snapshot.run,
        options.publication.selection, artifactSha256, options.now?.() ?? Date.now());
      if (completion.outcome !== "consistent") {
        const error = completion.error;
        let rollbackError: unknown;
        if (completion.outcome === "missing") {
          try {
            const currentArtifact = await (options.readArtifact ?? (async () => {
              try { return await readFile(artifactPath, "utf8"); } catch { return null; }
            }))();
            if (artifactReplacedByThisInvocation && currentArtifact === serialized) {
              if (priorArtifact !== null) {
                if (options.atomicReplace) await options.atomicReplace(artifactPath, priorArtifact);
                else {
                  const restorePath = `${artifactPath}.restore.tmp.${randomUUID()}`;
                  await write(restorePath, priorArtifact);
                  await rename(restorePath, artifactPath);
                }
              } else if (productionArtifactWriter) {
                await (options.removeArtifact ?? ((path: string) => rm(path, { force: true })))(artifactPath);
              }
            }
          } catch (failure) { rollbackError = failure; }
        }
        if (rollbackError !== undefined && error instanceof Error) error.cause = rollbackError;
        throw error;
      }
    }
    return { totalGames: results.length, eligibleCount: eligible.length, excludedCount: results.length - eligible.length, artifactSha256 };
  } finally {
    await releasePublicationLock();
  }
}

async function main() {
  const args = parseExportArgs(process.argv.slice(2));
  const { getPlatformProxy } = await import("wrangler");
  const platform = await getPlatformProxy<{ DB: Parameters<typeof createDatabase>[0] }>({
    configPath: resolve("wrangler.jsonc"),
    persist: true,
    remoteBindings: false,
  });
  try {
    const argv = ["--snapshot-date", args.snapshotDate, ...(args.selection ? ["--selection", args.selection, "--run-id", args.runId!] : [])];
    const repository = createRunRepository(platform.env.DB);
    const publication = args.selection
      ? { selection: JSON.parse(await readFile(args.selection, "utf8")), snapshot: await repository.load(args.runId!) }
      : undefined;
    await runExport({ argv, readSnapshot: () => readSiteSnapshot(createDatabase(platform.env.DB as Parameters<typeof createDatabase>[0])), ...(publication ? { publication, repository } : {}) });
  } finally {
    await platform.dispose();
  }
}

if (process.argv[1]?.endsWith("export-site-data.ts")) void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
