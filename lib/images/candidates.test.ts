import { describe, expect, it } from "vitest";
import type { ImageGameSnapshot } from "./candidates";
import { resolveImageCandidates } from "./candidates";

const steam = "https://cdn.akamai.steamstatic.com/steam/apps/10";
const igdb = "https://images.igdb.com/igdb/image/upload";

function snapshot(overrides: Partial<ImageGameSnapshot> = {}): ImageGameSnapshot {
  return {
    game: { id: 42, coverUrl: null, heroUrl: null },
    images: [],
    ...overrides,
  };
}

describe("resolveImageCandidates", () => {
  it("orders unique assets as cover, hero, then existing rows by sort order and ID", () => {
    const result = resolveImageCandidates(snapshot({
      game: {
        id: 42,
        coverUrl: `${steam}/cover.jpg`,
        heroUrl: `${igdb}/hero.jpg`,
      },
      images: [
        { id: 8, gameId: 42, type: "artwork", sourceUrl: `${igdb}/artwork.jpg`, sourceProvider: "igdb", width: 1280, height: 720, sortOrder: 2 },
        { id: 4, gameId: 42, type: "screenshot", sourceUrl: `${steam}/second.jpg`, sourceProvider: "steam", width: null, height: null, sortOrder: 1 },
        { id: 3, gameId: 42, type: "screenshot", sourceUrl: `${steam}/first.jpg`, sourceProvider: "steam", width: 1920, height: 1080, sortOrder: 1 },
      ],
    }));

    expect(result.preflight).toBe("ok");
    expect(result.candidates.map((candidate) => [candidate.sourceUrl, candidate.type, candidate.existingId]))
      .toEqual([
        [`${steam}/cover.jpg`, "cover", null],
        [`${igdb}/hero.jpg`, "hero", null],
        [`${steam}/first.jpg`, "screenshot", 3],
        [`${steam}/second.jpg`, "screenshot", 4],
        [`${igdb}/artwork.jpg`, "artwork", 8],
      ]);
  });

  it("reuses an existing screenshot for an equal cover URL without changing its metadata", () => {
    const sourceUrl = `${steam}/shared.jpg`;
    const result = resolveImageCandidates(snapshot({
      game: { id: 42, coverUrl: sourceUrl, heroUrl: null },
      images: [{
        id: 9,
        gameId: 42,
        type: "screenshot",
        sourceUrl,
        sourceProvider: "steam",
        width: 1600,
        height: 900,
        sortOrder: 7,
      }],
    }));

    expect(result.candidates).toEqual([{
      gameId: 42,
      type: "screenshot",
      sourceUrl,
      provider: "steam",
      width: 1600,
      height: 900,
      sortOrder: 7,
      existingId: 9,
    }]);
  });

  it("creates exactly one cover candidate when cover and hero share a new URL", () => {
    const sourceUrl = `${igdb}/shared.jpg`;
    const result = resolveImageCandidates(snapshot({
      game: { id: 42, coverUrl: sourceUrl, heroUrl: sourceUrl },
    }));

    expect(result.candidates).toEqual([expect.objectContaining({
      type: "cover",
      sourceUrl,
      provider: "igdb",
      existingId: null,
    })]);
  });

  it("uses the first stored duplicate without rewriting the later legacy duplicate", () => {
    const sourceUrl = `${steam}/legacy-shared.jpg`;
    const result = resolveImageCandidates(snapshot({
      images: [
        { id: 1, gameId: 42, type: "screenshot", sourceUrl, sourceProvider: "steam", width: 800, height: 450, sortOrder: 0 },
        { id: 2, gameId: 42, type: "artwork", sourceUrl, sourceProvider: "steam", width: 1600, height: 900, sortOrder: 1 },
      ],
    }));

    expect(result.candidates).toEqual([expect.objectContaining({
      existingId: 1,
      type: "screenshot",
      width: 800,
      height: 450,
    })]);
  });

  it("infers a provider for a historical null provenance only when the URL is mapped", () => {
    const result = resolveImageCandidates(snapshot({
      images: [
        { id: 1, gameId: 42, type: "screenshot", sourceUrl: `${igdb}/legacy.jpg`, sourceProvider: null, width: null, height: null, sortOrder: 0 },
        { id: 2, gameId: 42, type: "logo", sourceUrl: "https://example.com/legacy.jpg", sourceProvider: null, width: null, height: null, sortOrder: 1 },
      ],
    }));

    expect(result.candidates).toEqual([expect.objectContaining({ existingId: 1, provider: "igdb" })]);
    expect(result.rejected).toEqual([{ existingId: 2, sourceUrl: "https://example.com/legacy.jpg", outcome: "source_rejected" }]);
  });

  it("rejects a stored provider mismatch instead of inferring a replacement provider", () => {
    const sourceUrl = `${igdb}/wrong-provenance.jpg`;
    const result = resolveImageCandidates(snapshot({
      images: [{ id: 1, gameId: 42, type: "screenshot", sourceUrl, sourceProvider: "steam", width: null, height: null, sortOrder: 0 }],
    }));

    expect(result.candidates).toEqual([]);
    expect(result.rejected).toEqual([{ existingId: 1, sourceUrl, outcome: "source_rejected" }]);
  });

  it("rejects an unknown stored source provider at runtime", () => {
    const sourceUrl = `${steam}/unknown-provider.jpg`;
    const result = resolveImageCandidates(snapshot({
      images: [{
        id: 1,
        gameId: 42,
        type: "screenshot",
        sourceUrl,
        sourceProvider: "origin",
        width: null,
        height: null,
        sortOrder: 0,
      }],
    }));

    expect(result.candidates).toEqual([]);
    expect(result.rejected).toEqual([{ existingId: 1, sourceUrl, outcome: "source_rejected" }]);
  });

  it("accepts exactly 128 deduplicated eligible assets", () => {
    const images = Array.from({ length: 128 }, (_, index) => ({
      id: index + 1,
      gameId: 42,
      type: "screenshot" as const,
      sourceUrl: `${steam}/${index}.jpg`,
      sourceProvider: "steam" as const,
      width: null,
      height: null,
      sortOrder: index,
    }));

    const result = resolveImageCandidates(snapshot({ images }));

    expect(result.preflight).toBe("ok");
    expect(result.candidates).toHaveLength(128);
  });

  it("fails the game preflight when more than 128 deduplicated eligible assets exist", () => {
    const images = Array.from({ length: 129 }, (_, index) => ({
      id: index + 1,
      gameId: 42,
      type: "screenshot" as const,
      sourceUrl: `${steam}/${index}.jpg`,
      sourceProvider: "steam" as const,
      width: null,
      height: null,
      sortOrder: index,
    }));

    const result = resolveImageCandidates(snapshot({ images }));

    expect(result.preflight).toBe("image_limit_exceeded");
    expect(result.candidates).toEqual([]);
  });
});
