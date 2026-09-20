import { describe, expect, it } from "vitest";
import { INITIAL_PAGE_SIZE, nextPageSize, takeInitialPage, takeVisiblePage } from "./catalog-pagination";

describe("catalog pagination", () => {
  it("keeps small catalogs intact and bounds large initial pages", () => {
    expect(takeInitialPage([1, 2, 3])).toEqual([1, 2, 3]);
    expect(takeInitialPage(Array.from({ length: 100 }, (_, index) => index))).toHaveLength(INITIAL_PAGE_SIZE);
  });

  it("grows by one bounded page without dropping records", () => {
    const games = Array.from({ length: 100 }, (_, index) => index);
    expect(takeVisiblePage(games, INITIAL_PAGE_SIZE)).toHaveLength(24);
    expect(takeVisiblePage(games, nextPageSize(INITIAL_PAGE_SIZE))).toHaveLength(48);
    expect(takeVisiblePage(Array.from({ length: 10 }, (_, index) => index), INITIAL_PAGE_SIZE)).toHaveLength(10);
  });

  it("handles a ten-thousand-record query result deterministically", () => {
    const games = Array.from({ length: 10_000 }, (_, index) => ({ id: index }));
    expect(takeVisiblePage(games, INITIAL_PAGE_SIZE).map((game) => game.id)).toEqual([...Array(24).keys()]);
  });
});
