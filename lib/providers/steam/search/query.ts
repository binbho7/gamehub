import { SteamSearchError, type SteamSearchInputReason } from "./errors";

export const STEAM_SEARCH_DEFAULT_LIMIT = 10;
export const STEAM_SEARCH_MAX_LIMIT = 10;
export const STEAM_SEARCH_MAX_QUERY_CODE_POINTS = 100;

export type SteamSearchInput = { query: string; limit: number };

function invalidSearchQuery(reason: SteamSearchInputReason): SteamSearchError {
  const messages: Record<SteamSearchInputReason, string> = {
    empty_query: "Steam search query cannot be empty",
    query_too_long: "Steam search query cannot exceed 100 Unicode code points",
    invalid_limit: "Steam search limit must be an integer from 1 through 10",
  };
  return new SteamSearchError("invalid_search_query", messages[reason], {
    retryable: false,
    reason,
  });
}

export function validateSteamSearchInput(
  query: string,
  limit = STEAM_SEARCH_DEFAULT_LIMIT,
): SteamSearchInput {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) throw invalidSearchQuery("empty_query");
  if (Array.from(normalizedQuery).length > STEAM_SEARCH_MAX_QUERY_CODE_POINTS) {
    throw invalidSearchQuery("query_too_long");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > STEAM_SEARCH_MAX_LIMIT) {
    throw invalidSearchQuery("invalid_limit");
  }
  return { query: normalizedQuery, limit };
}
