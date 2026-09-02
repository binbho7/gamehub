import { describe, expect, it } from "vitest";
import {
  canonicalCandidateSchema,
  normalizationResultSchema,
  type CanonicalGameCandidate,
} from "./candidate";

function completeCandidate(): CanonicalGameCandidate {
  return {
    source: { provider: "steam", externalId: "1245620", fetchedAt: new Date("2026-09-02T00:00:00.000Z") },
    game: {
      preferredSlug: "elden-ring",
      title: "ELDEN RING",
      summary: "A fantasy action RPG.",
      description: null,
      status: "released",
      releaseDate: "2022-02-25",
      coverUrl: "https://cdn.example.test/cover.jpg",
      heroUrl: "https://cdn.example.test/hero.jpg",
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
      isOfficial: true,
      verificationStatus: "verified",
      verificationMethod: "provider_api",
    }],
    genres: [{ slug: "action-rpg", name: "Action RPG" }],
    platforms: [{ slug: "windows", name: "Windows" }],
    companies: [{ preferredSlug: "fromsoftware", name: "FromSoftware", role: "developer" }],
    images: [
      { type: "cover", sourceUrl: "https://cdn.example.test/cover.jpg", width: null, height: null, sortOrder: 0 },
      { type: "hero", sourceUrl: "https://cdn.example.test/hero.jpg", width: null, height: null, sortOrder: 1 },
      { type: "screenshot", sourceUrl: "https://cdn.example.test/shot.jpg", width: 1920, height: 1080, sortOrder: 2 },
    ],
    videos: [{
      provider: "steam",
      externalId: "256789123",
      title: "Launch trailer",
      thumbnailUrl: "https://cdn.example.test/trailer.jpg",
      sortOrder: 0,
    }],
  };
}

describe("canonical candidate validation", () => {
  it("accepts a complete provider-neutral Steam candidate", () => {
    expect(canonicalCandidateSchema.parse(completeCandidate())).toMatchObject({
      source: { provider: "steam", externalId: "1245620" },
      game: { releaseDate: "2022-02-25" },
    });
  });

  it.each([
    ["a non-Steam source", (candidate: ReturnType<typeof completeCandidate>) => { (candidate.source as { provider: string }).provider = "gog"; }],
    ["a Store link assigned to a platform", (candidate: ReturnType<typeof completeCandidate>) => { (candidate.officialLinks[0]! as unknown as { platform: string }).platform = "windows"; }],
    ["an impossible canonical date", (candidate: ReturnType<typeof completeCandidate>) => { candidate.game.releaseDate = "2025-02-30"; }],
    ["an unsafe URL", (candidate: ReturnType<typeof completeCandidate>) => { candidate.images[0]!.sourceUrl = "javascript:alert(1)"; }],
    ["duplicate provider external IDs", (candidate: ReturnType<typeof completeCandidate>) => { candidate.externalIds.push({ ...candidate.externalIds[0]! }); }],
  ])("rejects %s", (_name, mutate) => {
    const candidate = completeCandidate();
    mutate(candidate);
    expect(canonicalCandidateSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects candidates with more than 50 screenshots", () => {
    const candidate = completeCandidate();
    candidate.images = Array.from({ length: 51 }, (_, index) => ({
      type: "screenshot" as const,
      sourceUrl: `https://cdn.example.test/shot-${index}.jpg`,
      width: null,
      height: null,
      sortOrder: index,
    }));
    expect(canonicalCandidateSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects an external ID that does not match the source Steam App ID", () => {
    const candidate = completeCandidate();
    candidate.externalIds[0]!.externalId = "999999";

    expect(canonicalCandidateSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects candidates with more than 20 videos", () => {
    const candidate = completeCandidate();
    candidate.videos = Array.from({ length: 21 }, (_, index) => ({
      provider: "steam" as const,
      externalId: String(index),
      title: null,
      thumbnailUrl: null,
      sortOrder: index,
    }));
    expect(canonicalCandidateSchema.safeParse(candidate).success).toBe(false);
  });

  it("preserves normalization warnings", () => {
    const warning = { code: "invalid_optional_url", message: "Ignored website", path: "website" };
    expect(normalizationResultSchema.parse({ candidate: completeCandidate(), warnings: [warning] }).warnings).toEqual([warning]);
  });
});
