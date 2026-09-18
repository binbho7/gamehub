import { describe, expect, it } from "vitest";
import { parseGameFilters, parseSearchQuery } from "./static-query";

describe("static query parsing", () => {
  it("parses valid games filters and ignores invalid values", () => {
    expect(parseGameFilters(new URLSearchParams("q= elden &genre=Action&platform=PC&year=2024&sort=rating&status=released&free=true"))).toEqual({
      query: "elden", genre: "Action", platform: "PC", year: "2024", sort: "rating", status: "released", free: true,
    });
    expect(parseGameFilters(new URLSearchParams("sort=bad&status=bad&free=wat"))).toEqual({});
  });

  it("trims search queries and preserves empty/default state", () => {
    expect(parseSearchQuery(new URLSearchParams())).toBe("");
    expect(parseSearchQuery(new URLSearchParams("q=%20elden%20"))).toBe("elden");
  });
});
