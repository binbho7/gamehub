import artifactJson from "../generated/site-data.json";
import { describe, expect, it } from "vitest";
import type { PublishedArtifact } from "../lib/site-data/contracts";
import {
  GAMES_METADATA,
  HOME_METADATA,
  ROBOTS_METADATA,
  ROOT_METADATA,
  SEARCH_METADATA,
  buildGameMetadata,
  buildTaxonomyMetadata,
} from "./seo";

const artifact = artifactJson as PublishedArtifact;

describe("route metadata ownership", () => {
  it("gives the homepage sole ownership of the root canonical", () => {
    expect(ROOT_METADATA.alternates).toBeUndefined();
    expect(HOME_METADATA.alternates).toEqual({ canonical: "/" });
    expect(HOME_METADATA.openGraph).toMatchObject({ siteName: "GameHub", locale: "zh_CN" });
    expect(GAMES_METADATA.alternates).toEqual({ canonical: "/games" });
  });

  it("keeps search noindex/follow without inheriting a homepage canonical", () => {
    expect(SEARCH_METADATA.robots).toEqual({ index: false, follow: true });
    expect(SEARCH_METADATA.alternates).toBeUndefined();
    expect(ROOT_METADATA.alternates).toBeUndefined();
  });

  it("publishes route-specific detail and Chinese taxonomy metadata", async () => {
    const game = artifact.games.find((candidate) => candidate.slug === "elden-ring")!;
    const detail = buildGameMetadata(game);
    const genre = buildTaxonomyMetadata("genre", "Role-playing (RPG)", "role-playing-rpg");
    const platform = buildTaxonomyMetadata("platform", "Windows", "windows");

    expect(detail.alternates).toEqual({ canonical: "/games/elden-ring" });
    expect(detail.twitter).toMatchObject({ card: "summary_large_image" });
    expect(genre.alternates).toEqual({ canonical: "/genres/role-playing-rpg" });
    expect(genre.title).toContain("游戏");
    expect(genre.description).toContain("游戏");
    expect(platform.alternates).toEqual({ canonical: "/platforms/windows" });
    expect(platform.title).toContain("游戏");
    expect(platform.description).toContain("游戏");
  });

  it("advertises the canonical sitemap while allowing public crawling", () => {
    expect(ROBOTS_METADATA).toEqual({
      rules: { userAgent: "*", allow: "/" },
      sitemap: "https://games.binbho.com/sitemap.xml",
      host: "https://games.binbho.com",
    });
  });
});
