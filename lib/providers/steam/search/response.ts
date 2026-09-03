import { SteamSearchError } from "./errors";
import { steamSearchRawResponseSchema, type SteamSearchRawResponse } from "./schema";

export function parseSteamSearchResponse(body: unknown): SteamSearchRawResponse {
  const parsed = steamSearchRawResponseSchema.safeParse(body);

  if (!parsed.success) {
    throw new SteamSearchError("schema_changed", "Steam search response schema changed", {
      retryable: false,
      cause: parsed.error,
    });
  }

  return parsed.data;
}
