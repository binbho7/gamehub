import { describe, expect, it } from "vitest";
import {
  buildPipelineReport,
  presentPipelineReport,
  serializePipelineReport,
  type PipelineReportInput,
} from "./report";

const fixture = (reverse = false): PipelineReportInput => ({
  reportVersion: "1",
  runId: "run-abc",
  manifestHash: "a".repeat(64),
  pipelineVersion: "2.10",
  policyVersion: "policy-1",
  snapshotDate: "2026-09-19",
  lifecycleStatus: "ready",
  currentRunStage: null,
  artifactSha256: "b".repeat(64),
  runStages: {
    export: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" },
    preview: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" },
    "publish-ready": { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" },
  },
  items: (reverse ? [2, 1] : [1, 2]).map((ordinal) => ({
    ordinal,
    steamAppId: ordinal === 1 ? "10" : "20",
    gameId: ordinal === 1 ? 7 : null,
    slug: ordinal === 1 ? "safe-game" : null,
    stages: {
      discover: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" },
      import: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" },
      enrich: { state: ordinal === 1 ? "succeeded" : "retryable_failed", attemptCount: 1, reasonCode: ordinal === 1 ? null : "provider_unavailable", retryClass: ordinal === 1 ? "none" : "retryable" },
      verify: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" },
      images: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" },
      evaluate: { state: ordinal === 1 ? "succeeded" : "blocked", attemptCount: 1, reasonCode: ordinal === 1 ? null : "missing_required_metadata", retryClass: ordinal === 1 ? "none" : "blocked" },
    },
  })),
});

describe("deterministic pipeline reports", () => {
  it("emits the exact safe schema with canonical item and stage ordering", () => {
    const report = buildPipelineReport(fixture(true));
    expect(Object.keys(report)).toEqual(["reportVersion", "runId", "manifestHash", "pipelineVersion", "policyVersion", "snapshotDate", "lifecycleStatus", "currentRunStage", "artifactSha256", "runStages", "counts", "items"]);
    expect(Object.keys(report.runStages)).toEqual(["export", "preview", "publish-ready"]);
    expect(report.items.map((item) => item.ordinal)).toEqual([1, 2]);
    expect(Object.keys(report.items[0].stages)).toEqual(["discover", "import", "enrich", "verify", "images", "evaluate"]);
    expect(report.counts).toEqual({ total: 2, discovered: 2, imported: 2, enriched: 1, verified: 2, images: 2, eligible: 1, blocked: 1, retryable: 1, permanent: 0, skipped: 0, failed: 0 });
  });

  it("counts only durable skipped item stages, never pending stages", () => {
    const input = fixture();
    input.items[1].stages.enrich = { state: "permanently_failed", attemptCount: 1, reasonCode: "provider_failed", retryClass: "permanent" };
    input.items[1].stages.verify = { state: "skipped", attemptCount: 0, reasonCode: "blocked_by_enrich", retryClass: "none" };
    input.items[1].stages.images = { state: "skipped", attemptCount: 0, reasonCode: "blocked_by_enrich", retryClass: "none" };
    input.items[1].stages.evaluate = { state: "skipped", attemptCount: 0, reasonCode: "blocked_by_enrich", retryClass: "none" };
    expect(buildPipelineReport(input).counts.skipped).toBe(1);
  });

  it("redacts unsafe accepted fields and rejects control injection in human output", () => {
    const input = fixture();
    input.runId = "run\nSECRET /private/path";
    input.policyVersion = "policy\tSECRET";
    input.items[0].steamAppId = "10\nSECRET";
    input.items[0].slug = "safe\rSECRET";
    input.items[1].stages.enrich.reasonCode = "raw-error\nSECRET";
    const report = buildPipelineReport(input);
    expect(JSON.stringify(report)).not.toMatch(/SECRET|private\/path/);
    expect(() => presentPipelineReport(report)).not.toThrow();
    expect(presentPipelineReport(report)).not.toMatch(/[\r\n].*SECRET/);
  });

  it("sorts reason diagnostics deterministically and omits unsafe input fields", () => {
    const report = buildPipelineReport({ ...fixture(), unsafeError: "secret", path: "/tmp/private", token: "bearer" });
    expect(report.items[1].stages.enrich.reasonCode).toBe("provider_unavailable");
    expect(JSON.stringify(report)).not.toMatch(/secret|private|bearer|timestamp|r2|lease|stack/i);
  });

  it("preserves retry exhaustion as a stable sanitized run-stage reason", () => {
    const input = fixture();
    input.lifecycleStatus = "failed";
    input.currentRunStage = "preview";
    input.runStages.preview = { state: "permanently_failed", attemptCount: 3, reasonCode: "retry_exhausted", retryClass: "run_fatal" };
    const report = buildPipelineReport(input);
    expect(report.runStages.preview).toEqual({ state: "permanently_failed", attemptCount: 3, reasonCode: "retry_exhausted", retryClass: "run_fatal" });
    expect(serializePipelineReport(report)).toContain('"reasonCode":"retry_exhausted"');
    expect(presentPipelineReport(report)).not.toContain("Error");
  });

  it("produces byte-identical JSON and stable human-readable output", () => {
    const first = buildPipelineReport(fixture());
    const second = buildPipelineReport(fixture(true));
    expect(serializePipelineReport(first)).toBe(serializePipelineReport(second));
    expect(presentPipelineReport(first)).toBe(presentPipelineReport(second));
    expect(presentPipelineReport(first)).toContain("run-abc");
  });

  it("sorts equal ordinals by canonical game ID with a deterministic nullable fallback", () => {
    const input = fixture();
    input.items = [
      { ...input.items[0], ordinal: 1, gameId: 20, steamAppId: "20" },
      { ...input.items[1], ordinal: 1, gameId: 10, steamAppId: "10" },
      { ...input.items[1], ordinal: 1, gameId: null, steamAppId: "30" },
    ];
    expect(buildPipelineReport(input).items.map(({ gameId, steamAppId }) => [gameId, steamAppId])).toEqual([[10, "10"], [20, "20"], [null, "30"]]);
  });

  it("sorts malformed Steam IDs by a private canonical key without emitting it", () => {
    const items = [
      { ...fixture().items[0], ordinal: 1, gameId: 7, steamAppId: "bad-z" },
      { ...fixture().items[1], ordinal: 1, gameId: 7, steamAppId: "bad-a" },
    ];
    const first = buildPipelineReport({ ...fixture(), items });
    const second = buildPipelineReport({ ...fixture(), items: [...items].reverse() });

    expect(serializePipelineReport(first)).toBe(serializePipelineReport(second));
    expect(first.items.map((item) => item.steamAppId)).toEqual(["[REDACTED]", "[REDACTED]"]);
    expect(serializePipelineReport(first)).not.toMatch(/bad-[az]/);
  });

  it("rejects skipped and invalid run-stage state or retry enums", () => {
    const input = fixture();
    expect(() => buildPipelineReport({ ...input, runStages: { ...input.runStages, export: { ...input.runStages.export, state: "skipped" as never } } })).toThrow("invalid run stage state");
    expect(() => buildPipelineReport({ ...input, runStages: { ...input.runStages, export: { ...input.runStages.export, retryClass: "blocked" as never } } })).toThrow("invalid run stage retry class");
  });

  it.each([
    ["reportVersion", { reportVersion: "1.0" }],
    ["pipelineVersion", { pipelineVersion: "2.9" }],
    ["snapshotDate", { snapshotDate: "2026-02-30" }],
    ["lifecycleStatus", { lifecycleStatus: "unknown" }],
    ["currentRunStage", { currentRunStage: "unknown" }],
    ["item state", { itemState: "unknown" }],
    ["item retry class", { itemRetryClass: "unknown" }],
    ["gameId", { gameId: 0 }],
  ])("rejects invalid %s at the report boundary", (_name, change) => {
    const input = fixture();
    if ("itemState" in change) input.items[0].stages.discover.state = change.itemState as never;
    else if ("itemRetryClass" in change) input.items[0].stages.discover.retryClass = change.itemRetryClass as never;
    else if ("gameId" in change) input.items[0].gameId = change.gameId as never;
    else Object.assign(input, change);
    expect(() => buildPipelineReport(input)).toThrow();
  });
});
