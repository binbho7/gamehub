export const ITEM_STAGES = ["discover", "import", "enrich", "verify", "images", "evaluate"] as const;
export const RUN_STAGES = ["export", "preview", "publish-ready"] as const;

type RetryClass = "none" | "retryable" | "permanent" | "blocked" | "run_fatal";
type ItemState = "pending" | "running" | "succeeded" | "retryable_failed" | "permanently_failed" | "blocked" | "skipped";
type RunState = Exclude<ItemState, "blocked" | "skipped">;
type Stage = { state: ItemState; attemptCount: number; reasonCode: string | null; retryClass: RetryClass };
type RunStage = Omit<Stage, "state" | "retryClass"> & { state: RunState; retryClass: Exclude<RetryClass, "blocked"> };

export type PipelineReport = {
  reportVersion: "1"; runId: string; manifestHash: string; pipelineVersion: "2.10";
  policyVersion: string; snapshotDate: string;
  lifecycleStatus: "created" | "running" | "paused" | "failed" | "ready";
  currentRunStage: (typeof RUN_STAGES)[number] | null; artifactSha256: string | null;
  runStages: Record<(typeof RUN_STAGES)[number], RunStage>;
  counts: { total: number; discovered: number; imported: number; enriched: number; verified: number; images: number; eligible: number; blocked: number; retryable: number; permanent: number; skipped: number; failed: number };
  items: Array<{ ordinal: number; steamAppId: string; gameId: number | null; slug: string | null; stages: Record<(typeof ITEM_STAGES)[number], Stage> }>;
};

export type PipelineReportInput = Omit<PipelineReport, "counts" | "items"> & {
  items: Array<{ ordinal: number; steamAppId: string; gameId: number | null; slug: string | null; stages: Record<(typeof ITEM_STAGES)[number], Stage> }>;
  [key: string]: unknown;
};

const copyStage = (stage: Stage): Stage => ({ state: stage.state, attemptCount: stage.attemptCount, reasonCode: stage.reasonCode, retryClass: stage.retryClass });

const REDACTED = "[REDACTED]";
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const safeToken = (value: string, pattern = SAFE_TOKEN): string => pattern.test(value) ? value : REDACTED;
const safeSteamAppId = (value: string): string => safeToken(value, /^[1-9][0-9]*$/);
const canonicalSteamAppIdSortKey = (value: string): string => /^[1-9][0-9]*$/.test(value) ? `valid:${value}` : `malformed:${value}`;
const comparePrivateSortKeys = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const safeReason = (value: string | null): string | null => value === null ? null : safeToken(value, /^[a-z][a-z0-9_]{0,63}$/);
const safeSlug = (value: string | null): string | null => value === null ? null : safeToken(value, /^[a-z0-9][a-z0-9-]{0,127}$/);
const ITEM_STATES: readonly ItemState[] = ["pending", "running", "succeeded", "retryable_failed", "permanently_failed", "blocked", "skipped"];
const RETRY_CLASSES: readonly RetryClass[] = ["none", "retryable", "permanent", "blocked", "run_fatal"];
const LIFECYCLE_STATUSES = ["created", "running", "paused", "failed", "ready"] as const;
const isExactDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && (() => {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
})();
const assertReportInput = (input: PipelineReportInput): void => {
  if (input.reportVersion !== "1") throw new Error("invalid report version");
  if (input.pipelineVersion !== "2.10") throw new Error("invalid pipeline version");
  if (!isExactDate(input.snapshotDate)) throw new Error("invalid snapshot date");
  if (!(LIFECYCLE_STATUSES as readonly string[]).includes(input.lifecycleStatus)) throw new Error("invalid lifecycle status");
  if (input.currentRunStage !== null && !(RUN_STAGES as readonly string[]).includes(input.currentRunStage)) throw new Error("invalid current run stage");
  for (const stage of RUN_STAGES) {
    const value = input.runStages[stage];
    if (!value || !["pending", "running", "succeeded", "retryable_failed", "permanently_failed"].includes(value.state)) throw new Error("invalid run stage state");
    if (!(["none", "retryable", "permanent", "run_fatal"] as readonly string[]).includes(value.retryClass)) throw new Error("invalid run stage retry class");
  }
  for (const item of input.items) {
    if (!Number.isSafeInteger(item.gameId) && item.gameId !== null || (typeof item.gameId === "number" && item.gameId <= 0)) throw new Error("invalid game ID");
    for (const stage of ITEM_STAGES) {
      if (!ITEM_STATES.includes(item.stages[stage].state)) throw new Error("invalid item state");
      if (!RETRY_CLASSES.includes(item.stages[stage].retryClass)) throw new Error("invalid item retry class");
    }
  }
};

