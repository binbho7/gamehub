export function hasPublishedRatingSignal(games: Array<{ optional: { rating: number | null } }>): boolean {
  return games.some((game) => game.optional.rating !== null);
}
