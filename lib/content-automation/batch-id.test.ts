import { describe, expect, it } from "vitest";
import { isSafeBatchId } from "./batch-id";

describe("batch id safety", () => {
  it.each(["v2-11-batch-004", "2026-release", "batch_004", "release.004", "foo-lock", "foo.locked"])("accepts %s", (value) => {
    expect(isSafeBatchId(value)).toBe(true);
  });

  it.each([".nightly", "../batch", "batch/004", "batch\\004", "batch..004", " batch", "batch ", "", "release.", "foo.lock"])("rejects %j", (value) => {
    expect(isSafeBatchId(value)).toBe(false);
  });

  it("accepts 64 characters and rejects 65", () => {
    expect(isSafeBatchId(`a${"b".repeat(63)}`)).toBe(true);
    expect(isSafeBatchId(`a${"b".repeat(64)}`)).toBe(false);
  });
});
