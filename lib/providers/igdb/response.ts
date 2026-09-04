import { IgdbError } from "./errors";
import {
  igdbExternalGamesResponseSchema,
  igdbGamesResponseSchema,
  type IgdbGameRaw,
} from "./schema";

const steamExternalGameSource = 1;

function responseError(
  code: "schema_changed" | "mapping_not_found" | "mapping_ambiguous" | "unsupported_mapping" | "igdb_game_not_found",
  message: string,
): IgdbError {
  return new IgdbError(code, message, { retryable: false });
}

function hasMappingWithoutUsableGameId(body: unknown, expectedSteamAppId: string): boolean {
  if (!Array.isArray(body)) {
    return false;
  }

  return body.some((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      return false;
    }

    const mapping = row as Record<string, unknown>;
    return mapping.external_game_source === steamExternalGameSource
      && mapping.uid === expectedSteamAppId
      && !Object.hasOwn(mapping, "game");
  });
}

export function parseIgdbSteamMapping(
  body: unknown,
  expectedSteamAppId: string,
): { igdbGameId: number } {
  const parsedBody = igdbExternalGamesResponseSchema.safeParse(body);

  if (!parsedBody.success) {
    if (hasMappingWithoutUsableGameId(body, expectedSteamAppId)) {
      throw responseError("unsupported_mapping", "IGDB Steam mapping did not include a usable game ID");
    }

    throw responseError("schema_changed", "IGDB Steam mapping response schema changed");
  }

  if (parsedBody.data.length === 0) {
    throw responseError("mapping_not_found", "IGDB Steam mapping was not found");
  }

  const gameIds = new Set<number>();
  for (const mapping of parsedBody.data) {
    if (mapping.external_game_source !== steamExternalGameSource || mapping.uid !== expectedSteamAppId) {
      throw responseError("unsupported_mapping", "IGDB mapping did not match the requested Steam app ID");
    }

    gameIds.add(mapping.game);
  }

  if (gameIds.size !== 1) {
    throw responseError("mapping_ambiguous", "IGDB Steam mapping resolved to multiple games");
  }

  return { igdbGameId: gameIds.values().next().value as number };
}

export function parseIgdbGame(body: unknown, expectedIgdbGameId: number): IgdbGameRaw {
  const parsedBody = igdbGamesResponseSchema.safeParse(body);

  if (!parsedBody.success) {
    throw responseError("schema_changed", "IGDB game response schema changed");
  }

  if (parsedBody.data.length === 0) {
    throw responseError("igdb_game_not_found", "IGDB game was not found");
  }

  if (parsedBody.data.length !== 1 || parsedBody.data[0].id !== expectedIgdbGameId) {
    throw responseError("schema_changed", "IGDB game response did not match the requested game ID");
  }

  return parsedBody.data[0];
}
