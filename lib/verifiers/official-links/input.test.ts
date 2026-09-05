import { describe, expect, it } from "vitest";
import { LinkVerificationError } from "./errors";
import { normalizeCanonicalGameId } from "./input";

describe("normalizeCanonicalGameId", () => {
  it.each([
    [1, 1],
    [42, 42],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    ["1", 1],
    ["0042", 42],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ] as const)("normalizes positive safe canonical game ID %s", (input, expected) => {
    expect(normalizeCanonicalGameId(input)).toBe(expected);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "",
    "   ",
    "0",
    "-1",
    "1.5",
    "game-1",
    String(Number.MAX_SAFE_INTEGER + 1),
  ])("rejects invalid canonical game ID %j with a sanitized typed error", (input) => {
    let thrown: unknown;

    try {
      normalizeCanonicalGameId(input);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LinkVerificationError);
    expect(thrown).toMatchObject({
      code: "invalid_game_id",
      message: "Invalid canonical GameHub game ID",
    });
  });
});
