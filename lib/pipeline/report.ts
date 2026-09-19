export const ITEM_STAGES = ["discover", "import", "enrich", "verify", "images", "evaluate"] as const;
export const RUN_STAGES = ["export", "preview", "publish-ready"] as const;

type RetryClass = "none" | "retryable" | "permanent" | "blocked" | "run_fatal";
type ItemState = "pending" | "running" | "succeeded" | "retryable_failed" | "permanently_failed" | "blocked";
type RunState = Exclude<ItemState, "blocked">;
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

export function buildPipelineReport(input: PipelineReportInput): PipelineReport {
  const items = [...input.items].sort((a, b) => a.ordinal - b.ordinal).map((item) => ({
    ordinal: item.ordinal, steamAppId: item.steamAppId, gameId: item.gameId, slug: item.slug,
    stages: Object.fromEntries(ITEM_STAGES.map((stage) => [stage, copyStage(item.stages[stage])])) as PipelineReport["items"][number]["stages"],
  }));
  const count = (stage: typeof ITEM_STAGES[number], state: ItemState) => items.filter((item) => item.stages[stage].state === state).length;
  const report: PipelineReport = {
    reportVersion: input.reportVersion, runId: input.runId, manifestHash: input.manifestHash, pipelineVersion: input.pipelineVersion,
    policyVersion: input.policyVersion, snapshotDate: input.snapshotDate, lifecycleStatus: input.lifecycleStatus, currentRunStage: input.currentRunStage,
    artifactSha256: input.artifactSha256,
    runStages: Object.fromEntries(RUN_STAGES.map((stage) => [stage, { state: input.runStages[stage].state, attemptCount: input.runStages[stage].attemptCount, reasonCode: input.runStages[stage].reasonCode, retryClass: input.runStages[stage].retryClass }])) as PipelineReport["runStages"],
    counts: {
      total: items.length, discovered: count("discover", "succeeded"), imported: count("import", "succeeded"), enriched: count("enrich", "succeeded"), verified: count("verify", "succeeded"), images: count("images", "succeeded"), eligible: count("evaluate", "succeeded"), blocked: items.filter((item) => item.stages.evaluate.state === "blocked").length,
      retryable: items.filter((item) => Object.values(item.stages).some((stage) => stage.retryClass === "retryable")).length,
      permanent: items.filter((item) => Object.values(item.stages).some((stage) => stage.retryClass === "permanent")).length,
      skipped: items.filter((item) => Object.values(item.stages).some((stage) => stage.state === "pending")).length,
      failed: items.filter((item) => Object.values(item.stages).some((stage) => stage.retryClass === "run_fatal")).length,
    }, items,
  };
  return report;
}

export const serializePipelineReport = (report: PipelineReport): string => JSON.stringify(report);

export function presentPipelineReport(report: PipelineReport): string {
  const lines = [`Pipeline report ${report.runId}`, `status=${report.lifecycleStatus} stage=${report.currentRunStage ?? "none"}`, `artifactSha256=${report.artifactSha256 ?? "none"}`, `counts=${JSON.stringify(report.counts)}`];
  for (const item of report.items) lines.push(`${item.ordinal}. steamAppId=${item.steamAppId} gameId=${item.gameId ?? "none"} slug=${item.slug ?? "none"}`);
  return lines.join("\n");
}
