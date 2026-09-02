import { describe, expect, it } from "vitest";
import { companyCollisionSlug, toCanonicalSlug } from "./slug";

describe("canonical slugs", () => {
  it.each([
    ["Élden Ring™", "steam-1245620", "elden-ring"],
    ["...Elden!!! Ring???", "steam-1245620", "elden-ring"],
    ["---elden-ring---", "steam-1245620", "elden-ring"],
    ["a".repeat(200), "steam-1245620", "a".repeat(160)],
    ["艾尔登法环", "steam-1245620", "steam-1245620"],
  ])("normalizes %j", (value, fallback, expected) => {
    expect(toCanonicalSlug(value, fallback)).toBe(expected);
  });

  it("uses a stable hash suffix for the same normalized company name", async () => {
    const first = await companyCollisionSlug("fromsoftware", "FromSoftware, Inc.");
    const second = await companyCollisionSlug("fromsoftware", "FromSoftware, Inc.");

    expect(first).toBe(second);
    expect(first).toMatch(/^fromsoftware-[a-f0-9]{8}$/);
  });
});
