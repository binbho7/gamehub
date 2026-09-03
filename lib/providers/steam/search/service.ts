import { createSteamSearchClient, type SteamSearchClient } from "./client";
import type { SteamSearchResult, SteamSearchWarning } from "./contracts";
import { normalizeSteamSearch } from "./normalize";
import { validateSteamSearchInput } from "./query";
import { parseSteamSearchResponse } from "./response";

export type SteamSearchOptions = {
  limit?: number;
};

export type SteamSearchResponse = {
  query: string;
  results: SteamSearchResult[];
  warnings: SteamSearchWarning[];
};

export type SteamSearchService = {
  search(query: string, options?: SteamSearchOptions): Promise<SteamSearchResponse>;
};

export function createSteamSearchService(
  options: { client?: SteamSearchClient } = {},
): SteamSearchService {
  const client = options.client ?? createSteamSearchClient();

  return {
    async search(query, searchOptions = {}) {
      const input = validateSteamSearchInput(query, searchOptions.limit);
      const http = await client.search(input.query);
      const raw = parseSteamSearchResponse(http.body);
      const normalized = normalizeSteamSearch(raw, input.limit);
      return { query: input.query, ...normalized };
    },
  };
}
