import { mkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDatabase } from "../lib/db/client";
import { evaluateGames, type EligibilityResult } from "../lib/site-data/eligibility";
import { readSiteSnapshot, type SiteSnapshot } from "../lib/site-data/read-model";
import { assertArtifactLimits, serializeArtifact } from "../lib/site-data/serialize";
import { parseSnapshotDate, validateArtifact } from "../lib/site-data/validation";
import { SITE_DATA_VERSION, type PublishedArtifact } from "../lib/site-data/contracts";

export function parseExportArgs(argv: string[]): { snapshotDate: string } {
  let snapshotDate: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--snapshot-date") {
      if (snapshotDate !== undefined) throw new Error("snapshot date must be provided once");
      const value = argv[++index];
      if (!value) throw new Error("snapshot date is required");
      snapshotDate = value;
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
  return { snapshotDate };
}

type WriteFile = (path: string, content: string) => Promise<void>;
type Evaluate = (snapshot: SiteSnapshot, snapshotDate: string) => EligibilityResult[];

export type ExportOptions = {
  argv: string[];
  readSnapshot: () => Promise<SiteSnapshot>;
  writeFile?: WriteFile;
  evaluate?: Evaluate;
};

export async function runExport(options: ExportOptions) {
  const { snapshotDate } = parseExportArgs(options.argv);
  const readSnapshot = options.readSnapshot;
  const evaluate = options.evaluate ?? ((snapshot, date) => evaluateGames(snapshot.games, date));
  const results = evaluate(await readSnapshot(), snapshotDate);
  const eligible = results.flatMap((result) => result.published ? [result.published] : []);
  const diagnostics = results
    .flatMap((result) => result.diagnostics)
    .sort((left, right) => left.slug === right.slug ? left.code.localeCompare(right.code) : left.slug.localeCompare(right.slug));
  if (eligible.length === 0) throw new Error("No eligible games; run the approved local import/enrichment workflow before exporting");

  const artifact: PublishedArtifact = validateArtifact({ version: SITE_DATA_VERSION, snapshotDate, games: eligible });
  const serialized = serializeArtifact(artifact);
  assertArtifactLimits(serialized, eligible.length);
  const report = `${JSON.stringify({
    totalGames: results.length,
    eligibleCount: eligible.length,
    excludedCount: results.length - eligible.length,
    exclusions: diagnostics.map(({ slug, code }) => ({ slug, code })),
  }, null, 2)}\n`;
  const write = options.writeFile ?? (async (path, content) => {
    await mkdir(resolve(path, ".."), { recursive: true });
    await fsWriteFile(path, content, "utf8");
  });
  await write("generated/site-data.json", serialized);
  await write("generated/export-report.json", report);
  return { totalGames: results.length, eligibleCount: eligible.length, excludedCount: results.length - eligible.length };
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
    await runExport({ argv: ["--snapshot-date", args.snapshotDate], readSnapshot: () => readSiteSnapshot(createDatabase(platform.env.DB as Parameters<typeof createDatabase>[0])) });
  } finally {
    await platform.dispose();
  }
}

if (process.argv[1]?.endsWith("export-site-data.ts")) void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
