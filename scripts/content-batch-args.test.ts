import { describe, expect, it } from "vitest";
import { parseArgs } from "./content-batch";

const base = ["plan", "--count", "10", "--snapshot-date", "2026-10-04"];

describe("content batch CLI arguments", () => {
  it("allows an omitted batch id for deterministic defaulting", () => {
    expect(parseArgs(base).batchId).toBeUndefined();
  });

  it.each(["v2-11-batch-004", "2026-release"])("accepts batch id %s", (batchId) => {
    expect(parseArgs([...base, "--batch-id", batchId]).batchId).toBe(batchId);
  });

  it.each([
    { argv: [...base, "--batch-id", ""] },
    { argv: [...base, "--batch-id"] },
    { argv: [...base, "--batch-id", "--json"] },
    { argv: [...base, "--batch-id", ".nightly"] },
    { argv: [...base, "--batch-id", "../x"] },
  ])("rejects invalid or missing batch-id values", ({ argv }) => {
    expect(() => parseArgs(argv)).toThrow();
  });

  it.each(["--count", "--snapshot-date"])("rejects a missing value for %s", (option) => {
    expect(() => parseArgs(["plan", option, "--json"])).toThrow();
  });
});
