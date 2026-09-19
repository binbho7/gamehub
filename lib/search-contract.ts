export type SearchGameRecord = {
  slug: string;
  title: string;
  developer: string;
  publisher: string;
  releaseDate: string;
  cover: string;
  genres: string[];
};
export function filterSearchRecords(source: SearchGameRecord[], query: string): SearchGameRecord[] { const normalized = query.trim().toLocaleLowerCase(); return source.filter((game) => !normalized || `${game.title} ${game.developer} ${game.publisher} ${game.genres.join(" ")}`.toLocaleLowerCase().includes(normalized)); }
