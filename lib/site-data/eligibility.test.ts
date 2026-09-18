import { describe, expect, it } from "vitest";
import type { SiteSnapshotGame } from "./read-model";
import { evaluateGame } from "./eligibility";

const validGame = (): SiteSnapshotGame => ({
  game: {
    id: 1, slug: "valid-game", title: "Valid Game", summary: null,
    description: "A real description", status: "released", releaseDate: "2026-09-18",
    coverUrl: "https://cdn.akamai.steamstatic.com/cover.jpg",
    heroUrl: "https://images.igdb.com/hero.jpg",
  },
  externalIds: [{ id: 1, gameId: 1, provider: "steam", externalId: "123", externalUrl: null }],
  companies: [
    { id: 1, gameId: 1, slug: "dev", name: "Developer", websiteUrl: null, role: "developer" },
    { id: 2, gameId: 1, slug: "pub", name: "Publisher", websiteUrl: null, role: "publisher" },
  ],
  genres: [{ id: 1, slug: "action", name: "Action" }],
  platforms: [{ id: 1, slug: "pc", name: "PC" }],
  images: [
    { id: 1, gameId: 1, type: "screenshot", sourceUrl: "https://images.igdb.com/shot.jpg", sourceProvider: "igdb", sortOrder: 0 },
  ],
  officialLinks: [{ id: 1, gameId: 1, provider: "website", platform: null, linkType: "official_website", url: "https://www.example-game.com/", region: null, isOfficial: true, verificationStatus: "verified", verificationMethod: "manual" }],
  videos: [{ id: 1, gameId: 1, provider: "youtube", externalId: "dQw4w9WgXcQ", title: "Trailer", sortOrder: 0 }],
});

function result(overrides: Partial<SiteSnapshotGame["game"]> = {}) {
  return evaluateGame({ ...validGame(), game: { ...validGame().game, ...overrides } }, "2026-09-19");
}

describe("publication eligibility", () => {
  it("publishes a complete eligible game with unavailable optional fields", () => {
    const evaluated = result();
    expect(evaluated.diagnostics).toEqual([]);
    expect(evaluated.published).toMatchObject({
      slug: "valid-game", title: "Valid Game", developer: "Developer", publisher: "Publisher",
      cover: "https://cdn.akamai.steamstatic.com/cover.jpg",
      officialLinks: [{ provider: "website", type: "official_website", url: "https://www.example-game.com/" }],
      videos: [{ provider: "youtube", id: "dQw4w9WgXcQ", title: "Trailer" }],
      optional: { titleCn: null, rating: null, systemRequirements: null, modes: null, controllerSupport: null, isFree: null },
    });
  });

  it.each([
    ["missing title", { title: "" }, "missing_title"],
    ["missing description", { description: "" }, "missing_description"],
    ["missing release date", { releaseDate: "" }, "missing_release_date"],
    ["invalid status", { status: "announced" }, "invalid_status"],
    ["invalid slug", { slug: "Not A Slug" }, "invalid_slug"],
    ["released after snapshot", { releaseDate: "2026-09-20" }, "released_after_snapshot"],
  ] as const)("rejects %s", (_label, override, code) => {
    const evaluated = result(override);
    expect(evaluated.published).toBeNull();
    expect(evaluated.diagnostics.map((item) => item.code)).toContain(code);
  });

  it("uses explicit date boundaries for released and upcoming games", () => {
    expect(result({ releaseDate: "2026-09-19" }).published).not.toBeNull();
    const upcoming = evaluateGame({ ...validGame(), game: { ...validGame().game, status: "upcoming", releaseDate: "2026-09-20" } }, "2026-09-19");
    expect(upcoming.published).not.toBeNull();
    const sameDay = evaluateGame({ ...validGame(), game: { ...validGame().game, status: "upcoming", releaseDate: "2026-09-19" } }, "2026-09-19");
    expect(sameDay.published).toBeNull();
  });

  it("requires exactly one valid Steam identity and resolved developer/publisher relations", () => {
    for (const externalIds of [[], [{ ...validGame().externalIds[0]!, provider: "steam", externalId: "0" }], [...validGame().externalIds, { id: 2, gameId: 1, provider: "steam", externalId: "456", externalUrl: null }]]) {
      const evaluated = evaluateGame({ ...validGame(), externalIds }, "2026-09-19");
      expect(evaluated.diagnostics.map((item) => item.code)).toContain("invalid_steam_identity");
    }
    const missingRoles = evaluateGame({ ...validGame(), companies: [] }, "2026-09-19");
    expect(missingRoles.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining(["missing_developer", "missing_publisher"]));
  });

  it("requires non-empty taxonomy and approved images", () => {
    const evaluated = evaluateGame({ ...validGame(), genres: [], platforms: [], game: { ...validGame().game, coverUrl: "https://evil.example/cover.jpg" } }, "2026-09-19");
    expect(evaluated.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining(["missing_genres", "missing_platforms", "invalid_cover"]));
  });

  it("requires a verified official link with an allowed method", () => {
    for (const link of [
      { ...validGame().officialLinks[0]!, isOfficial: false },
      { ...validGame().officialLinks[0]!, verificationStatus: "pending" },
      { ...validGame().officialLinks[0]!, verificationMethod: "dns" },
    ]) {
      const evaluated = evaluateGame({ ...validGame(), officialLinks: [link] }, "2026-09-19");
      expect(evaluated.diagnostics.map((item) => item.code)).toContain("missing_verified_official_link");
    }
  });

  it("rejects unsafe videos but allows no videos", () => {
    const noVideo = evaluateGame({ ...validGame(), videos: [] }, "2026-09-19");
    expect(noVideo.published).not.toBeNull();
    const unsafe = evaluateGame({ ...validGame(), videos: [{ ...validGame().videos[0]!, externalId: "unsafe" }] }, "2026-09-19");
    expect(unsafe.diagnostics.map((item) => item.code)).toContain("invalid_video");
  });

  it("returns deterministic diagnostics and rejects duplicate public identities", () => {
    const duplicate = evaluateGame({ ...validGame(), externalIds: [...validGame().externalIds, { id: 2, gameId: 1, provider: "steam", externalId: "123", externalUrl: null }] }, "2026-09-19");
    expect(duplicate.diagnostics.map((item) => item.code)).toEqual([...duplicate.diagnostics.map((item) => item.code)].sort());
    expect(duplicate.diagnostics.map((item) => item.code)).toContain("duplicate_public_identity");
  });
});
