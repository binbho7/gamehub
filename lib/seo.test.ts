import artifactJson from "../generated/site-data.json";
import { describe, expect, it } from "vitest";
import type { PublishedArtifact, PublishedGame } from "./site-data/contracts";
import {
  SITE_ORIGIN,
  buildSitemapEntries,
  buildVideoGameJsonLd,
  serializeJsonLd,
} from "../app/seo";

const artifact = artifactJson as PublishedArtifact;

describe("technical SEO artifacts", () => {
  it("publishes every real game and taxonomy URL once in stable order", () => {
    const sitemap = buildSitemapEntries(artifact);
    const urls = sitemap.map((entry) => entry.url);
    const expectedGames = artifact.games.map((game) => `${SITE_ORIGIN}/games/${game.slug}`);
    const expectedGenres = [...new Set(artifact.games.flatMap((game) => game.genreSlugs))]
      .sort()
      .map((slug) => `${SITE_ORIGIN}/genres/${slug}`);
    const expectedPlatforms = [...new Set(artifact.games.flatMap((game) => game.platformSlugs))]
      .sort()
      .map((slug) => `${SITE_ORIGIN}/platforms/${slug}`);

    expect(urls).toEqual([
      `${SITE_ORIGIN}/`,
      `${SITE_ORIGIN}/games`,
      ...expectedGames,
      ...expectedGenres,
      ...expectedPlatforms,
    ]);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls.some((url) => url.includes("/search") || url.includes("?"))).toBe(false);
    expect(sitemap.every((entry) => !("lastModified" in entry))).toBe(true);
  });

  it("builds a factual VideoGame graph with absolute URLs and deduplicated official links", () => {
    const game = artifact.games.find((candidate) => candidate.slug === "elden-ring");
    expect(game).toBeDefined();
    const duplicateLinks: PublishedGame = {
      ...game!,
      officialLinks: [...game!.officialLinks, game!.officialLinks[0]],
    };

    const jsonLd = buildVideoGameJsonLd(duplicateLinks);

    expect(jsonLd).toMatchObject({
      "@context": "https://schema.org",
      "@type": "VideoGame",
      name: game!.title,
      url: `${SITE_ORIGIN}/games/elden-ring`,
      image: game!.hero,
      datePublished: game!.releaseDate,
      genre: game!.genres,
      gamePlatform: game!.platforms,
      publisher: { "@type": "Organization", name: game!.publisher },
      developer: { "@type": "Organization", name: game!.developer },
      sameAs: [...new Set(game!.officialLinks.map((link) => link.url))],
    });
    expect(jsonLd).not.toHaveProperty("aggregateRating");
    expect(jsonLd).not.toHaveProperty("offers");
    expect(jsonLd).not.toHaveProperty("review");
    expect(JSON.stringify(jsonLd)).not.toContain(":null");
  });

  it("serializes JSON-LD as parseable JSON while escaping markup-significant less-than signs", () => {
    const serialized = serializeJsonLd({ name: "</script><script>alert(1)</script>" });

    expect(serialized).not.toContain("<");
    expect(serialized).toContain("\\u003c/script>");
    expect(JSON.parse(serialized)).toEqual({ name: "</script><script>alert(1)</script>" });
  });
});
