import type { GameFilters } from "./game-filter";
const sorts = new Set(["popular", "rating", "newest", "oldest", "title"]);
const statuses = new Set(["released", "upcoming"]);
type GameFilterCapabilities = { hasRatings?: boolean; hasFreeStatus?: boolean };
export function parseGameFilters(params: URLSearchParams, capabilities: boolean | GameFilterCapabilities = true): GameFilters {
  const hasRatings = typeof capabilities === "boolean" ? capabilities : capabilities.hasRatings ?? true;
  const hasFreeStatus = typeof capabilities === "boolean" ? true : capabilities.hasFreeStatus ?? false;
  const value = (key: string) => params.get(key)?.trim() || undefined;
  const requestedSort = value("sort");
  const sort = !hasRatings && (requestedSort === "popular" || requestedSort === "rating") ? "title" : requestedSort;
  const status = value("status");
  const free = value("free");
  return {
    query: value("q"), genre: value("genre"), platform: value("platform"), year: value("year"),
    sort: sort && sorts.has(sort) ? sort as GameFilters["sort"] : undefined,
    status: status && statuses.has(status) ? status as GameFilters["status"] : undefined,
    free: hasFreeStatus && free === "true" ? true : hasFreeStatus && free === "false" ? false : undefined,
  };
}
export function parseSearchQuery(params: URLSearchParams): string { return params.get("q")?.trim() ?? ""; }
