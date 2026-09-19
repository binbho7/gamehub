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

  it.each(["popular", "rating"])("normalizes unsupported rating sort %s when ratings are unavailable", (sort) => {
    expect(parseGameFilters(new URLSearchParams(`sort=${sort}`), false).sort).toBe("title");
  });

  it("preserves supported sorts and rating sorts when ratings exist", () => {
    expect(parseGameFilters(new URLSearchParams("sort=title"), false).sort).toBe("title");
    expect(parseGameFilters(new URLSearchParams("sort=newest"), false).sort).toBe("newest");
    expect(parseGameFilters(new URLSearchParams("sort=popular"), true).sort).toBe("popular");
    expect(parseGameFilters(new URLSearchParams("sort=rating"), true).sort).toBe("rating");
  });

  it("removes unsupported free filters when free status is unavailable", () => {
    expect(parseGameFilters(new URLSearchParams("free=true"), { hasRatings: false, hasFreeStatus: false }).free).toBeUndefined();
    expect(parseGameFilters(new URLSearchParams("free=false"), { hasRatings: false, hasFreeStatus: false }).free).toBeUndefined();
  });

  it("preserves free filters only when free status is available", () => {
    expect(parseGameFilters(new URLSearchParams("free=true"), { hasRatings: false, hasFreeStatus: true }).free).toBe(true);
    expect(parseGameFilters(new URLSearchParams("free=false"), { hasRatings: false, hasFreeStatus: true }).free).toBe(false);
  });
});
