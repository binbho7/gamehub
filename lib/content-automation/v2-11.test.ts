import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  mergeIncrementalArtifact,
  parseIncrementalSelection,
  scanHistoricalManifestIds,
  type IncrementalSelection,
} from "./v2-11";

const game = (slug: string) => ({
  slug, title: slug, description: "Description", releaseDate: "2026-10-04", status: "released" as const,
  developer: "Developer", publisher: "Publisher", genres: ["Action"], genreSlugs: ["action"],
  platforms: ["Windows"], platformSlugs: ["windows"], cover: "https://cdn.example.com/cover.jpg",
  hero: "https://cdn.example.com/hero.jpg", screenshots: [],
  officialLinks: [{ provider: "website", type: "official_website", url: "https://example.com/game" }],
  videos: [], optional: { titleCn: null, rating: null, systemRequirements: null, modes: null, controllerSupport: null, isFree: null },
});

const base = { version: 1, snapshotDate: "2026-10-03", games: [game("baseline")] };
const baseSerialized = JSON.stringify(base) + "\n";
const baseSha = createHash("sha256").update(baseSerialized).digest("hex");

function selection(overrides: Partial<IncrementalSelection> = {}): IncrementalSelection {
  return {
    selectionVersion: "2", pipelineVersion: "2.10", policyVersion: "v2.10-production-1",
    snapshotDate: "2026-10-04", manifestHash: "a".repeat(64), publicationMode: "incremental",
    baseArtifactSha256: baseSha, baseGameCount: 1,
    items: [{ steamAppId: "2", decision: "include" }], ...overrides,
  };
}

describe("V2.11 incremental publication foundation", () => {
  it("accepts strict selection version 2 and rejects unknown fields", () => {
    expect(parseIncrementalSelection(selection())).toMatchObject({ publicationMode: "incremental", baseGameCount: 1 });
    expect(() => parseIncrementalSelection({ ...selection(), unexpected: true })).toThrow();
  });

  it("rejects a base artifact hash or count mismatch", () => {
    expect(() => mergeIncrementalArtifact(base, baseSha.replace(/^./, "b"), selection())).toThrow(/base artifact/i);
    expect(() => mergeIncrementalArtifact(base, baseSha, selection({ baseGameCount: 2 }))).toThrow(/base game count/i);
  });

  it("preserves baseline games and merges included games deterministically", () => {
    const result = mergeIncrementalArtifact(base, baseSha, selection(), [game("new-game")] as never);
    expect(result.games.map((value) => value.slug)).toEqual(["baseline", "new-game"]);
    expect(result.snapshotDate).toBe("2026-10-04");
  });

  it("rejects slug collisions with the baseline", () => {
    expect(() => mergeIncrementalArtifact(base, baseSha, selection(), [game("baseline")] as never)).toThrow(/slug collision/i);
  });

  it("unions historical manifest IDs and removes duplicates", () => {
    const result = scanHistoricalManifestIds([
      { items: [{ steamAppId: "2" }, { steamAppId: "1" }] },
      { items: [{ steamAppId: "1" }, { steamAppId: "3" }] },
    ]);
    expect(result).toEqual(["1", "2", "3"]);
  });
});