export function buildPipelineReport(input: PipelineReportInput): PipelineReport {
  assertReportInput(input);
  const items = [...input.items].sort((a, b) => a.ordinal - b.ordinal || (a.gameId === null ? 1 : b.gameId === null ? -1 : a.gameId - b.gameId) || comparePrivateSortKeys(canonicalSteamAppIdSortKey(a.steamAppId), canonicalSteamAppIdSortKey(b.steamAppId))).map((item) => ({
    ordinal: item.ordinal, steamAppId: safeSteamAppId(item.steamAppId), gameId: item.gameId, slug: safeSlug(item.slug),
    stages: Object.fromEntries(ITEM_STAGES.map((stage) => {
      const copied = copyStage(item.stages[stage]);
      return [stage, { ...copied, reasonCode: safeReason(copied.reasonCode) }];
    })) as PipelineReport["items"][number]["stages"],
  }));
  const count = (stage: typeof ITEM_STAGES[number], state: ItemState) => items.filter((item) => item.stages[stage].state === state).length;
  const report: PipelineReport = {
    reportVersion: input.reportVersion, runId: safeToken(input.runId), manifestHash: safeToken(input.manifestHash), pipelineVersion: input.pipelineVersion,
    policyVersion: safeToken(input.policyVersion), snapshotDate: input.snapshotDate, lifecycleStatus: input.lifecycleStatus, currentRunStage: input.currentRunStage,
    artifactSha256: input.artifactSha256 === null ? null : safeToken(input.artifactSha256),
    runStages: Object.fromEntries(RUN_STAGES.map((stage) => [stage, { state: input.runStages[stage].state, attemptCount: input.runStages[stage].attemptCount, reasonCode: safeReason(input.runStages[stage].reasonCode), retryClass: input.runStages[stage].retryClass }])) as PipelineReport["runStages"],
    counts: {
      total: items.length, discovered: count("discover", "succeeded"), imported: count("import", "succeeded"), enriched: count("enrich", "succeeded"), verified: count("verify", "succeeded"), images: count("images", "succeeded"), eligible: count("evaluate", "succeeded"), blocked: items.filter((item) => Object.values(item.stages).some((stage) => stage.state === "blocked" || stage.retryClass === "blocked")).length,
      retryable: items.filter((item) => Object.values(item.stages).some((stage) => stage.retryClass === "retryable")).length,
      permanent: items.filter((item) => Object.values(item.stages).some((stage) => stage.retryClass === "permanent")).length,
      skipped: items.filter((item) => Object.values(item.stages).some((stage) => stage.state === "skipped")).length,
      failed: items.filter((item) => Object.values(item.stages).some((stage) => stage.retryClass === "run_fatal")).length,
    }, items,
  };
  return report;
}

export const serializePipelineReport = (report: PipelineReport): string => JSON.stringify(report);

export function presentPipelineReport(report: PipelineReport): string {
  const lines = [`Pipeline report ${safeToken(report.runId)}`, `status=${safeToken(report.lifecycleStatus)} stage=${report.currentRunStage === null ? "none" : safeToken(report.currentRunStage)}`, `artifactSha256=${report.artifactSha256 === null ? "none" : safeToken(report.artifactSha256)}`, `counts=${JSON.stringify(report.counts)}`];
  for (const item of report.items) lines.push(`${item.ordinal}. steamAppId=${safeSteamAppId(item.steamAppId)} gameId=${item.gameId ?? "none"} slug=${safeSlug(item.slug) ?? "none"}`);
  return lines.join("\n");
}
