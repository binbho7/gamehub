import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { parseInputManifest } from "../lib/pipeline/contracts";
import { scanHistoricalManifestIds } from "../lib/content-automation/v2-11";
import { hashManifest } from "../lib/pipeline/canonical";
import { deriveRunId } from "../lib/pipeline/canonical";
import { discoverTopSellerGames } from "../lib/providers/steam/top-sellers";
import { assertSafeBatchId } from "../lib/content-automation/batch-id";
import type { PipelineReport } from "../lib/pipeline/report";

type Args = { mode: "plan" | "select" | "execute" | "publish" | "all"; count: number; snapshotDate: string; batchId?: string; dryRun: boolean; json: boolean };
type SelectedItem = { steamAppId: string; decision: "include" | "exclude"; reason?: string };
export type SafePipelineSummary = {
  batchId: string;
  runId: string;
  counts: PipelineReport["counts"];
  stageFailures: Array<{ stage: string; state: string; reasonCode: string | null; retryClass: string; count: number }>;
  includeCount: number;
  excludeCount: number;
};
const exec = promisify(execFile);

const SUMMARY_STAGES = ["discover", "import", "enrich", "verify", "images", "evaluate"] as const;

export function deriveSafePipelineSummary(batchId: string, runId: string, report: PipelineReport, selectedItems: readonly SelectedItem[]): SafePipelineSummary {
  const failures = new Map<string, SafePipelineSummary["stageFailures"][number]>();
  for (const item of report.items) {
    for (const stage of SUMMARY_STAGES) {
      const value = item.stages[stage];
      if (!["retryable_failed", "permanently_failed", "blocked", "skipped"].includes(value.state)) continue;
      const key = [stage, value.state, value.reasonCode ?? "", value.retryClass].join("\u0000");
      const existing = failures.get(key);
      if (existing) existing.count += 1;
      else failures.set(key, { stage, state: value.state, reasonCode: value.reasonCode, retryClass: value.retryClass, count: 1 });
    }
  }
  const stageFailures = [...failures.values()].sort((left, right) =>
    left.stage.localeCompare(right.stage) || left.state.localeCompare(right.state) || (left.reasonCode ?? "").localeCompare(right.reasonCode ?? "") || left.retryClass.localeCompare(right.retryClass));
  return {
    batchId,
    runId,
    counts: report.counts,
    stageFailures,
    includeCount: selectedItems.filter((item) => item.decision === "include").length,
    excludeCount: selectedItems.filter((item) => item.decision === "exclude").length,
  };
}

export function assertEligibleCandidates(summary: SafePipelineSummary): void {
  if (summary.includeCount === 0) throw new Error("NO_ELIGIBLE_CANDIDATES");
}

function optionValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

export function parseArgs(argv: readonly string[]): Args {
  const mode = (argv[0] ?? "plan") as Args["mode"];
  if (!["plan", "select", "execute", "publish", "all"].includes(mode)) throw new Error("mode must be plan, select, execute, publish, or all");
  let count = 10; let snapshotDate = ""; let batchId: string | undefined; let dryRun = false; let json = false;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--count") { count = Number(optionValue(argv, i, arg)); i += 1; }
    else if (arg === "--snapshot-date") { snapshotDate = optionValue(argv, i, arg); i += 1; }
    else if (arg === "--batch-id") { batchId = optionValue(argv, i, arg); assertSafeBatchId(batchId); i += 1; }
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--json") json = true;
    else throw new Error(`unsupported argument ${arg}`);
  }
  if (!Number.isInteger(count) || count < 10 || count > 150) throw new Error("count must be between 10 and 150");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) throw new Error("snapshot-date must be YYYY-MM-DD");
  return { mode, count, snapshotDate, ...(batchId !== undefined ? { batchId } : {}), dryRun, json };
}

