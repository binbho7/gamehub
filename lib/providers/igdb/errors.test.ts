import { describe, expect, it } from "vitest";
import { IgdbError } from "./errors";

describe("IgdbError", () => {
  it("preserves the stable code and retry metadata through public getters", () => {
    const error = new IgdbError("rate_limited", "IGDB rate limited", {
      retryable: true,
      status: 429,
      retryAfter: "10",
    });

    expect(error).toMatchObject({
      name: "IgdbError",
      code: "rate_limited",
      retryable: true,
      status: 429,
      retryAfter: "10",
    });
    expect(error.details).toEqual({
      retryable: true,
      status: 429,
      retryAfter: "10",
    });
  });

  it("does not expose a supplied secret through inspection or serialization", () => {
    const secret = "fake-igdb-secret-do-not-print";
    const error = new IgdbError("network_error", "IGDB network request failed", {
      retryable: false,
      cause: { secret },
    });

    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("exposes only a narrow safe write-constraint discriminator", () => {
    const error = new IgdbError("write_conflict", "IGDB enrichment write conflict", {
      retryable: false,
      constraint: "igdb_external_identity_unique",
    });

    expect(error.constraint).toBe("igdb_external_identity_unique");
    expect(error.details).toEqual({
      retryable: false,
      constraint: "igdb_external_identity_unique",
    });
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("game_external_ids");
    expect(JSON.stringify(error)).not.toContain("UNIQUE constraint failed");
  });
});
