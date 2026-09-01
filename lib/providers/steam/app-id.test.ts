import { describe, expect, it } from "vitest";
import { normalizeSteamAppId } from "./app-id";
import { SteamProviderError } from "./errors";

describe("Steam App ID", () => {
  it.each([[1245620, "1245620"], ["001245620", "1245620"]])(
    "normalizes %s",
    (input, expected) => expect(normalizeSteamAppId(input)).toBe(expected),
  );

  it.each(["", "abc", "1.5", "-1", "0", "4294967296", Number.NaN])(
    "rejects %s",
    (input) => expect(() => normalizeSteamAppId(input)).toThrowError(
      expect.objectContaining({ code: "invalid_app_id", retryable: false }),
    ),
  );

  it("preserves structured error metadata", () => {
    const error = new SteamProviderError("rate_limited", "Steam rate limited", {
      retryable: true,
      status: 429,
      retryAfter: "30",
    });
    expect(error).toMatchObject({ code: "rate_limited", retryable: true, status: 429, retryAfter: "30" });
  });
});
