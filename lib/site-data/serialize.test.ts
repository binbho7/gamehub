import { describe, expect, it } from "vitest";
import { MAX_ARTIFACT_BYTES, MAX_PUBLISHED_GAMES, SITE_DATA_VERSION, type PublishedArtifact, type PublishedGame } from "./contracts";
import { assertArtifactLimits, serializeArtifact } from "./serialize";

const game = (slug: string): PublishedGame => ({
  slug, title: slug, description: "Description", releaseDate: "2026-01-01", status: "released",
  developer: "Developer", publisher: "Publisher", genres: ["Z", "A"], genreSlugs: ["z", "a"], platforms: ["PC"], platformSlugs: ["pc"],
  cover: "https://cdn.akamai.steamstatic.com/cover.jpg", hero: "https://images.igdb.com/hero.jpg", screenshots: [],
  officialLinks: [{ provider: "z", type: "store", url: "https://example.com/z" }, { provider: "a", type: "official_website", url: "https://example.com/a" }],
  videos: [{ provider: "youtube", id: "bbbbbbbbbbb", title: null }, { provider: "youtube", id: "aaaaaaaaaaa", title: null }],
  optional: { titleCn: null, rating: null, systemRequirements: null, modes: null, controllerSupport: null, isFree: null },
});

const artifact = (games: PublishedGame[] = [game("z"), game("a")]): PublishedArtifact => ({ version: SITE_DATA_VERSION, snapshotDate: "2026-09-19", games });

describe("stable site-data serialization", () => {
  it("is byte-identical, pretty, sorted, and newline-terminated", () => {
    const first = serializeArtifact(artifact());
    const second = serializeArtifact(artifact());
    expect(first).toBe(second);
    expect(first.endsWith("\n")).toBe(true);
    expect(first).toContain("\n  \"games\": [");
    expect(first.indexOf('"slug": "a"')).toBeLessThan(first.indexOf('"slug": "z"'));
    expect(first).toContain('"id": "aaaaaaaaaaa"');
  });

  it("enforces UTF-8 byte and published-game ceilings", () => {
    expect(() => assertArtifactLimits("x".repeat(MAX_ARTIFACT_BYTES), 0)).not.toThrow();
    expect(() => assertArtifactLimits("x".repeat(MAX_ARTIFACT_BYTES + 1), 0)).toThrow();
    expect(() => assertArtifactLimits("{}", MAX_PUBLISHED_GAMES)).not.toThrow();
    expect(() => assertArtifactLimits("{}", MAX_PUBLISHED_GAMES + 1)).toThrow();
  });

  it("does not add wall-clock or forbidden operational fields", () => {
    const serialized = serializeArtifact(artifact([game("a")]));
    expect(serialized).not.toMatch(/createdAt|updatedAt|generatedAt|storageKey|providerPayload|scheduler/);
  });

  it("rejects forbidden artifact fields through the validation boundary", () => {
    const forbidden = { ...artifact([game("a")]), generatedAt: "2026-09-19T00:00:00Z" };
    expect(() => serializeArtifact(forbidden as unknown as PublishedArtifact)).toThrow();
  });
});
