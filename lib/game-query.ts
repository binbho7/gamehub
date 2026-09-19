import type { PublishedGame } from "./site-data/contracts";

export { filterGames, type GameFilters } from "./game-filter";

export const getGameBySlug = (games: PublishedGame[], slug: string) => games.find((game) => game.slug === slug);

export function getRelatedGames(games: PublishedGame[], game: PublishedGame, limit = 6) {
  if (limit <= 0) return [];
  const top: Array<{ game: PublishedGame; score: number }> = [];
  for (const candidate of games) {
    if (candidate.slug === game.slug) continue;
    const score = candidate.genres.filter((genre) => game.genres.includes(genre)).length * 2
      + candidate.platforms.filter((platform) => game.platforms.includes(platform)).length;
    const entry = { game: candidate, score };
    let insertAt = 0;
    while (insertAt < top.length && (top[insertAt]!.score > score || (top[insertAt]!.score === score && top[insertAt]!.game.slug < candidate.slug))) insertAt += 1;
    if (insertAt < limit) top.splice(insertAt, 0, entry);
    if (top.length > limit) top.pop();
  }
  return top.map(({ game: candidate }) => candidate);
}
