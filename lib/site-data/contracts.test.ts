import { describe, expect, it } from "vitest";
import {
  PublishedArtifactSchema,
  SITE_DATA_VERSION,
  PUBLICATION_POLICY_VERSION,
  MAX_ARTIFACT_BYTES,
  MAX_PUBLISHED_GAMES,
} from "./contracts";

const validGame = {
  slug: "example-game",
  title: "Example Game",
  description: "A published game.",
  releaseDate: "2026-01-02",
  status: "released",
  developer: "Example Studio",
  publisher: "Example Publisher",
  genres: ["Action"],
  genreSlugs: ["action"],
  platforms: ["PC"],
  platformSlugs: ["pc"],
  cover: "https://cdn.igdb.com/example-cover.jpg",
  hero: "https://cdn.igdb.com/example-hero.jpg",
  screenshots: [],
  officialLinks: [{ provider: "steam", type: "store", url: "https://store.steampowered.com/app/1" }],
  videos: [{ provider: "youtube", id: "dQw4w9WgXcQ", title: null }],
  optional: {
    titleCn: null,
    rating: null,
    systemRequirements: null,
    modes: null,
    controllerSupport: null,
    isFree: null,
  },
};

describe("published site-data contracts", () => {
  it("accepts a valid public artifact and preserves nullable unavailable fields", () => {
    const artifact = PublishedArtifactSchema.parse({
      version: SITE_DATA_VERSION,
      snapshotDate: "2026-09-19",
      games: [validGame],
    });

    expect(artifact.games[0]?.optional).toEqual({
      titleCn: null,
      rating: null,
      systemRequirements: null,
      modes: null,
      controllerSupport: null,
      isFree: null,
    });
  });

  it("rejects private database and scheduler fields at the public boundary", () => {
    expect(() => PublishedArtifactSchema.parse({
      version: SITE_DATA_VERSION,
      snapshotDate: "2026-09-19",
      games: [{ ...validGame, id: 1, updatedAt: 123 }],
    })).toThrow();
  });

  it("publishes the versioned policy limits", () => {
    expect(SITE_DATA_VERSION).toBe(1);
    expect(PUBLICATION_POLICY_VERSION).toBe(1);
    expect(MAX_ARTIFACT_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_PUBLISHED_GAMES).toBe(10_000);
  });
});
