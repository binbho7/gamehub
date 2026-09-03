import { describe, expect, it, vi } from "vitest";
import type { SteamSearchClient } from "./client";
import { createSteamSearchService } from "./service";

function createClient(body: unknown): SteamSearchClient & { search: ReturnType<typeof vi.fn> } {
  return {
    search: vi.fn().mockResolvedValue({
      body,
      requestUrl: "https://example.test/api/storesearch/",
    }),
  };
}

describe("Steam search service", () => {
  it("validates and normalizes a trimmed query before searching", async () => {
    const client = createClient({ items: [] });
    const service = createSteamSearchService({ client });

    await expect(service.search("  黑神话：悟空  ", { limit: 5 })).resolves.toEqual({
      query: "黑神话：悟空",
      results: [],
      warnings: [],
    });
    expect(client.search).toHaveBeenCalledWith("黑神话：悟空");
  });

  it("uses the default limit of ten", async () => {
    const client = createClient({
      items: Array.from({ length: 11 }, (_, index) => ({
        id: index + 1,
        name: `Game ${index + 1}`,
        type: "app",
      })),
    });
    const service = createSteamSearchService({ client });

    const response = await service.search("elden ring");

    expect(response.results).toHaveLength(10);
    expect(response.warnings).toContainEqual({
      code: "result_limit_applied",
      message: "Limited 11 results to 10",
    });
  });

  it("returns normalizer warnings unchanged", async () => {
    const client = createClient({
      items: [
        { id: 10, name: "Base game", type: "app", tiny_image: "not a URL" },
        { id: 20, name: "Bundle", type: "bundle" },
      ],
    });
    const service = createSteamSearchService({ client });

    await expect(service.search("base game")).resolves.toEqual({
      query: "base game",
      results: [{ appId: "10", name: "Base game", type: "unknown", imageUrl: null }],
      warnings: [
        {
          code: "invalid_image_url",
          message: "Ignored invalid image URL for App ID: 10",
          itemIndex: 0,
          appId: "10",
        },
        {
          code: "unsupported_store_item_type",
          message: "Ignored Steam Store item type: bundle",
          itemIndex: 1,
          storeItemType: "bundle",
        },
      ],
    });
  });

  it("filters whitespace-padded Store types instead of treating them as apps", async () => {
    const client = createClient({
      items: [{ id: 10, name: "Whitespace-padded", type: " app " }],
    });
    const service = createSteamSearchService({ client });

    await expect(service.search("game")).resolves.toEqual({
      query: "game",
      results: [],
      warnings: [{
        code: "unsupported_store_item_type",
        message: "Ignored Steam Store item type:  app ",
        itemIndex: 0,
        storeItemType: " app ",
      }],
    });
  });

  it.each([
    ["empty query", "   ", undefined],
    ["overlong query", "🎮".repeat(101), undefined],
    ["invalid limit", "elden ring", 11],
  ])("does not call HTTP for an invalid %s", async (_description, query, limit) => {
    const client = createClient({ items: [] });
    const service = createSteamSearchService({ client });

    await expect(service.search(query, { limit })).rejects.toMatchObject({
      code: "invalid_search_query",
    });
    expect(client.search).not.toHaveBeenCalled();
  });

  it("returns only normalized app search results from a mixed Store response", async () => {
    const client = createClient({
      total: 3,
      items: [
        { id: 10, name: "Game", type: "app", tiny_image: "https://images.example.test/10.jpg" },
        { id: 20, name: "Package", type: "sub" },
        { id: 10, name: "Duplicate", type: "app" },
      ],
    });
    const service = createSteamSearchService({ client });

    const response = await service.search("game");

    expect(client.search).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      query: "game",
      results: [{
        appId: "10",
        name: "Game",
        type: "unknown",
        imageUrl: "https://images.example.test/10.jpg",
      }],
      warnings: [
        {
          code: "unsupported_store_item_type",
          message: "Ignored Steam Store item type: sub",
          itemIndex: 1,
          storeItemType: "sub",
        },
        {
          code: "duplicate_app_id",
          message: "Ignored duplicate App ID: 10",
          itemIndex: 2,
          appId: "10",
        },
      ],
    });
    expect(response).not.toHaveProperty("body");
    expect(response).not.toHaveProperty("requestUrl");
    expect(response).not.toHaveProperty("total");
  });
});
