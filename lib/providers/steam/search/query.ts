export const STEAM_SEARCH_DEFAULT_LIMIT = 10;
export const STEAM_SEARCH_MAX_LIMIT = 10;
export const STEAM_SEARCH_MAX_QUERY_CODE_POINTS = 100;

export type SteamSearchInput = { query: string; limit: number };

export function validateSteamSearchInput(
  query: string,
  limit = STEAM_SEARCH_DEFAULT_LIMIT,
): SteamSearchInput {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) throw new Error("empty_query");
  if (Array.from(normalizedQuery).length > STEAM_SEARCH_MAX_QUERY_CODE_POINTS) {
    throw new Error("query_too_long");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > STEAM_SEARCH_MAX_LIMIT) {
    throw new Error("invalid_limit");
  }
  return { query: normalizedQuery, limit };
}
