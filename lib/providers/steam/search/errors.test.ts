import { describe, expect, it } from "vitest";
import { SteamSearchError } from "./errors";

describe("SteamSearchError", () => {
  it("preserves search error metadata", () => {
    const error = new SteamSearchError("rate_limited", "Steam search rate limited", {
      retryable: true,
      status: 429,
      retryAfter: "30",
    });
    expect(error).toMatchObject({
      name: "SteamSearchError",
      code: "rate_limited",
      retryable: true,
      status: 429,
      retryAfter: "30",
    });
  });
});
