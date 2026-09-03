import { describe, expect, it } from "vitest";
import { validateSteamSearchInput } from "./query";

describe("validateSteamSearchInput", () => {
  it("trims query boundaries and defaults limit to ten", () => {
    expect(validateSteamSearchInput("  elden  ring  ")).toEqual({
      query: "elden  ring",
      limit: 10,
    });
  });

  it("preserves Unicode query text", () => {
    expect(validateSteamSearchInput("  黑神话：悟空  ", 5)).toEqual({
      query: "黑神话：悟空",
      limit: 5,
    });
  });

  it("counts Unicode code points rather than UTF-16 code units", () => {
    expect(validateSteamSearchInput("🎮".repeat(100))).toMatchObject({ limit: 10 });
    expect(() => validateSteamSearchInput("🎮".repeat(101))).toThrow();
  });

  it.each(["", "   ", "\n\t"])("rejects empty query %j", (query) => {
    expect(() => validateSteamSearchInput(query)).toThrow();
  });

  it.each([0, -1, 1.5, 11, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid limit %s",
    (limit) => expect(() => validateSteamSearchInput("elden ring", limit)).toThrow(),
  );

  it.each([1, 10])("accepts boundary limit %s", (limit) => {
    expect(validateSteamSearchInput("elden ring", limit).limit).toBe(limit);
  });
});
