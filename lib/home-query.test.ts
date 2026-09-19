import { describe, expect, it } from "vitest";
import { selectUpcomingGames } from "./home-query";

const game = (slug: string, status: "released" | "upcoming") => ({ slug, title: slug, description: "d", releaseDate: "2026-01-01", status, developer: "d", publisher: "p", genres: ["Action"], genreSlugs: ["action"], platforms: ["Windows"], platformSlugs: ["windows"], cover: "https://cdn.akamai.steamstatic.com/a.jpg", hero: "https://images.igdb.com/a.jpg", screenshots: [], officialLinks: [{ provider: "website", type: "official_website", url: "https://example.com/" }], videos: [], optional: { titleCn: null, rating: null, systemRequirements: null, modes: null, controllerSupport: null, isFree: null } });

describe("homepage upcoming selection", () => {
  it("keeps three upcoming games", () => expect(selectUpcomingGames([game("a", "upcoming"), game("b", "upcoming"), game("c", "upcoming")]).map((item) => item.slug)).toEqual(["a", "b", "c"]));
  it("bounds twenty upcoming games to six", () => expect(selectUpcomingGames(Array.from({ length: 20 }, (_, index) => game(String(index), "upcoming")))).toHaveLength(6));
});
