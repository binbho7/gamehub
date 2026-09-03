import { describe, expect, it } from "vitest";
import type {
  SteamSearchNormalizationResult,
  SteamSearchResult,
  SteamSearchWarning,
  SteamSearchWarningCode,
} from "./contracts";

function describeWarningCode(code: SteamSearchWarningCode): string {
  switch (code) {
    case "invalid_image_url":
      return "invalid image URL";
    case "duplicate_app_id":
      return "duplicate App ID";
    case "unsupported_store_item_type":
      return "unsupported Store item type";
    case "result_limit_applied":
      return "result limit applied";
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

describe("Steam search normalization contracts", () => {
  it("provides the stable result, warning, and normalization shapes", () => {
    const result = {
      appId: "10",
      name: "Example",
      type: "unknown",
      imageUrl: null,
    } satisfies SteamSearchResult;
    const warning = {
      code: "duplicate_app_id",
      message: "Ignored duplicate App ID: 10",
      itemIndex: 1,
      appId: "10",
    } satisfies SteamSearchWarning;
    const normalized = {
      results: [result],
      warnings: [warning],
    } satisfies SteamSearchNormalizationResult;

    expect(normalized).toEqual({ results: [result], warnings: [warning] });
  });

  it("covers every supported warning code", () => {
    expect([
      describeWarningCode("invalid_image_url"),
      describeWarningCode("duplicate_app_id"),
      describeWarningCode("unsupported_store_item_type"),
      describeWarningCode("result_limit_applied"),
    ]).toEqual([
      "invalid image URL",
      "duplicate App ID",
      "unsupported Store item type",
      "result limit applied",
    ]);
  });
});
