import type { PublishedGame } from "./site-data/contracts";

export { filterGames, type GameFilters } from "./game-filter";

export const getGameBySlug = (games: PublishedGame[], slug: string) => games.find((game) => game.slug === slug);

export function getRelatedGames(games: PublishedGame[], game: PublishedGame, limit = 6) {
  return games
    .filter((candidate) => candidate.slug !== game.slug)
    .map((candidate) => ({
      game: candidate,
      score: candidate.genres.filter((genre) => game.genres.includes(genre)).length * 2
        + candidate.platforms.filter((platform) => game.platforms.includes(platform)).length,
    }))
    .sort((a, b) => b.score - a.score || (b.game.optional.rating ?? -1) - (a.game.optional.rating ?? -1))
    .slice(0, limit)
    .map(({ game: candidate }) => candidate);
}
