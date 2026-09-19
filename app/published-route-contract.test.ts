import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PublishedGameSchema } from "../lib/site-data/contracts";

const routeFiles = ["app/page.tsx", "app/games/page.tsx", "app/search/page.tsx", "app/games/[slug]/page.tsx", "app/genres/[slug]/page.tsx", "app/platforms/[slug]/page.tsx"];

describe("published frontend boundary", () => {
  it("models unavailable optional data and empty media without mock defaults", () => {
    const result = PublishedGameSchema.safeParse({ slug: "fixture", title: "Fixture", description: "Description", releaseDate: "2024-01-01", status: "released", developer: "Developer", publisher: "Publisher", genres: ["Action"], genreSlugs: ["action"], platforms: ["PC"], platformSlugs: ["pc"], cover: "https://cdn.igdb.com/cover.jpg", hero: "https://cdn.igdb.com/hero.jpg", screenshots: [], officialLinks: [{ provider: "website", type: "official_website", url: "https://example.com/" }], videos: [], optional: { titleCn: null, rating: null, systemRequirements: null, modes: null, controllerSupport: null, isFree: null } });
    expect(result.success).toBe(true);
  });

  it("keeps production route graph on generated source", async () => {
    const sources = await Promise.all(routeFiles.map((file) => readFile(file, "utf8")));
    expect(sources.every((source) => !source.includes("@/lib/mock-data"))).toBe(true);
    expect(sources.some((source) => source.includes("loadPublishedArtifact"))).toBe(true);
    expect(await readFile("components/search/search-dialog.tsx", "utf8")).not.toContain("@/lib/mock-data");
  });

  it("derives platform browse links and counts from the published taxonomy", async () => {
    const source = await readFile("components/home/browse-sections.tsx", "utf8");
    expect(source).toContain("game.platforms");
    expect(source).toContain("/platforms/${slug}");
    expect(source).not.toContain('slug: "pc"');
  });

  it("uses segment-safe taxonomy slugs for genre links", async () => {
    const source = await readFile("components/home/browse-sections.tsx", "utf8");
    const route = await readFile("app/genres/[slug]/page.tsx", "utf8");
    expect(source).toContain("genre.slug");
    expect(route).toContain("genreSlugs");
  });

  it("does not advertise unsupported Steam App ID search", async () => {
    const files = ["app/search/page.tsx", "components/search/search-dialog.tsx", "components/search/static-search.tsx", "components/filters/game-library.tsx", "components/home/home-hero.tsx"];
    const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));
    expect(sources.join("\n")).not.toMatch(/Steam App ID/);
  });

  it("shares taxonomy slugging with platform routes", async () => {
    const source = await readFile("app/platforms/[slug]/page.tsx", "utf8");
    expect(source).toContain("platformSlugs");
    expect(source).not.toContain('replaceAll("|", "")');
  });

  it("does not expose free-game navigation while free status is unavailable", async () => {
    const sources = await Promise.all([readFile("app/page.tsx", "utf8"), readFile("components/layout/header-client.tsx", "utf8")]);
    expect(sources.join("\n")).not.toContain("free=true");
  });
});
