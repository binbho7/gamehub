import { expect, it } from "vitest";
import { publicError } from "./errors";
import { STAGE_NAMES } from "./types";

it("defines four stages and fixed public fatal diagnostics", () => {
  expect(STAGE_NAMES).toEqual(["steam", "igdb", "links", "images"]);
  expect(publicError("cleanup_failed")).toEqual({
    code: "cleanup_failed",
    message: "The local bulk sync platform could not be disposed.",
  });
  expect(Object.keys(publicError("batch_execution_failed")).sort()).toEqual([
    "code",
    "message",
  ]);
});

it("all fatal diagnostics contain only code and fixed message", () => {
  const expected = {
    configuration_error: "Bulk sync input or configuration is invalid.",
    platform_unavailable: "The local bulk sync platform could not be acquired.",
    composition_failed: "Bulk sync stage dependencies could not be created.",
    batch_execution_failed: "Bulk sync could not produce a complete batch result.",
    cleanup_failed: "The local bulk sync platform could not be disposed.",
    output_format_failed: "The bulk sync result could not be formatted.",
    output_write_failed: "The bulk sync result could not be written.",
  } as const;

  for (const [code, message] of Object.entries(expected)) {
    expect(publicError(code as keyof typeof expected)).toEqual({ code, message });
    expect(Object.keys(publicError(code as keyof typeof expected)).sort()).toEqual([
      "code",
      "message",
    ]);
  }
});
