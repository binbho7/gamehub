import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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

  it("keeps the mobile menu viewport-bound and compact on short screens", () => {
    const source = readFileSync(new URL("./header-client.tsx", import.meta.url), "utf8");

    expect(source).toContain("max-h-[calc(100dvh-4rem)]");
    expect(source).toContain("overflow-y-auto");
    expect(source).toContain("overscroll-contain");
    expect(source).toContain("grid-cols-2");
  });
});
