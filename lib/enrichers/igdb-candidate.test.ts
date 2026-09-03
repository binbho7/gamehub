import { describe, expect, it } from "vitest";
import {
  igdbEnrichmentCandidateSchema,
  igdbNormalizationResultSchema,
  type IgdbEnrichmentCandidate,
} from "./igdb-candidate";

function completeCandidate(): IgdbEnrichmentCandidate {
  return {
    source: {
      provider: "igdb",
      externalId: "119133",
      fetchedAt: new Date("2026-09-03T01:02:03.000Z"),
    },
    identity: {
      canonicalGameId: 42,
      steamAppId: "1245620",
      igdbGameId: "119133",
    },
    game: {
      title: "Elden Ring",
      summary: "An action role-playing game.",
      description: null,
      releaseDate: "2022-03-25",
      coverUrl: "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co4jni.jpg",
      heroUrl: "https://images.igdb.com/igdb/image/upload/t_1080p/ar1x9v.jpg",
    },
    externalIds: [{ provider: "igdb", externalId: "119133", externalUrl: null }],
    genres: [{ slug: "role-playing-rpg", name: "Role-playing (RPG)" }],
    platforms: [{ slug: "windows", name: "Windows" }],
    companies: [{
      preferredSlug: "fromsoftware",
      name: "FromSoftware",
      websiteUrl: null,
      role: "developer",
    }],
    officialLinks: [{
      provider: "igdb",
      platform: null,
      linkType: "official_website",
      url: "https://example.test/game",
      isOfficial: true,
      verificationStatus: "unverified",
      verificationMethod: null,
    }],
    images: [
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
    ],
    videos: [{
      provider: "igdb",
      externalId: "E3Huy2cdih0",
      title: "Launch Trailer",
      thumbnailUrl: null,
      sortOrder: 0,
    }],
  };
}

describe("IGDB enrichment candidate", () => {
  it("accepts the bounded provider-neutral DTO and preserves warnings", () => {
    const warning = { code: "invalid_optional_item", message: "Ignored item", path: "genres[1]" };
    const result = igdbNormalizationResultSchema.parse({
      candidate: completeCandidate(),
      warnings: [warning],
    });

    expect(result.candidate.source).toEqual({
      provider: "igdb",
      externalId: "119133",
      fetchedAt: new Date("2026-09-03T01:02:03.000Z"),
    });
    expect(result.warnings).toEqual([warning]);
  });

  it.each([
    ["source and identity IGDB IDs differ", (candidate: IgdbEnrichmentCandidate) => {
      candidate.source.externalId = "999";
    }],
    ["external ID and identity IGDB IDs differ", (candidate: IgdbEnrichmentCandidate) => {
      candidate.externalIds[0]!.externalId = "999";
    }],
    ["the IGDB external ID is duplicated", (candidate: IgdbEnrichmentCandidate) => {
      candidate.externalIds.push({ ...candidate.externalIds[0]! });
    }],
    ["a company website is provider-derived", (candidate: IgdbEnrichmentCandidate) => {
      (candidate.companies[0]! as unknown as { websiteUrl: string }).websiteUrl = "https://company.example.test";
    }],
    ["a media URL is unsafe", (candidate: IgdbEnrichmentCandidate) => {
      candidate.images[0]!.sourceUrl = "javascript:alert(1)";
    }],
  ])("rejects a candidate when %s", (_name, mutate) => {
    const candidate = completeCandidate();
    mutate(candidate);

    expect(igdbEnrichmentCandidateSchema.safeParse(candidate).success).toBe(false);
  });

  it.each([
    ["artworks", 21, "artwork"],
    ["screenshots", 51, "screenshot"],
  ] as const)("rejects more than the allowed %s", (_name, count, type) => {
    const candidate = completeCandidate();
    candidate.game.coverUrl = null;
    candidate.game.heroUrl = null;
    candidate.images = Array.from({ length: count }, (_, index) => ({
      type,
      sourceUrl: `https://images.example.test/${type}-${index}.jpg`,
      width: null,
      height: null,
      sortOrder: index,
    }));

    expect(igdbEnrichmentCandidateSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects more than 20 videos", () => {
    const candidate = completeCandidate();
    candidate.videos = Array.from({ length: 21 }, (_, index) => ({
      provider: "igdb" as const,
      externalId: `video-${index}`,
      title: null,
      thumbnailUrl: null,
      sortOrder: index,
    }));

    expect(igdbEnrichmentCandidateSchema.safeParse(candidate).success).toBe(false);
  });
});
