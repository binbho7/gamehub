export type SearchGameRecord = {
  slug: string;
  title: string;
  developer: string;
  publisher: string;
  releaseDate: string;
  cover: string;
  genres: string[];
};

export type GameBrowseRecord = SearchGameRecord & { status: "released" | "upcoming"; genreSlugs: string[]; platforms: string[]; platformSlugs: string[] };

export function toGameBrowseRecord(game: PublishedGame): GameBrowseRecord {
  return { slug: game.slug, title: game.title, developer: game.developer, publisher: game.publisher, releaseDate: game.releaseDate, status: game.status, cover: game.cover, genres: game.genres, genreSlugs: game.genreSlugs, platforms: game.platforms, platformSlugs: game.platformSlugs };
}
export function filterSearchRecords(source: SearchGameRecord[], query: string): SearchGameRecord[] { const normalized = query.trim().toLocaleLowerCase(); return source.filter((game) => !normalized || `${game.title} ${game.developer} ${game.publisher} ${game.genres.join(" ")}`.toLocaleLowerCase().includes(normalized)); }
import type { PublishedGame } from "./site-data/contracts";
