import type { GameFilters } from "./game-filter";
const sorts = new Set(["popular", "rating", "newest", "oldest", "title"]);
const statuses = new Set(["released", "upcoming"]);
export function parseGameFilters(params: URLSearchParams): GameFilters { const value = (key: string) => params.get(key)?.trim() || undefined; const sort = value("sort"); const status = value("status"); const free = value("free"); return { query: value("q"), genre: value("genre"), platform: value("platform"), year: value("year"), sort: sort && sorts.has(sort) ? sort as GameFilters["sort"] : undefined, status: status && statuses.has(status) ? status as GameFilters["status"] : undefined, free: free === "true" ? true : free === "false" ? false : undefined }; }
export function parseSearchQuery(params: URLSearchParams): string { return params.get("q")?.trim() ?? ""; }
