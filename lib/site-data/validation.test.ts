import { describe, expect, it } from "vitest";
import {
  parseSnapshotDate,
  validateArtifact,
  validateImageUrl,
  validateOfficialLinkUrl,
  validatePublicUrl,
  validateYoutubeId,
} from "./validation";
import { MAX_ARTIFACT_BYTES, MAX_PUBLISHED_GAMES, SITE_DATA_VERSION } from "./contracts";

const game = (slug: string) => ({
  slug, title: "Title", description: "Description", releaseDate: "2026-01-01", status: "released" as const,
  developer: "Developer", publisher: "Publisher", genres: ["Action"], platforms: ["PC"],
  cover: "https://cdn.akamai.steamstatic.com/steam/apps/1/cover.jpg",
  hero: "https://images.igdb.com/igdb/image/upload/t_1080p/hero.jpg", screenshots: [],
  officialLinks: [{ provider: "steam", type: "store", url: "https://store.steampowered.com/app/1" }],
  videos: [{ provider: "youtube" as const, id: "dQw4w9WgXcQ", title: null }],
  optional: { titleCn: null, rating: null, systemRequirements: null, modes: null, controllerSupport: null, isFree: null },
});

describe("site-data pure validation", () => {
  it("rejects an empty artifact because the production home page requires a game", () => {
    expect(() => validateArtifact({ version: SITE_DATA_VERSION, snapshotDate: "2026-09-19", games: [] })).toThrow(/at least one published game/i);
  });
  it("accepts the real Steam shared CDN but rejects arbitrary image hosts", () => {
    expect(() => validateImageUrl("https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1245620/header.jpg")).not.toThrow();
    expect(() => validateImageUrl("https://evil.example/header.jpg")).toThrow();
  });
  it.each([["2026-02-29"], ["2026-01-01T00:00:00Z"], ["2026-01-01+08:00"], [" 2026-01-01"], ["2026-02-30"], [""]])(
    "rejects invalid snapshot date %j", (value) => expect(() => parseSnapshotDate(value)).toThrow(),
  );

  it("accepts only a real exact UTC calendar date", () => expect(parseSnapshotDate("2024-02-29")).toBe("2024-02-29"));

  it.each([
    "https://cdn.akamai.steamstatic.com/steam/apps/1/cover.jpg",
    "https://images.igdb.com/igdb/image/upload/t_cover_big/co1.jpg",
  ])("accepts approved public URL %s", (url) => expect(validatePublicUrl(url)).toBe(url));

  it.each([
    "https://www.example-game.com/",
    "https://example.com/game",
    "https://store.example-game.com/title/123",
  ])("accepts arbitrary HTTPS official website URL %s", (url) => expect(validateOfficialLinkUrl(url)).toBe(url));

  it.each(["http://cdn.akamai.steamstatic.com/a.jpg", "https://evil.test/a", "https://u:p@store.steampowered.com/app/1", "https://store.steampowered.com/app/1#x", "javascript:alert(1)", `https://store.steampowered.com/${"a".repeat(2041)}`])(
    "rejects unsafe public URL %s", (url) => expect(() => validatePublicUrl(url)).toThrow(),
  );

  it.each(["ftp://example.com/game", "javascript:alert(1)", "https://user:pass@example.com/", "https://example.com/game#fragment", "not a URL", `https://example.com/${"a".repeat(2041)}`])(
    "rejects unsafe official website URL %s", (url) => expect(() => validateOfficialLinkUrl(url)).toThrow(),
  );

  it("keeps image and official-link host policies separate", () => {
    expect(() => validateImageUrl("https://store.steampowered.com/app/1")).toThrow();
    expect(validateOfficialLinkUrl("https://www.example-game.com/")).toBe("https://www.example-game.com/");
  });

  it.each(["dQw4w9WgXcQ", "abc_def-123"])("accepts YouTube ID %s", (id) => expect(validateYoutubeId(id)).toBe(id));
  it.each(["short", "dQw4w9WgXcQ!", "dQw4w9WgXcQQ", " dQw4w9WgXcQ"])("rejects invalid YouTube ID %s", (id) => expect(() => validateYoutubeId(id)).toThrow());

  it("rejects private keys and unsorted games", () => {
    expect(() => validateArtifact({ version: SITE_DATA_VERSION, snapshotDate: "2026-09-19", games: [{ ...game("b"), id: 1 }, game("a")] })).toThrow();
    expect(() => validateArtifact({ version: SITE_DATA_VERSION, snapshotDate: "2026-09-19", games: [game("b"), game("a")] })).toThrow(/order/i);
  });

  it("rejects unsorted public relations", () => {
    expect(() => validateArtifact({ version: SITE_DATA_VERSION, snapshotDate: "2026-09-19", games: [{ ...game("a"), genres: ["Z", "A"] }] })).toThrow(/order/i);
    expect(() => validateArtifact({ version: SITE_DATA_VERSION, snapshotDate: "2026-09-19", games: [{ ...game("a"), officialLinks: [
      { provider: "z", type: "store", url: "https://store.steampowered.com/app/1" },
      { provider: "a", type: "store", url: "https://store.steampowered.com/app/2" },
    ] }] })).toThrow(/order/i);
  });

  it("enforces version, game-count, and serialized-byte limits", () => {
    expect(() => validateArtifact({ version: 2, snapshotDate: "2026-09-19", games: [] })).toThrow();
    expect(() => validateArtifact({ version: SITE_DATA_VERSION, snapshotDate: "2026-09-19", games: Array.from({ length: MAX_PUBLISHED_GAMES + 1 }, (_, i) => game(`g-${i}`)) })).toThrow();
    const huge = { ...game("huge"), description: "x".repeat(MAX_ARTIFACT_BYTES) };
    expect(() => validateArtifact({ version: SITE_DATA_VERSION, snapshotDate: "2026-09-19", games: [huge] })).toThrow();
  });
});
