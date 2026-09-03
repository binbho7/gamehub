import { describe, expect, it } from "vitest";
import { normalizeSteamSearch } from "./normalize";

describe("normalizeSteamSearch", () => {
  it("retains only the exact lower-case app Store type", () => {
    const normalized = normalizeSteamSearch({
      items: [
        { id: 10, name: "Base app", type: "app" },
        { id: 20, name: "Package", type: "sub" },
        { id: 30, name: "Bundle", type: "bundle" },
        { id: 40, name: "Unexpected", type: "APP" },
      ],
    }, 10);

    expect(normalized.results).toEqual([
      { appId: "10", name: "Base app", type: "unknown", imageUrl: null },
    ]);
    expect(normalized.warnings.filter(
      (warning) => warning.code === "unsupported_store_item_type",
    )).toHaveLength(3);
  });

  it.each([
    ["Base game", "Elden Ring"],
    ["DLC", "Elden Ring Shadow of the Erdtree DLC"],
    ["Demo", "Elden Ring Demo"],
    ["Soundtrack", "Elden Ring Soundtrack"],
    ["Software", "SteamVR"],
    ["Tool", "Proton EasyAntiCheat Runtime"],
  ])("retains a named %s app as unknown", (_kind, name) => {
    expect(normalizeSteamSearch({ items: [{ id: 10, name, type: "app" }] }, 10).results).toEqual([
      { appId: "10", name, type: "unknown", imageUrl: null },
    ]);
  });

  it("keeps valid HTTP(S) images", () => {
    const normalized = normalizeSteamSearch({
      items: [
        { id: 10, name: "HTTP", type: "app", tiny_image: "http://images.example.test/10.jpg" },
        { id: 20, name: "HTTPS", type: "app", tiny_image: "https://images.example.test/20.jpg" },
      ],
    }, 10);

    expect(normalized.results).toEqual([
      { appId: "10", name: "HTTP", type: "unknown", imageUrl: "http://images.example.test/10.jpg" },
      { appId: "20", name: "HTTPS", type: "unknown", imageUrl: "https://images.example.test/20.jpg" },
    ]);
    expect(normalized.warnings).toEqual([]);
  });

  it("uses null without a warning when an image is missing", () => {
    const normalized = normalizeSteamSearch({ items: [{ id: 10, name: "No image", type: "app" }] }, 10);

    expect(normalized.results[0]?.imageUrl).toBeNull();
    expect(normalized.warnings).toEqual([]);
  });

  it.each([
    "not a URL",
    "ftp://images.example.test/10.jpg",
    "http://",
  ])("drops invalid image URL %j and reports it", (tiny_image) => {
    const normalized = normalizeSteamSearch({ items: [{ id: 10, name: "Bad image", type: "app", tiny_image }] }, 10);

    expect(normalized.results).toEqual([
      { appId: "10", name: "Bad image", type: "unknown", imageUrl: null },
    ]);
    expect(normalized.warnings).toEqual([
      {
        code: "invalid_image_url",
        message: "Ignored invalid image URL for App ID: 10",
        itemIndex: 0,
        appId: "10",
      },
    ]);
  });

  it("keeps the first retained App ID and its image", () => {
    const normalized = normalizeSteamSearch({
      items: [
        { id: 10, name: "First", type: "app", tiny_image: "https://images.example.test/first.jpg" },
        { id: 10, name: "Second", type: "app", tiny_image: "https://images.example.test/second.jpg" },
      ],
    }, 10);

    expect(normalized.results).toEqual([
      { appId: "10", name: "First", type: "unknown", imageUrl: "https://images.example.test/first.jpg" },
    ]);
    expect(normalized.warnings).toEqual([
      {
        code: "duplicate_app_id",
        message: "Ignored duplicate App ID: 10",
        itemIndex: 1,
        appId: "10",
      },
    ]);
  });

  it("does not let a preceding non-app suppress a later app with the same ID", () => {
    const normalized = normalizeSteamSearch({
      items: [
        { id: 10, name: "Package", type: "sub" },
        { id: 10, name: "Game", type: "app" },
      ],
    }, 10);

    expect(normalized.results).toEqual([
      { appId: "10", name: "Game", type: "unknown", imageUrl: null },
    ]);
    expect(normalized.warnings).toEqual([
      {
        code: "unsupported_store_item_type",
        message: "Ignored Steam Store item type: sub",
        itemIndex: 0,
        storeItemType: "sub",
      },
    ]);
  });

  it("preserves provider order among first retained occurrences", () => {
    const normalized = normalizeSteamSearch({
      items: [
        { id: 30, name: "Third ID", type: "app" },
        { id: 10, name: "First ID", type: "app" },
        { id: 30, name: "Third ID duplicate", type: "app" },
        { id: 20, name: "Second ID", type: "app" },
      ],
    }, 10);

    expect(normalized.results.map((result) => result.appId)).toEqual(["30", "10", "20"]);
  });

  it("filters and deduplicates before applying the result limit", () => {
    const normalized = normalizeSteamSearch({
      items: [
        { id: 1, name: "Unsupported", type: "sub" },
        { id: 2, name: "First", type: "app" },
        { id: 2, name: "Duplicate", type: "app" },
        { id: 3, name: "Second", type: "app" },
      ],
    }, 2);

    expect(normalized.results.map((result) => result.appId)).toEqual(["2", "3"]);
    expect(normalized.warnings.map((warning) => warning.code)).toEqual([
      "unsupported_store_item_type",
      "duplicate_app_id",
    ]);
  });

  it("reports one warning when unique retained apps exceed the limit", () => {
    const normalized = normalizeSteamSearch({
      items: [
        { id: 1, name: "One", type: "app" },
        { id: 2, name: "Two", type: "app" },
        { id: 3, name: "Three", type: "app" },
      ],
    }, 2);

    expect(normalized.results.map((result) => result.appId)).toEqual(["1", "2"]);
    expect(normalized.warnings).toContainEqual({
      code: "result_limit_applied",
      message: "Limited 3 results to 2",
    });
    expect(normalized.warnings.filter((warning) => warning.code === "result_limit_applied")).toHaveLength(1);
  });

  it("does not report a limit warning when retained apps exactly equal the limit", () => {
    const normalized = normalizeSteamSearch({
      items: [
        { id: 1, name: "One", type: "app" },
        { id: 2, name: "Two", type: "app" },
      ],
    }, 2);

    expect(normalized.warnings).toEqual([]);
  });

  it("does not mutate the provider item array", () => {
    const response = {
      items: [{ id: 10, name: "  Preserved name  ", type: "app", tiny_image: "https://images.example.test/10.jpg" }],
    };
    const original = structuredClone(response);

    normalizeSteamSearch(response, 10);

    expect(response).toEqual(original);
  });
});
