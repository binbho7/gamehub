import { describe, expect, it } from "vitest";
import { buildTaxonomyNavigation } from "../../lib/site-data/navigation";

describe("header taxonomy navigation", () => {
  it("deduplicates platforms by canonical slug for both navigation surfaces", () => {
    const result = buildTaxonomyNavigation([
      { name: "Windows", slug: "windows" },
      { name: "Windows", slug: "windows" },
      { name: "Linux", slug: "linux" },
    ], [{ name: "Action", slug: "action" }]);
    expect(result.platforms).toEqual([{ label: "Linux", href: "/platforms/linux" }, { label: "PC", href: "/platforms/windows" }]);
    expect(result.mobile).toEqual(result.desktop);
  });
});
