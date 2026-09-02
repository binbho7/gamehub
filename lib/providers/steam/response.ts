import { SteamProviderError, type SteamResponseErrorCode } from "./errors";
import { steamAppDetailsBodySchema, type SteamAppDetails } from "./schema";

function responseError(code: SteamResponseErrorCode, message: string): SteamProviderError {
  return new SteamProviderError(code, message, { retryable: false });
}

export function parseSteamAppDetails(body: unknown, requestedAppId: string): SteamAppDetails {
  const parsedBody = steamAppDetailsBodySchema.safeParse(body);

  if (!parsedBody.success) {
    throw responseError("schema_changed", "Steam app-details response schema changed");
  }

  const envelope = parsedBody.data[requestedAppId];
  if (!envelope) {
    throw responseError("schema_changed", "Steam app-details response omitted the requested App ID");
  }

  if (!envelope.success) {
    throw responseError("app_not_found", "Steam application was not found");
  }

  const details = envelope.data;
  if (String(details.steam_appid) !== requestedAppId) {
    throw responseError("app_id_mismatch", "Steam application ID did not match the requested App ID");
  }

  if (details.type !== "game") {
    throw responseError("unsupported_app_type", "Steam application type is not a game");
  }

  return details;
}
