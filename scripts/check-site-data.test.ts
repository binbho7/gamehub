import { describe, expect, it } from "vitest";
import { SITE_DATA_VERSION, type PublishedArtifact, type PublishedGame } from "../lib/site-data/contracts";
import { checkSiteData } from "./check-site-data";

const game = (slug: string): PublishedGame => ({
  slug, title: slug, description: "Description", releaseDate: "2026-01-01", status: "released",
  developer: "Developer", publisher: "Publisher", genres: ["Action"], genreSlugs: ["action"], platforms: ["PC"], platformSlugs: ["pc"],
  cover: "https://cdn.akamai.steamstatic.com/cover.jpg", hero: "https://images.igdb.com/hero.jpg", screenshots: [],
  officialLinks: [{ provider: "website", type: "official_website", url: "https://example.com/" }], videos: [],
  optional: { titleCn: null, rating: null, systemRequirements: null, modes: null, controllerSupport: null, isFree: null },
});

const artifact = (games: PublishedGame[] = [game("a")]): PublishedArtifact => ({ version: SITE_DATA_VERSION, snapshotDate: "2026-09-19", games });
const text = (value: unknown) => JSON.stringify(value, null, 2);

describe("tracked site-data checker", () => {
  it("accepts a valid artifact and returns stable diagnostics", async () => {
    const first = await checkSiteData({ readText: async () => text(artifact()) });
    const second = await checkSiteData({ readText: async () => text(artifact()) });
    expect(first).toEqual({ valid: true, diagnostics: [] });
    expect(second).toEqual(first);
  });

  it.each([
    ["missing artifact", undefined],
    ["malformed JSON", "{"],
    ["bad version", text({ ...artifact(), version: 2 })],
    ["bad snapshot date", text({ ...artifact(), snapshotDate: "2026-02-30" })],
    ["forbidden field", text({ ...artifact(), generatedAt: "now" })],
    ["wrong game ordering", text(artifact([game("z"), game("a")]))],
    ["wrong relation ordering", text({ ...artifact(), games: [{ ...game("a"), genres: ["Z", "A"] }] })],
    ["invalid image URL", text({ ...artifact(), games: [{ ...game("a"), cover: "https://evil.example/cover.jpg" }] })],
    ["invalid official link", text({ ...artifact(), games: [{ ...game("a"), officialLinks: [{ provider: "x", type: "official_website", url: "ftp://example.com" }] }] })],
    ["invalid YouTube ID", text({ ...artifact(), games: [{ ...game("a"), videos: [{ provider: "youtube", id: "bad", title: null }] }] })],
  ])("fails closed for %s", async (_label, value) => {
    const result = await checkSiteData({ readText: async () => value });
    expect(result.valid).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("fails closed for oversized and over-count artifacts", async () => {
    const oversized = await checkSiteData({ readText: async () => text({ ...artifact(), games: [{ ...game("a"), description: "x".repeat(10 * 1024 * 1024) }] }) });
    expect(oversized.valid).toBe(false);
    const tooMany = await checkSiteData({ readText: async () => text(artifact(Array.from({ length: 10_001 }, (_, index) => game(`game-${String(index).padStart(5, "0")}`)))) });
    expect(tooMany.valid).toBe(false);
  });

  it("does not touch D1, network, mock data, or wall clock", async () => {
    const originalNow = Date.now;
    Date.now = () => { throw new Error("wall clock access"); };
    try {
      await expect(checkSiteData({ readText: async () => text(artifact()) })).resolves.toEqual({ valid: true, diagnostics: [] });
    } finally {
      Date.now = originalNow;
    }
  });
});
