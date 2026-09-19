import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { games as fixtureGames } from "../mock-data";
import { loadFixtureArtifact } from "./fixture-source";
import { loadPublishedArtifact } from "./source";

const valid = JSON.stringify({
  version: 1,
  snapshotDate: "2026-09-19",
  games: [{ slug: "a", title: "A", description: "D", releaseDate: "2026-01-01", status: "released", developer: "D", publisher: "P", genres: ["Action"], genreSlugs: ["action"], platforms: ["PC"], platformSlugs: ["pc"], cover: "https://cdn.akamai.steamstatic.com/a.jpg", hero: "https://images.igdb.com/a.jpg", screenshots: [], officialLinks: [{ provider: "website", type: "official_website", url: "https://example.com/" }], videos: [], optional: { titleCn: null, rating: null, systemRequirements: null, modes: null, controllerSupport: null, isFree: null } }],
});

describe("published data source boundary", () => {
  it("loads and validates a tracked artifact", async () => {
    await expect(loadPublishedArtifact({ readText: async () => valid })).resolves.toMatchObject({ version: 1, games: [{ slug: "a" }] });
  });

  it.each([undefined, "{", valid.replace('"version":1', '"version":2')])("fails closed for missing or invalid artifact %j", async (text) => {
    await expect(loadPublishedArtifact({ readText: async () => text })).rejects.toThrow();
  });

  it("uses fixture data only through explicit fixture loader", async () => {
    const loaded = await loadFixtureArtifact();
    expect(loaded).toBe(fixtureGames);
    expect(loaded.length).toBeGreaterThan(0);
  });

  it("production source has no mock, D1, Wrangler, network, or wall-clock imports", async () => {
    const source = await readFile(new URL("./source.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/mock-data|db\/|wrangler|fetch\(|Date\.now|new Date/);
  });
});
