import { mkdir, readFile, rename, writeFile as fsWriteFile } from "node:fs/promises";
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

export type ExportOptions = {
  argv: string[];
  readSnapshot: () => Promise<SiteSnapshot>;
  writeFile?: WriteFile;
  evaluate?: Evaluate;
  publication?: { selection: unknown; snapshot: RunSnapshot };
  repository?: { completeExport: (expected: RunSnapshot, selection: unknown, artifactSha256: string, now: number) => Promise<unknown> };
  now?: () => number;
  atomicReplace?: (path: string, content: string) => Promise<void>;
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
  // The injected writer is the test seam and represents an atomic replace. The
  // production writer stages beside the artifact and renames only after all
  // preparation, validation, serialization, limits, and hashing succeeded.
  if (options.writeFile) await write("generated/site-data.json", serialized);
  else if (options.atomicReplace) await options.atomicReplace("generated/site-data.json", serialized);
  else {
    const temporaryPath = "generated/site-data.json.tmp";
    await write(temporaryPath, serialized);
    await rename(temporaryPath, "generated/site-data.json");
  }
  if (options.publication && options.repository) {
    await options.repository.completeExport(options.publication.snapshot, options.publication.selection, artifactSha256, options.now?.() ?? Date.now());
  }
  return { totalGames: results.length, eligibleCount: eligible.length, excludedCount: results.length - eligible.length, artifactSha256 };
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
