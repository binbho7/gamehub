import { describe, expect, it } from "vitest";
import { games } from "./mock-data";
import { filterGames, getGameBySlug, getRelatedGames } from "./game-query";

describe("game queries", () => {
  it("searches English and Chinese titles without case sensitivity", () => {
    expect(filterGames(games, { query: "WUKONG" }).map((game) => game.slug)).toEqual([
      "black-myth-wukong",
    ]);
    expect(filterGames(games, { query: "巫师" })[0]?.slug).toBe("the-witcher-3");
  });

  it("searches by exact Steam App ID", () => {
    expect(filterGames(games, { query: "2358720" }).map((game) => game.slug)).toEqual([
      "black-myth-wukong",
    ]);
  });

  it("combines genre, platform and year filters", () => {
    const result = filterGames(games, { genre: "Action RPG", platform: "PC", year: "2024" });
    expect(result.map((game) => game.slug)).toContain("black-myth-wukong");
    expect(result.every((game) => game.releaseDate.startsWith("2024"))).toBe(true);
  });

  it("sorts by rating and release date", () => {
    const rated = filterGames(games, { sort: "rating" });
    const newest = filterGames(games, { sort: "newest" });
    expect(rated[0]!.rating).toBeGreaterThanOrEqual(rated[1]!.rating);
    expect(newest[0]!.releaseDate >= newest[1]!.releaseDate).toBe(true);
  });

  it("finds a game by slug", () => {
    expect(getGameBySlug("black-myth-wukong")?.title).toBe("Black Myth: Wukong");
    expect(getGameBySlug("missing-game")).toBeUndefined();
  });

  it("returns related games without the current game", () => {
    const game = getGameBySlug("black-myth-wukong")!;
    const related = getRelatedGames(game, 4);
    expect(related).toHaveLength(4);
    expect(related.some((item) => item.id === game.id)).toBe(false);
    expect(related.some((item) => item.genres.some((genre) => game.genres.includes(genre)))).toBe(true);
  });
});
