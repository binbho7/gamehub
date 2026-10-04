import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseInputManifest } from "../lib/pipeline/contracts";
import { scanHistoricalManifestIds } from "../lib/content-automation/v2-11";
import { hashManifest } from "../lib/pipeline/canonical";

type Args = { mode: "plan" | "select" | "execute" | "publish" | "all"; count: number; snapshotDate: string; dryRun: boolean; json: boolean };

function parseArgs(argv: readonly string[]): Args {
  const mode = (argv[0] ?? "plan") as Args["mode"];
  if (!["plan", "select", "execute", "publish", "all"].includes(mode)) throw new Error("mode must be plan, select, execute, publish, or all");
  let count = 10; let snapshotDate = ""; let dryRun = false; let json = false;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--count") count = Number(argv[++i]);
    else if (arg === "--snapshot-date") snapshotDate = argv[++i] ?? "";
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--json") json = true;
    else throw new Error(`unsupported argument ${arg}`);
  }
  if (!Number.isInteger(count) || count < 10 || count > 150) throw new Error("count must be between 10 and 150");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) throw new Error("snapshot-date must be YYYY-MM-DD");
  return { mode, count, snapshotDate, dryRun, json };
}

async function historicalIds(): Promise<string[]> {
  const directory = resolve("content/manifests");
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  const manifests = await Promise.all(names.map(async (name) => parseInputManifest(JSON.parse(await readFile(resolve(directory, name), "utf8")))));
  return scanHistoricalManifestIds(manifests);
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const artifactText = await readFile(resolve("generated/site-data.json"), "utf8");
  const artifact = JSON.parse(artifactText) as { games: unknown[] };
  const candidates = (await historicalIds()).slice(0, args.count);
  const manifest = { manifestVersion: "1" as const, pipelineVersion: "2.10" as const, policyVersion: "v2.10-production-1", snapshotDate: args.snapshotDate, items: candidates.map((steamAppId, index) => ({ ordinal: index + 1, steamAppId })) };
  const manifestHash = hashManifest(manifest);
  const selection = {
    selectionVersion: "2" as const, pipelineVersion: "2.10" as const, policyVersion: "v2.10-production-1" as const,
    snapshotDate: args.snapshotDate, manifestHash, publicationMode: "incremental" as const,
    baseArtifactSha256: createHash("sha256").update(artifactText).digest("hex"), baseGameCount: artifact.games.length,
    items: candidates.map((steamAppId) => ({ steamAppId, decision: "include" as const })),
  };
  const result = {
    version: "v2.11", mode: args.mode, snapshotDate: args.snapshotDate, requestedCount: args.count,
    candidateCount: candidates.length, candidates,
    discovery: candidates.length >= args.count ? { source: "tracked-manifests", code: null } : { source: "tracked-manifests", code: "DISCOVERY_API_GAP" },
    selection: args.mode === "select" ? selection : undefined, dryRun: args.dryRun, writes: false,
  };
  if (!args.dryRun && args.mode !== "plan") throw new Error("execution requires an explicit durable-run implementation; planner is dry-run only");
  if (args.json) console.log(JSON.stringify(result)); else console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
