import { IgdbError } from "../providers/igdb/errors";

function invalidCanonicalGameId(): never {
  throw new IgdbError("invalid_game_id", "Invalid canonical GameHub game ID", {
    retryable: false,
  });
}

export function normalizeCanonicalGameId(input: unknown): number {
  if (typeof input === "number") {
    if (Number.isSafeInteger(input) && input > 0) {
      return input;
    }

    return invalidCanonicalGameId();
  }

  if (typeof input === "string" && /^\d+$/.test(input)) {
    const normalized = Number(input);
    if (Number.isSafeInteger(normalized) && normalized > 0) {
      return normalized;
    }
  }

  return invalidCanonicalGameId();
}
