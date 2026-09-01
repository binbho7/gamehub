import type { Game, GameSort, ReleaseStatus } from "@/types/game";

export type GameFilters = {
  query?: string;
  genre?: string;
  platform?: string;
  year?: string;
  status?: ReleaseStatus;
  free?: boolean;
  sort?: GameSort;
};

export function filterGames(source: Game[], filters: GameFilters = {}) {
  const query = filters.query?.trim().toLocaleLowerCase();
  const filtered = source.filter((game) => {
    const searchable = `${game.title} ${game.titleCn} ${game.developer} ${game.genres.join(" ")} ${game.steamAppId}`.toLocaleLowerCase();
    return (!query || searchable.includes(query))
      && (!filters.genre || game.genres.some((genre) => genre.toLowerCase() === filters.genre!.toLowerCase()))
      && (!filters.platform || game.platforms.some((platform) => platform.toLowerCase() === filters.platform!.toLowerCase()))
      && (!filters.year || game.releaseDate.startsWith(filters.year))
      && (!filters.status || game.status === filters.status)
      && (filters.free === undefined || game.isFree === filters.free);
  });

  return [...filtered].sort((a, b) => {
    switch (filters.sort) {
      case "newest": return b.releaseDate.localeCompare(a.releaseDate);
      case "oldest": return a.releaseDate.localeCompare(b.releaseDate);
      case "title": return a.title.localeCompare(b.title);
      case "rating":
      case "popular":
      default: return b.rating - a.rating;
    }
  });
}
