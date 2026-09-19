import type { PublishedGame } from "./site-data/contracts";

export function selectUpcomingGames(games: PublishedGame[], limit = 6): PublishedGame[] {
  return games.filter((game) => game.status === "upcoming").slice(0, limit);
}
