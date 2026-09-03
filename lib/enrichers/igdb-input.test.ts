import { describe, expect, it } from "vitest";
import { normalizeCanonicalGameId } from "./igdb-input";
import { IgdbError } from "../providers/igdb/errors";

describe("canonical IGDB enrichment input", () => {
  it.each([
    [1, 1],
    ["123", 123],
    ["00123", 123],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeCanonicalGameId(input)).toBe(expected);
  });

  it.each([
    0,
    -1,
    Number.MAX_SAFE_INTEGER + 1,
    1.5,
    "",
    " ",
    "1.5",
    "-1",
    "0",
    "not-a-game-id",
    null,
    undefined,
    true,
  ])("rejects invalid canonical game ID %s", (input) => {
    expect(() => normalizeCanonicalGameId(input)).toThrowError(
      expect.objectContaining({ code: "invalid_game_id", retryable: false }),
    );
    expect(() => normalizeCanonicalGameId(input)).toThrowError(IgdbError);
  });
});
