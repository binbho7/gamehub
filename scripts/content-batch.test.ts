import { describe, expect, it } from "vitest";
import { assertEligibleCandidates, assertSelectionHasEligibleCandidates, deriveSafePipelineSummary } from "./content-batch";
import type { PipelineReport } from "../lib/pipeline/report";

const stage = (state: "succeeded" | "blocked" | "permanently_failed", reasonCode: string | null, retryClass: "none" | "blocked" | "permanent") => ({ state, attemptCount: 1, reasonCode, retryClass });
const report = (items: PipelineReport["items"]): PipelineReport => ({
  reportVersion: "1", runId: "run-1", manifestHash: "a".repeat(64), pipelineVersion: "2.10", policyVersion: "policy", snapshotDate: "2026-10-05", lifecycleStatus: "failed", currentRunStage: null, artifactSha256: null,
  runStages: {
    export: { state: "pending", attemptCount: 0, reasonCode: null, retryClass: "none" },
    preview: { state: "pending", attemptCount: 0, reasonCode: null, retryClass: "none" },
    "publish-ready": { state: "pending", attemptCount: 0, reasonCode: null, retryClass: "none" },
  },
  counts: { total: items.length, discovered: 0, imported: 0, enriched: 0, verified: 0, images: 0, eligible: items.filter((item) => item.stages.evaluate.state === "succeeded").length, blocked: 0, retryable: 0, permanent: 0, skipped: 0, failed: 0 },
  items,
});
const item = (ordinal: number, evaluate: ReturnType<typeof stage>, images = stage("succeeded", null, "none"), enrich = stage("succeeded", null, "none")): PipelineReport["items"][number] => ({
  ordinal, steamAppId: String(ordinal), gameId: ordinal, slug: `game-${ordinal}`,
  stages: { discover: stage("succeeded", null, "none"), import: stage("succeeded", null, "none"), enrich, verify: stage("succeeded", null, "none"), images, evaluate },
});

describe("content batch safe pipeline diagnostics", () => {
  it("reports mixed durable states with deterministic stage failure aggregation", () => {
    const summary = deriveSafePipelineSummary("batch", "run", report([
      item(1, stage("blocked", "evaluation_ineligible", "blocked"), stage("blocked", "source_rejected", "blocked")),
      item(2, stage("blocked", "evaluation_ineligible", "blocked"), stage("blocked", "source_rejected", "blocked")),
      item(3, stage("blocked", "evaluation_ineligible", "blocked"), stage("blocked", "source_rejected", "blocked"), stage("permanently_failed", "mapping_not_found", "permanent")),
    ]), [
      { steamAppId: "1", decision: "exclude", reason: "blocked" },
      { steamAppId: "2", decision: "exclude", reason: "blocked" },
      { steamAppId: "3", decision: "exclude", reason: "blocked" },
    ]);
    expect(summary.includeCount).toBe(0);
    expect(summary.excludeCount).toBe(3);
    expect(summary.stageFailures).toEqual([
      { stage: "enrich", state: "permanently_failed", reasonCode: "mapping_not_found", retryClass: "permanent", count: 1 },
      { stage: "evaluate", state: "blocked", reasonCode: "evaluation_ineligible", retryClass: "blocked", count: 3 },
      { stage: "images", state: "blocked", reasonCode: "source_rejected", retryClass: "blocked", count: 3 },
    ]);
  });

  it("includes every item whose durable evaluate state succeeded", () => {
    const summary = deriveSafePipelineSummary("batch", "run", report([item(1, stage("succeeded", null, "none")), item(2, stage("succeeded", null, "none"))]), [
      { steamAppId: "1", decision: "include" }, { steamAppId: "2", decision: "include" },
    ]);
    expect(summary.includeCount).toBe(2);
    expect(summary.excludeCount).toBe(0);
    expect(() => assertEligibleCandidates(summary)).not.toThrow();
  });

  it("fails before export when all items are excluded", () => {
    const summary = deriveSafePipelineSummary("batch", "run", report([item(1, stage("blocked", "evaluation_ineligible", "blocked"))]), [{ steamAppId: "1", decision: "exclude", reason: "blocked" }]);
    expect(() => assertEligibleCandidates(summary)).toThrow("NO_ELIGIBLE_CANDIDATES");
  });

  it("rejects direct publish selections with no included items", () => {
    expect(() => assertSelectionHasEligibleCandidates({ items: [{ steamAppId: "1", decision: "exclude" }] })).toThrow("NO_ELIGIBLE_CANDIDATES");
    expect(() => assertSelectionHasEligibleCandidates({ items: [{ steamAppId: "1", decision: "include" }] })).not.toThrow();
  });

  it("contains only sanitized durable summary fields", () => {
    const summary = deriveSafePipelineSummary("batch", "run", report([item(1, stage("blocked", "evaluation_ineligible", "blocked"))]), [{ steamAppId: "1", decision: "exclude", reason: "blocked" }]);
    expect(Object.keys(summary)).toEqual(["batchId", "runId", "counts", "stageFailures", "includeCount", "excludeCount"]);
    expect(JSON.stringify(summary)).not.toMatch(/secret|token|header|http|title|description|url|path/i);
  });
});
