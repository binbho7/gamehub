import type { GameBrowseRecord } from "@/lib/search-contract";
import type { GameSort, ReleaseStatus } from "@/types/game";

export type GameFilters = {
  query?: string;
  genre?: string;
  platform?: string;
  year?: string;
  status?: ReleaseStatus;
  free?: boolean;
  sort?: GameSort;
};

export function filterGames<T extends GameBrowseRecord>(source: T[], filters: GameFilters = {}) {
  const query = filters.query?.trim().toLocaleLowerCase();
  const filtered = source.filter((game) => {
    const searchable = `${game.title} ${game.developer} ${game.publisher} ${game.genres.join(" ")}`.toLocaleLowerCase();
    const matchesFree = filters.free === undefined
      || !("optional" in game)
      || (typeof game.optional === "object" && game.optional !== null && "isFree" in game.optional && game.optional.isFree === filters.free);
    return (!query || searchable.includes(query))
      && (!filters.genre || game.genres.some((genre) => genre.toLowerCase() === filters.genre!.toLowerCase()))
      && (!filters.platform || game.platforms.some((platform) => platform.toLowerCase() === filters.platform!.toLowerCase()))
      && (!filters.year || game.releaseDate.startsWith(filters.year))
      && (!filters.status || game.status === filters.status)
      && matchesFree;
  });

  return [...filtered].sort((a, b) => {
    switch (filters.sort) {
      case "newest": return b.releaseDate.localeCompare(a.releaseDate);
      case "oldest": return a.releaseDate.localeCompare(b.releaseDate);
      case "title": return a.title.localeCompare(b.title);
      default: return a.title.localeCompare(b.title);
    }
  });
}
