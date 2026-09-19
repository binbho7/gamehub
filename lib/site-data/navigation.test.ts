import { describe, expect, it } from "vitest";
import { buildTaxonomyNavigation } from "./navigation";

const records = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => ({ name: `${prefix} ${index}`, slug: `${prefix.toLowerCase()}-${index}` }));

describe("bounded taxonomy navigation", () => {
  it("keeps a small published taxonomy visible", () => {
    const navigation = buildTaxonomyNavigation(records("Platform", 2), records("Genre", 2));
    expect(navigation.desktop).toHaveLength(4);
    expect(navigation.desktop.map((item) => item.href)).toEqual(expect.arrayContaining(["/genres/genre-0", "/platforms/platform-0"]));
  });

  it("caps direct taxonomy links and uses only published slugs", () => {
    const navigation = buildTaxonomyNavigation(records("Platform", 20), records("Genre", 20));
    expect(navigation.desktop).toHaveLength(6);
    expect(navigation.mobile).toHaveLength(6);
    expect(navigation.desktop.every((item) => item.href.startsWith("/genres/") || item.href.startsWith("/platforms/"))).toBe(true);
  });
});
