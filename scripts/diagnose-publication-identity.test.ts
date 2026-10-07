import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./diagnose-publication-identity.ts", import.meta.url), "utf8");

describe("publication identity diagnostic contract", () => {
  it("uses valid isolated Python and no JavaScript process syntax", () => {
    expect(source).toContain("import sys; sys.exit(0)");
    expect(source).not.toContain("process.exit(0)");
  });

  it("keeps Linux checks independently guarded", () => {
    expect(source).toContain('try { readlinkSync("/proc/1/ns/pid")');
    expect(source).toContain('try { readlinkSync("/proc/self/ns/pid")');
    expect(source).toContain('readResult("/proc/sys/kernel/random/boot_id")');
    expect(source).toContain("readFileSync(`/proc/${process.pid}/stat`");
  });

  it("keeps output free of raw OS identifiers", () => {
    expect(source).toContain("PUBLICATION_IDENTITY_DIAGNOSTIC_V2");
    expect(source).toContain("productionQueryState");
    expect(source).toContain('"PYTHON_DIAGNOSTIC_FAILED"');
    expect(source).not.toContain("console.log(identity");
  });
});
