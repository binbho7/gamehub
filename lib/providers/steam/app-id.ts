import { z } from "zod";
import { SteamProviderError } from "./errors";

const MAX_STEAM_APP_ID = 4_294_967_295;
const steamAppIdSchema = z.union([
  z.number().int().min(1).max(MAX_STEAM_APP_ID),
  z.string().regex(/^\d+$/),
]);

export function normalizeSteamAppId(input: string | number): string {
  try {
    const parsed = steamAppIdSchema.parse(input);
    const numericValue = typeof parsed === "number" ? parsed : Number(parsed);

    if (!Number.isSafeInteger(numericValue) || numericValue < 1 || numericValue > MAX_STEAM_APP_ID) {
      throw new Error("out of range");
    }

    return String(numericValue);
  } catch {
    throw new SteamProviderError("invalid_app_id", "Invalid Steam App ID", { retryable: false });
  }
}
