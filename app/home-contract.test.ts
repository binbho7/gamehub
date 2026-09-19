import { describe, expect, it } from "vitest";
import { hasPublishedRatingSignal } from "../lib/site-data/presentation-policy";

describe("rating presentation policy", () => {
  it("does not expose rating views when every rating is unavailable", () => {
    expect(hasPublishedRatingSignal([{ optional: { rating: null } }, { optional: { rating: null } }])).toBe(false);
  });

  it("recognizes a real published rating signal", () => {
    expect(hasPublishedRatingSignal([{ optional: { rating: 8.5 } }])).toBe(true);
  });
});
