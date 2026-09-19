import { describe, expect, it } from "vitest";
import { INITIAL_PAGE_SIZE, takeInitialPage } from "./catalog-pagination";

describe("catalog pagination", () => {
  it("keeps small catalogs intact and bounds large initial pages", () => {
    expect(takeInitialPage([1, 2, 3])).toEqual([1, 2, 3]);
    expect(takeInitialPage(Array.from({ length: 100 }, (_, index) => index))).toHaveLength(INITIAL_PAGE_SIZE);
  });
});

