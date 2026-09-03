import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSteamSearchResponse } from "./response";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(process.cwd(), "test/fixtures/steam", name), "utf8"));
}

describe("Steam search response adapter", () => {
  it("returns raw items while preserving loose fields", () => {
    expect(parseSteamSearchResponse({
      items: [{ id: 10, name: "Example", type: "app", ignored: true }],
      ignored_top_level: true,
    })).toMatchObject({ items: [{ id: 10, name: "Example", type: "app" }] });
  });

  it("accepts an empty item list", () => {
    expect(parseSteamSearchResponse({ items: [] })).toEqual({ items: [] });
  });

  it("accepts absent, numeric, string, null, and object totals", () => {
    for (const total of [undefined, 1, "1", null, { future: true }]) {
      const body = total === undefined ? { items: [] } : { items: [], total };
      expect(() => parseSteamSearchResponse(body)).not.toThrow();
    }
  });

  it("accepts sub item types without filtering them", () => {
    expect(parseSteamSearchResponse({ items: [{ id: 10, name: "Example", type: "sub" }] })).toEqual({
      items: [{ id: 10, name: "Example", type: "sub" }],
    });
  });

  it("maps malformed consumed data to non-retryable schema_changed", () => {
    expect(() => parseSteamSearchResponse(fixture("search-malformed.json"))).toThrowError(
      expect.objectContaining({ code: "schema_changed", retryable: false }),
    );
  });
});
