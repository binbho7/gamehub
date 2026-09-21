import { describe, expect, it } from "vitest";
import { hashManifest } from "./canonical";
import { type InputManifest, type PublicationSelection } from "./contracts";
import { evaluatePublicationSelection } from "./publication";
import type { RunSnapshot } from "./run-repository";
import type { SiteSnapshotGame } from "../site-data/read-model";

const manifest: InputManifest = {
  manifestVersion: "1", pipelineVersion: "2.10", policyVersion: "v2.10-production-1", snapshotDate: "2026-09-19",
  items: [{ ordinal: 1, steamAppId: "10" }, { ordinal: 2, steamAppId: "20" }],
};
const selection: PublicationSelection = {
  selectionVersion: "1", pipelineVersion: "2.10", policyVersion: manifest.policyVersion,
  snapshotDate: manifest.snapshotDate, manifestHash: hashManifest(manifest),
  items: [{ steamAppId: "10", decision: "include" }, { steamAppId: "20", decision: "exclude" }],
};
const game = (id: number, steamAppId: string, slug: string): SiteSnapshotGame => ({
  game: { id, slug, title: "Title", summary: null, description: "Description", status: "released", releaseDate: "2020-01-01", coverUrl: "https://images.igdb.com/cover.jpg", heroUrl: "https://images.igdb.com/hero.jpg" },
  externalIds: [{ id: id, gameId: id, provider: "steam", externalId: steamAppId, externalUrl: null }],
  companies: [{ id, gameId: id, slug: "studio", name: "Studio", websiteUrl: null, role: "developer" }, { id: id + 10, gameId: id, slug: "publisher", name: "Publisher", websiteUrl: null, role: "publisher" }],
  genres: [{ id, slug: "action", name: "Action" }], platforms: [{ id, slug: "pc", name: "PC" }],
  images: [], officialLinks: [{ id, gameId: id, provider: "steam", platform: "pc", linkType: "official_website", url: "https://example.com", region: null, isOfficial: true, verificationStatus: "verified", verificationMethod: "manual" }], videos: [],
});
const snapshot = (evaluateState: "succeeded" | "pending" = "succeeded"): RunSnapshot => ({
  run: { run_id: `pipeline-v2.10:${hashManifest(manifest)}`, manifest_hash: hashManifest(manifest), pipeline_version: "2.10", policy_version: manifest.policyVersion, snapshot_date: manifest.snapshotDate, status: "running", current_stage: null, run_stage_states_json: JSON.stringify({ export: { state: "pending", attemptCount: 0, reasonCode: null, retryClass: "none" }, preview: { state: "pending", attemptCount: 0, reasonCode: null, retryClass: "none" }, "publish-ready": { state: "pending", attemptCount: 0, reasonCode: null, retryClass: "none" } }), artifact_sha256: null, created_at: 1, updated_at: 1 },
  items: [
    { run_id: `pipeline-v2.10:${hashManifest(manifest)}`, ordinal: 1, steam_app_id: "10", game_id: 1, current_stage: "evaluate", current_state: evaluateState, attempt_count: evaluateState === "succeeded" ? 1 : 0, stage_states_json: JSON.stringify({ discover: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" }, import: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" }, enrich: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" }, verify: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" }, images: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" }, evaluate: { state: evaluateState, attemptCount: evaluateState === "succeeded" ? 1 : 0, reasonCode: null, retryClass: evaluateState === "succeeded" ? "none" : "retryable" } }), reason_code: null, retry_class: evaluateState === "succeeded" ? "none" : "retryable", updated_at: 1 },
    { run_id: `pipeline-v2.10:${hashManifest(manifest)}`, ordinal: 2, steam_app_id: "20", game_id: 2, current_stage: "evaluate", current_state: "succeeded", attempt_count: 1, stage_states_json: JSON.stringify({ discover: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" }, import: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" }, enrich: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" }, verify: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" }, images: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" }, evaluate: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" } }), reason_code: null, retry_class: "none", updated_at: 1 },
  ],
});

describe("V2.10 publication selection gate", () => {
  it("admits only included IDs with durable evaluation success and excludes never enter artifacts", () => {
    const result = evaluatePublicationSelection({ snapshot: snapshot(), selection, candidates: [game(1, "10", "included"), game(2, "20", "excluded")] });
    expect(result.admitted).toBe(true);
    expect(result.artifactGames.map((value) => value.slug)).toEqual(["included"]);
    expect(result.excluded.map((value) => value.steamAppId)).toEqual(["20"]);
  });

  it("fails closed for a missing durable evaluate result", () => {
    const result = evaluatePublicationSelection({ snapshot: snapshot("pending"), selection, candidates: [game(1, "10", "included")] });
    expect(result.admitted).toBe(false);
    expect(result.diagnostics.map((value) => value.code)).toContain("evaluate_not_succeeded");
  });
});
