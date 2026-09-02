import { describe, expect, it } from "vitest";
import validFixture from "../../../test/fixtures/steam/appdetails-valid.json";
import { parseSteamAppDetails } from "./response";
import { normalizeSteamGame } from "./normalize";

const fetchedAt = new Date("2026-09-02T01:02:03.000Z");

function validDetails() {
  return parseSteamAppDetails(validFixture, "1245620");
}

describe("normalizeSteamGame", () => {
  it("maps validated Steam details to a provider-neutral candidate", () => {
    const result = normalizeSteamGame(validDetails(), "1245620", fetchedAt);

    expect(result.candidate).toMatchObject({
      source: { provider: "steam", externalId: "1245620", fetchedAt },
      game: {
        preferredSlug: "elden-ring",
        title: "Elden Ring",
        summary: "The new fantasy action RPG.",
        description: null,
        status: "released",
        releaseDate: "2022-02-25",
      },
      externalIds: [{
        provider: "steam",
        externalId: "1245620",
        externalUrl: "https://store.steampowered.com/app/1245620/",
      }],
      officialLinks: [{
        provider: "steam",
        platform: null,
        linkType: "store",
        url: "https://store.steampowered.com/app/1245620/",
      }, {
        provider: "steam",
        platform: null,
        linkType: "official_website",
        url: "https://en.bandainamcoent.eu/elden-ring/elden-ring",
        isOfficial: true,
        verificationStatus: "unverified",
        verificationMethod: null,
      }],
      genres: [{ slug: "rpg", name: "RPG" }, { slug: "action", name: "Action" }],
      platforms: [{ slug: "windows", name: "Windows" }],
      companies: [
        { preferredSlug: "fromsoftware", name: "FromSoftware", role: "developer" },
        { preferredSlug: "bandai-namco-entertainment", name: "Bandai Namco Entertainment", role: "publisher" },
        { preferredSlug: "fromsoftware", name: "FromSoftware", role: "publisher" },
      ],
    });
    expect(result.candidate.externalIds).toHaveLength(1);
    expect(result.candidate.game.description).toBeNull();
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "ignored_optional_value",
      path: "detailed_description",
    }));
  });

  it.each([
    "2025",
    "Q4 2025",
    "Coming Soon",
    "TBA",
    "March 2025",
    "",
    "Feb 30, 2025",
  ])("normalizes ambiguous or invalid release date %j to null", (date) => {
    const details = validDetails();
    details.release_date = { coming_soon: false, date };

    expect(normalizeSteamGame(details, "1245620", fetchedAt).candidate.game.releaseDate).toBeNull();
  });

  it("maps an exact English date and coming-soon status", () => {
    const details = validDetails();
    details.release_date = { coming_soon: true, date: "Aug 20, 2024" };

    expect(normalizeSteamGame(details, "1245620", fetchedAt).candidate.game).toMatchObject({
      status: "upcoming",
      releaseDate: "2024-08-20",
    });
  });

  it("selects Steam image and video metadata in canonical order", () => {
    const result = normalizeSteamGame(validDetails(), "1245620", fetchedAt);

    expect(result.candidate.images).toEqual([
      {
        type: "cover",
        sourceUrl: "https://cdn.akamai.steamstatic.com/steam/apps/1245620/capsule_616x353.jpg",
        width: null,
        height: null,
        sortOrder: 0,
      },
      {
        type: "hero",
        sourceUrl: "https://cdn.akamai.steamstatic.com/steam/apps/1245620/header.jpg",
        width: null,
        height: null,
        sortOrder: 1,
      },
      {
        type: "screenshot",
        sourceUrl: "https://cdn.akamai.steamstatic.com/steam/apps/1245620/ss_1.jpg",
        width: null,
        height: null,
        sortOrder: 2,
      },
      {
        type: "screenshot",
        sourceUrl: "https://cdn.akamai.steamstatic.com/steam/apps/1245620/ss_2.jpg",
        width: null,
        height: null,
        sortOrder: 3,
      },
    ]);
    expect(result.candidate.videos).toEqual([{
      provider: "steam",
      externalId: "256878122",
      title: "ELDEN RING Official Gameplay Reveal",
      thumbnailUrl: "https://cdn.akamai.steamstatic.com/steam/apps/256878122/movie.293x165.jpg",
      sortOrder: 0,
    }]);
  });

  it("warns for provider fields intentionally excluded from canonical metadata", () => {
    const result = normalizeSteamGame(validDetails(), "1245620", fetchedAt);

    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ignored_optional_value", path: "detailed_description" }),
      expect.objectContaining({ code: "ignored_optional_value", path: "screenshots[0].path_thumbnail" }),
      expect.objectContaining({ code: "ignored_optional_value", path: "movies[0].webm" }),
      expect.objectContaining({ code: "ignored_optional_value", path: "movies[0].mp4" }),
    ]));
  });

  it("warns when optional URLs, duplicates, and media above caps are omitted", () => {
    const details = validDetails();
    details.website = "javascript:alert(1)";
    details.capsule_image = "not a URL";
    details.header_image = "https://cdn.example.test/header.jpg";
    details.screenshots = Array.from({ length: 53 }, (_, index) => ({
      id: index,
      path_thumbnail: `https://cdn.example.test/shot-${index}-thumb.jpg`,
      path_full: index === 0 ? "ftp://cdn.example.test/unsafe.jpg" : `https://cdn.example.test/shot-${index}.jpg`,
    }));
    details.screenshots[2]!.path_full = details.screenshots[1]!.path_full;
    details.movies = Array.from({ length: 22 }, (_, index) => ({
      id: index,
      name: `Movie ${index}`,
      thumbnail: index === 0 ? "javascript:alert(1)" : `https://cdn.example.test/movie-${index}.jpg`,
    }));
    details.movies[2]!.id = details.movies[1]!.id;

    const result = normalizeSteamGame(details, "1245620", fetchedAt);

    expect(result.candidate.game.coverUrl).toBeNull();
    expect(result.candidate.images).toHaveLength(51);
    expect(result.candidate.images[0]).toMatchObject({ type: "hero", sortOrder: 0 });
    expect(result.candidate.videos).toHaveLength(20);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid_optional_url", path: "website" }),
      expect.objectContaining({ code: "invalid_optional_url", path: "capsule_image" }),
      expect.objectContaining({ code: "invalid_optional_url", path: "screenshots[0].path_full" }),
      expect.objectContaining({ code: "invalid_optional_url", path: "movies[0].thumbnail" }),
      expect.objectContaining({ code: "duplicate_optional_value", path: "screenshots[2].path_full" }),
      expect.objectContaining({ code: "duplicate_optional_value", path: "movies[2].id" }),
      expect.objectContaining({ code: "media_cap_exceeded", path: "screenshots[52]" }),
      expect.objectContaining({ code: "media_cap_exceeded", path: "movies[21]" }),
    ]));
  });
});
