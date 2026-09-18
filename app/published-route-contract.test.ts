import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PublishedGameSchema } from "../lib/site-data/contracts";

const routeFiles = ["app/page.tsx", "app/games/page.tsx", "app/search/page.tsx", "app/games/[slug]/page.tsx", "app/genres/[slug]/page.tsx", "app/platforms/[slug]/page.tsx"];

describe("published frontend boundary", () => {
  it("models unavailable optional data and empty media without mock defaults", () => {
    const result = PublishedGameSchema.safeParse({ slug: "fixture", title: "Fixture", description: "Description", releaseDate: "2024-01-01", status: "released", developer: "Developer", publisher: "Publisher", genres: ["Action"], platforms: ["PC"], cover: "https://cdn.igdb.com/cover.jpg", hero: "https://cdn.igdb.com/hero.jpg", screenshots: [], officialLinks: [], videos: [], optional: { titleCn: null, rating: null, systemRequirements: null, modes: null, controllerSupport: null, isFree: null } });
    expect(result.success).toBe(true);
  });

  it("keeps production route graph on generated source", async () => {
    const sources = await Promise.all(routeFiles.map((file) => readFile(file, "utf8")));
    expect(sources.every((source) => !source.includes("@/lib/mock-data"))).toBe(true);
    expect(sources.some((source) => source.includes("loadPublishedArtifact"))).toBe(true);
    expect(await readFile("components/search/search-dialog.tsx", "utf8")).not.toContain("@/lib/mock-data");
  });
});
