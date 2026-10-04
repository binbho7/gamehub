import { describe, expect, it } from "vitest";
import { isSafeBatchId } from "./batch-id";

describe("batch id safety", () => {
  it.each(["v2-11-batch-004", "batch_004", "release.004"])("accepts %s", (value) => {
    expect(isSafeBatchId(value)).toBe(true);
  });

  it.each([".nightly", "../batch", "batch/004", "batch\\004", "batch..004", " batch", "batch ", ""])("rejects %j", (value) => {
    expect(isSafeBatchId(value)).toBe(false);
  });
});
