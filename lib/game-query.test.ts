import { describe, expect, it } from "vitest";
import type { PublishedGame } from "./site-data/contracts";
import { filterGames, getGameBySlug, getRelatedGames } from "./game-query";

const game = (slug: string, genres: string[], platforms: string[]): PublishedGame => ({ slug, title: slug, description: "description", releaseDate: "2024-01-01", status: "released", developer: "Developer", publisher: "Publisher", genres, genreSlugs: genres.map((value) => value.toLowerCase()), platforms, platformSlugs: platforms.map((value) => value.toLowerCase()), cover: "https://cdn.igdb.com/cover.jpg", hero: "https://cdn.igdb.com/hero.jpg", screenshots: [], officialLinks: [], videos: [], optional: { titleCn: null, rating: null, systemRequirements: null, modes: null, controllerSupport: null, isFree: null } });
const games = [game("alpha", ["Action"], ["PC"]), game("beta", ["Action", "RPG"], ["PC"]), game("gamma", ["Puzzle"], ["Switch"])];

describe("published game queries", () => {
  it("filters by query, genre and platform", () => {
    expect(filterGames(games, { query: "ALPHA" }).map((item) => item.slug)).toEqual(["alpha"]);
    expect(filterGames(games, { genre: "Action", platform: "PC" }).map((item) => item.slug)).toEqual(["alpha", "beta"]);
  });
  it("finds by slug and returns related games", () => {
    const current = getGameBySlug(games, "alpha")!;
    expect(getGameBySlug(games, "missing")).toBeUndefined();
    expect(getRelatedGames(games, current).map((item) => item.slug)).toEqual(["beta", "gamma"]);
  });
});
