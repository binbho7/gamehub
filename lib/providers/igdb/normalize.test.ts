import { describe, expect, it } from "vitest";
import gameFixture from "../../../fixtures/igdb/game.json";
import { igdbGamesResponseSchema, type IgdbGameRaw } from "./schema";
import { normalizeIgdbGame } from "./normalize";

const identity = {
  canonicalGameId: 42,
  steamAppId: "1245620",
  igdbGameId: 119133,
};
const fetchedAt = new Date("2026-09-03T01:02:03.000Z");

function validGame(): IgdbGameRaw {
  return igdbGamesResponseSchema.parse(gameFixture)[0]!;
}

describe("normalizeIgdbGame", () => {
  it("normalizes scalar identity, exact UTC date, taxonomy, roles, and media URLs", () => {
    const raw = validGame();
    raw.summary = "  An action role-playing game.  ";
    raw.storyline = "  Become the Elden Lord.  ";
    raw.genres = [
      { id: 12, name: " Role-playing (RPG) ", slug: "role-playing-rpg" },
      { id: 5, name: "Action", slug: "action" },
    ];
    raw.platforms = [
      { id: 14, name: "Mac", slug: "mac" },
      { id: 6, name: "PC (Microsoft Windows)", slug: "win" },
      { id: 3, name: "Linux", slug: "linux" },
    ];
    raw.involved_companies = [{
      developer: true,
      publisher: true,
      company: {
        id: 101,
        name: "FromSoftware",
        slug: "fromsoftware",
        url: "https://must-not-be-consumed.example.test",
      },
    }];

    const result = normalizeIgdbGame(raw, identity, fetchedAt);

    expect(result.candidate).toMatchObject({
      source: { provider: "igdb", externalId: "119133", fetchedAt },
      identity: { canonicalGameId: 42, steamAppId: "1245620", igdbGameId: "119133" },
      game: {
        title: "Elden Ring",
        summary: "An action role-playing game.",
        description: "Become the Elden Lord.",
        releaseDate: "2022-03-25",
        coverUrl: "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co4jni.jpg",
        heroUrl: "https://images.igdb.com/igdb/image/upload/t_1080p/ar1x9v.jpg",
      },
      externalIds: [{ provider: "igdb", externalId: "119133", externalUrl: null }],
      genres: [
        { slug: "role-playing-rpg", name: "Role-playing (RPG)" },
        { slug: "action", name: "Action" },
      ],
      platforms: [
        { slug: "macos", name: "macOS" },
        { slug: "windows", name: "Windows" },
        { slug: "linux", name: "Linux" },
      ],
      companies: [
        { preferredSlug: "fromsoftware", name: "FromSoftware", websiteUrl: null, role: "developer" },
        { preferredSlug: "fromsoftware", name: "FromSoftware", websiteUrl: null, role: "publisher" },
      ],
      officialLinks: [{
        provider: "igdb",
        platform: null,
        linkType: "official_website",
        url: "https://en.bandainamcoent.eu/elden-ring/elden-ring",
        isOfficial: true,
        verificationStatus: "unverified",
        verificationMethod: null,
      }],
    });
    expect(result.candidate.companies[0]).not.toHaveProperty("url");
    expect(result.candidate.images).toEqual([
      {
        type: "cover",
        sourceUrl: "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co4jni.jpg",
        width: 264,
        height: 374,
        sortOrder: 0,
      },
      {
        type: "artwork",
        sourceUrl: "https://images.igdb.com/igdb/image/upload/t_1080p/ar1x9v.jpg",
        width: 1920,
        height: 1080,
        sortOrder: 1,
      },
      {
        type: "screenshot",
        sourceUrl: "https://images.igdb.com/igdb/image/upload/t_screenshot_big/sc1abc.jpg",
        width: 1920,
        height: 1080,
        sortOrder: 2,
      },
    ]);
    expect(result.candidate.videos).toEqual([{
      provider: "igdb",
      externalId: "E3Huy2cdih0",
      title: "Launch Trailer",
      thumbnailUrl: null,
      sortOrder: 0,
    }]);
  });

  it("requires raw and resolved IGDB identities to agree", () => {
    expect(() => normalizeIgdbGame(validGame(), { ...identity, igdbGameId: 999 }, fetchedAt)).toThrow();
  });

  it("accepts only trusted type-1 websites and stably deduplicates eligible URLs", () => {
    const raw = validGame();
    raw.websites = [
      { type: 1, trusted: false, url: "https://untrusted.example.test" },
      { type: 2, trusted: true, url: "https://wrong-type.example.test" },
      { type: 1, trusted: true, url: "https://first.example.test" },
      { type: 1, trusted: true, url: "https://first.example.test" },
      { type: 1, trusted: true, url: "javascript:alert(1)" },
      { type: "official" },
      { type: 1, trusted: true, url: "https://second.example.test" },
    ];

    const result = normalizeIgdbGame(raw, identity, fetchedAt);

    expect(result.candidate.officialLinks.map((link) => link.url)).toEqual([
      "https://first.example.test",
      "https://second.example.test",
    ]);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "websites[0]" }),
      expect.objectContaining({ path: "websites[1]" }),
      expect.objectContaining({ path: "websites[3]" }),
      expect.objectContaining({ path: "websites[4]" }),
      expect.objectContaining({ path: "websites[5]" }),
    ]));
  });

  it("skips invalid optional items, unknown platforms, and invalid dates with warnings", () => {
    const raw = validGame();
    raw.first_release_date = Number.MAX_SAFE_INTEGER;
    raw.genres = [{ id: 12, name: "RPG", slug: "rpg" }, { id: "bad" }];
    raw.platforms = [{ id: 999, name: "Unknown", slug: "unknown" }, null];
    raw.involved_companies = [{ developer: true, publisher: false, company: { id: 1 } }];
    raw.cover = { image_id: "../unsafe", width: 264, height: 374 };
    raw.artworks = [{ image_id: "safe_art", width: 1920, height: 1080 }, { image_id: 7 }];
    raw.screenshots = [{ image_id: "safe_shot", width: 1920, height: 1080 }, null];
    raw.videos = [{ video_id: "bad id", name: "Bad" }, { video_id: "E3Huy2cdih0", name: "Good" }];

    const result = normalizeIgdbGame(raw, identity, fetchedAt);

    expect(result.candidate.game.releaseDate).toBeNull();
    expect(result.candidate.game.coverUrl).toBeNull();
    expect(result.candidate.game.heroUrl).toBe("https://images.igdb.com/igdb/image/upload/t_1080p/safe_art.jpg");
    expect(result.candidate.genres).toEqual([{ slug: "rpg", name: "RPG" }]);
    expect(result.candidate.platforms).toEqual([]);
    expect(result.candidate.companies).toEqual([]);
    expect(result.candidate.images.map((image) => image.type)).toEqual(["artwork", "screenshot"]);
    expect(result.candidate.videos.map((video) => video.externalId)).toEqual(["E3Huy2cdih0"]);
    expect(result.warnings.length).toBeGreaterThanOrEqual(8);
  });

  it("uses only the first valid artwork for heroUrl and never falls back to screenshots", () => {
    const raw = validGame();
    raw.artworks = [{ image_id: "../unsafe", width: 1920, height: 1080 }];
    raw.screenshots = [{ image_id: "valid_shot", width: 1920, height: 1080 }];

    expect(normalizeIgdbGame(raw, identity, fetchedAt).candidate.game.heroUrl).toBeNull();

    raw.artworks = [
      { image_id: "first_art", width: 1920, height: 1080 },
      { image_id: "second_art", width: 1920, height: 1080 },
    ];
    expect(normalizeIgdbGame(raw, identity, fetchedAt).candidate.game.heroUrl).toBe(
      "https://images.igdb.com/igdb/image/upload/t_1080p/first_art.jpg",
    );
  });

  it("deduplicates before media caps, preserves provider order, and warns once per truncated kind", () => {
    const raw = validGame();
    raw.cover = null;
    raw.artworks = Array.from({ length: 22 }, (_, index) => ({
      image_id: index === 1 ? "art_0" : `art_${index}`,
      width: 1920,
      height: 1080,
    }));
    raw.screenshots = Array.from({ length: 52 }, (_, index) => ({
      image_id: index === 1 ? "shot_0" : `shot_${index}`,
      width: 1920,
      height: 1080,
    }));
    raw.videos = Array.from({ length: 22 }, (_, index) => ({
      video_id: index === 1 ? "video_id_00" : `video_id_${String(index).padStart(2, "0")}`,
      name: `Video ${index}`,
    }));

    const result = normalizeIgdbGame(raw, identity, fetchedAt);
    const artworks = result.candidate.images.filter((image) => image.type === "artwork");
    const screenshots = result.candidate.images.filter((image) => image.type === "screenshot");

    expect(artworks).toHaveLength(20);
    expect(screenshots).toHaveLength(50);
    expect(result.candidate.videos).toHaveLength(20);
    expect(artworks.slice(0, 2).map((image) => image.sourceUrl)).toEqual([
      "https://images.igdb.com/igdb/image/upload/t_1080p/art_0.jpg",
      "https://images.igdb.com/igdb/image/upload/t_1080p/art_2.jpg",
    ]);
    expect(result.candidate.videos.slice(0, 2).map((video) => video.externalId)).toEqual([
      "video_id_00",
      "video_id_02",
    ]);
    const limitWarnings = result.warnings.filter((warning) => warning.code === "media_limit_applied");
    expect(limitWarnings.map((warning) => warning.path)).toEqual(["artworks", "screenshots", "videos"]);
  });
});