async function historicalIds(): Promise<string[]> {
  const directory = resolve("content/manifests");
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  const manifests = await Promise.all(names.map(async (name) => parseInputManifest(JSON.parse(await readFile(resolve(directory, name), "utf8")))));
  return scanHistoricalManifestIds(manifests);
}

async function runNpm(script: string, args: string[]): Promise<string> {
  const result = await exec("npm", ["run", script, "--", ...args], { maxBuffer: 20 * 1024 * 1024, env: process.env });
  return result.stdout;
}

async function loadManifest(batchId: string) {
  return parseInputManifest(JSON.parse(await readFile(resolve(`content/manifests/${batchId}.json`), "utf8")));
}

async function selectBatch(batchId: string, snapshotDate: string): Promise<Record<string, unknown>> {
  const manifest = await loadManifest(batchId);
  const manifestHash = hashManifest(manifest);
  const runId = deriveRunId(manifest);
  const reportText = await runNpm("games:pipeline", ["report", "--run-id", runId, "--json"]);
  const report = JSON.parse(reportText.trim().split("\n").at(-1) ?? "{}");
  const items = (report.items ?? []) as Array<{ steamAppId?: string; stages?: Record<string, { state?: string }> }>;
  const selectedItems: SelectedItem[] = manifest.items.map((item) => {
    const durable = items.find((value) => value.steamAppId === item.steamAppId);
    const state = durable?.stages?.evaluate?.state;
    return { steamAppId: item.steamAppId, decision: state === "succeeded" ? "include" as const : "exclude" as const, reason: state === "succeeded" ? undefined : state ?? "missing" };
  });
  if (selectedItems.some((item) => item.reason === "missing")) throw new Error("selection requires a complete durable run report");
  const summary = deriveSafePipelineSummary(batchId, runId, report, selectedItems);
  console.log(`CONTENT_BATCH_PIPELINE_SUMMARY=${JSON.stringify(summary)}`);
  assertEligibleCandidates(summary);
  const artifactText = await readFile(resolve("generated/site-data.json"), "utf8");
  const selection = { selectionVersion: "2" as const, pipelineVersion: "2.10" as const, policyVersion: "v2.10-production-1" as const,
    snapshotDate, manifestHash, publicationMode: "incremental" as const,
    baseArtifactSha256: createHash("sha256").update(artifactText).digest("hex"), baseGameCount: JSON.parse(artifactText).games.length,
    items: selectedItems.map(({ steamAppId, decision }) => ({ steamAppId, decision })) };
  const path = `content/publication-selections/${batchId}.json`;
  await mkdir(resolve(path, ".."), { recursive: true }); await writeFile(path, JSON.stringify(selection, null, 2) + "\n", "utf8");
  return { selectionPath: path, runId, manifestHash, includeCount: summary.includeCount, excludeCount: summary.excludeCount };
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const batchId = args.batchId ?? `v2-11-batch-${args.snapshotDate.replaceAll("-", "")}`;
  assertSafeBatchId(batchId);
  if (["execute", "select", "publish", "all"].includes(args.mode)) {
    if (args.dryRun) throw new Error("execution modes cannot be dry-run");
    if (args.mode === "all") {
      await runNpm("content:batch:plan", ["--batch-id", batchId, "--count", String(args.count), "--snapshot-date", args.snapshotDate]);
    }
    if (args.mode === "execute" || args.mode === "all") {
      const manifest = await loadManifest(batchId);
      const runId = deriveRunId(manifest);
      await runNpm("db:migrate:local", []); await runNpm("db:verify:local", []);
      await runNpm("games:pipeline", ["create", "--manifest", `content/manifests/${batchId}.json`, "--write", "--json"]);
      await runNpm("games:pipeline", ["run", "--run-id", runId, "--write"]);
      if (args.mode === "execute") { console.log(JSON.stringify({ mode: args.mode, batchId, runId })); return 0; }
    }
    if (args.mode === "select" || args.mode === "all") {
      const selected = await selectBatch(batchId, args.snapshotDate);
      if (args.mode === "select") { console.log(JSON.stringify({ mode: args.mode, batchId, ...selected })); return 0; }
    }
    if (args.mode === "publish" || args.mode === "all") {
      const selectionPath = `content/publication-selections/${batchId}.json`;
      const runId = deriveRunId(await loadManifest(batchId));
      await runNpm("games:pipeline", ["evaluate", "--run-id", runId, "--selection", selectionPath, "--json"]);
      await runNpm("games:pipeline", ["export", "--selection", selectionPath, "--snapshot-date", args.snapshotDate, "--json"]);
      await runNpm("site:data:check", []); await runNpm("typecheck", []); await runNpm("lint", []); await runNpm("build", []);
      await runNpm("games:pipeline", ["preview", "--run-id", runId, "--write"]); await runNpm("games:pipeline", ["publish-ready", "--run-id", runId, "--write"]);
      console.log(JSON.stringify({ mode: args.mode, batchId, runId, status: "published-ready" })); return 0;
    }
  }
  const artifactText = await readFile(resolve("generated/site-data.json"), "utf8");
  const artifact = JSON.parse(artifactText) as { games: unknown[] };
  const excludedIds = new Set(await historicalIds());
  let discovered: Array<{ steamAppId: string; title: string }>;
  try {
    discovered = await discoverTopSellerGames({ apiKey: process.env.STEAM_WEB_API_KEY ?? "", limit: args.count, excludedIds });
  } catch (error) {
    if (error instanceof Error && (error.message === "DISCOVERY_API_GAP" || error.message === "STEAM_API_KEY_SETUP_REQUIRED")) {
      const failure = { version: "v2.11", mode: args.mode, snapshotDate: args.snapshotDate, status: "DISCOVERY_API_GAP", requestedCount: args.count, candidateCount: 0, writes: false };
      console.error(JSON.stringify(failure));
      return 1;
    }
    throw error;
  }
  const candidates = discovered.map((value) => value.steamAppId);
  const manifest = { manifestVersion: "1" as const, pipelineVersion: "2.10" as const, policyVersion: "v2.10-production-1", snapshotDate: args.snapshotDate, items: candidates.map((steamAppId, index) => ({ ordinal: index + 1, steamAppId })) };
  const manifestHash = hashManifest(manifest);
  const manifestPath = `content/manifests/${args.batchId ?? `v2-11-batch-${args.snapshotDate.replaceAll("-", "")}`}.json`;
  if (!args.dryRun && args.mode === "plan") {
    await mkdir(resolve(manifestPath, ".."), { recursive: true });
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  }
  const selection = {
    selectionVersion: "2" as const, pipelineVersion: "2.10" as const, policyVersion: "v2.10-production-1" as const,
    snapshotDate: args.snapshotDate, manifestHash, publicationMode: "incremental" as const,
    baseArtifactSha256: createHash("sha256").update(artifactText).digest("hex"), baseGameCount: artifact.games.length,
    items: candidates.map((steamAppId) => ({ steamAppId, decision: "include" as const })),
  };
  const result = {
    version: "v2.11", mode: args.mode, snapshotDate: args.snapshotDate, batchId,
    requestedCount: args.count,
    candidateCount: candidates.length, candidates: discovered, manifestPath: args.dryRun ? null : manifestPath,
    discovery: { source: "steam-featured-json", code: null, historicalOverlap: 0, duplicateIds: candidates.length - new Set(candidates).size, verifiedGameCount: candidates.length },
    selection: args.mode === "select" ? selection : undefined, dryRun: args.dryRun, writes: false,
  };
  if (args.dryRun) await writeFile("/tmp/gamehub-content-batch-summary.json", JSON.stringify(result) + "\n", "utf8");
  if (!args.dryRun && args.mode !== "plan") throw new Error("execution requires an explicit durable-run implementation; planner is dry-run only");
  if (args.json) console.log(JSON.stringify(result)); else console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then((exitCode) => { process.exitCode = exitCode; }).catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
