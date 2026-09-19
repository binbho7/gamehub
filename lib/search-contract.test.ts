import { describe, expect, it } from "vitest";
import { toGameBrowseRecord } from "./search-contract";

const published = {
  slug: "game", title: "Game", description: "private", releaseDate: "2026-01-01", status: "released" as const,
  developer: "Dev", publisher: "Pub", genres: ["Action"], genreSlugs: ["action"], platforms: ["Windows"], platformSlugs: ["windows"],
  cover: "https://cdn.akamai.steamstatic.com/a.jpg", hero: "https://images.igdb.com/a.jpg", screenshots: ["https://images.igdb.com/s.jpg"],
  officialLinks: [{ provider: "website", type: "official_website", url: "https://example.com/" }], videos: [],
  optional: { titleCn: null, rating: null, systemRequirements: null, modes: null, controllerSupport: null, isFree: null },
};

describe("browse contract", () => {
  it("projects only fields needed by library/search clients", () => {
    const browse = toGameBrowseRecord(published);
    expect(browse).toEqual({ slug: "game", title: "Game", developer: "Dev", publisher: "Pub", releaseDate: "2026-01-01", status: "released", cover: published.cover, genres: ["Action"], genreSlugs: ["action"], platforms: ["Windows"], platformSlugs: ["windows"] });
    expect(browse).not.toHaveProperty("description");
    expect(browse).not.toHaveProperty("hero");
    expect(browse).not.toHaveProperty("screenshots");
    expect(browse).not.toHaveProperty("officialLinks");
    expect(browse).not.toHaveProperty("videos");
    expect(browse).not.toHaveProperty("optional");
  });
});
