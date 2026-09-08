import { LinkVerificationError } from "./errors";

function invalidCanonicalGameId(): never {
  throw new LinkVerificationError(
    "invalid_game_id",
    "Invalid canonical GameHub game ID",
  );
}

export function normalizeCanonicalGameId(input: string | number): number {
  if (typeof input === "number") {
    if (Number.isSafeInteger(input) && input > 0) return input;
    return invalidCanonicalGameId();
  }

  if (/^\d+$/.test(input)) {
    const normalized = Number(input);
    if (Number.isSafeInteger(normalized) && normalized > 0) return normalized;
  }

  return invalidCanonicalGameId();
}
