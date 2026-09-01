import { games } from "./mock-data";
import type { Game } from "../types/game";

export { filterGames, type GameFilters } from "./game-filter";

export const getGameBySlug = (slug: string) => games.find((game) => game.slug === slug);

export function getRelatedGames(game: Game, limit = 6) {
  return games
    .filter((candidate) => candidate.id !== game.id)
    .map((candidate) => ({
      game: candidate,
      score: candidate.genres.filter((genre) => game.genres.includes(genre)).length * 2
        + candidate.platforms.filter((platform) => game.platforms.includes(platform)).length,
    }))
    .sort((a, b) => b.score - a.score || b.game.rating - a.game.rating)
    .slice(0, limit)
    .map(({ game: candidate }) => candidate);
}
