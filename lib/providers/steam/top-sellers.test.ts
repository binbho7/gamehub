import { describe, expect, it, vi } from "vitest";
import { discoverTopSellerGames } from "./top-sellers";

const details = (id: string, type = "game") => new Response(JSON.stringify({
  [id]: { success: true, data: { type, steam_appid: Number(id), name: `Game ${id}` } },
}), { status: 200 });

describe("Steam Top Sellers discovery", () => {
  it("pages through input_json and verifies every candidate with AppDetails", async () => {
    const requests: Array<{ url: URL; input?: Record<string, unknown> }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.includes("GetWeeklyTopSellers")) {
        const parsed = JSON.parse(url.searchParams.get("input_json") ?? "null") as Record<string, unknown>;
        requests.push({ url, input: parsed });
        return new Response(JSON.stringify({ response: { ranks: [{ appid: parsed.page_start === 0 ? 1 : 2 }] } }), { status: 200 });
      }
      return details(url.searchParams.get("appids")!);
    });

    await expect(discoverTopSellerGames({ apiKey: "test-key", fetch: fetch as typeof globalThis.fetch, limit: 2, pageSize: 1 })).resolves.toEqual([
      { steamAppId: "1", title: "Game 1" },
      { steamAppId: "2", title: "Game 2" },
    ]);
    expect(requests[0].url.searchParams.get("key")).toBe("test-key");
    expect(requests[0].url.searchParams.has("page_start")).toBe(false);
    expect(requests[0].input).toMatchObject({
      page_start: 0,
      page_count: 1,
      country_code: "US",
      context: { country_code: "US", language: "english" },
      data_request: { include_basic_info: true },
    });
    expect(requests[1].input).toMatchObject({ page_start: 1, page_count: 1 });
  });

  it("treats historical IDs as exclusions, not quota", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.includes("GetWeeklyTopSellers")) return new Response(JSON.stringify({ response: { ranks: [{ appid: 1 }, { appid: 2 }] } }), { status: 200 });
      return details(url.searchParams.get("appids")!);
    });
    await expect(discoverTopSellerGames({ apiKey: "test-key", fetch: fetch as typeof globalThis.fetch, excludedIds: new Set(["1"]), limit: 1 })).resolves.toEqual([
      { steamAppId: "2", title: "Game 2" },
    ]);
  });

  it("uses AppDetails as final authority and excludes non-games", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.includes("GetWeeklyTopSellers")) return new Response(JSON.stringify({ response: { ranks: [{ appid: 1 }, { appid: 2 }] } }), { status: 200 });
      const id = url.searchParams.get("appids")!;
      return details(id, id === "1" ? "dlc" : "game");
    });
    await expect(discoverTopSellerGames({ apiKey: "test-key", fetch: fetch as typeof globalThis.fetch, limit: 1 })).resolves.toEqual([
      { steamAppId: "2", title: "Game 2" },
    ]);
  });

  it("retries an AppDetails 403 instead of treating it as a key permission failure", async () => {
    let detailsAttempts = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.includes("GetWeeklyTopSellers")) return new Response(JSON.stringify({ response: { ranks: [{ appid: 1 }] } }), { status: 200 });
      detailsAttempts += 1;
      return detailsAttempts === 1 ? new Response("", { status: 403 }) : details("1");
    });
    await expect(discoverTopSellerGames({ apiKey: "test-key", fetch: fetch as typeof globalThis.fetch, limit: 1 })).resolves.toEqual([
      { steamAppId: "1", title: "Game 1" },
    ]);
    expect(detailsAttempts).toBe(2);
  });

  it("deduplicates ranked IDs before AppDetails validation", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.includes("GetWeeklyTopSellers")) return new Response(JSON.stringify({ response: { ranks: [{ appid: 1 }, { appid: 1 }] } }), { status: 200 });
      return details(url.searchParams.get("appids")!);
    });
    await expect(discoverTopSellerGames({ apiKey: "test-key", fetch: fetch as typeof globalThis.fetch, limit: 1 })).resolves.toEqual([
      { steamAppId: "1", title: "Game 1" },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fails closed when ranks are empty", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ response: { ranks: [] } }), { status: 200 }));
    await expect(discoverTopSellerGames({ apiKey: "test-key", fetch: fetch as typeof globalThis.fetch, limit: 1 })).rejects.toThrow("DISCOVERY_API_GAP");
  });

  it("classifies a missing ranks field as a schema error", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ response: {} }), { status: 200 }));
    await expect(discoverTopSellerGames({ apiKey: "test-key", fetch: fetch as typeof globalThis.fetch, limit: 1 })).rejects.toThrow("STEAM_TOP_SELLERS_SCHEMA_ERROR");
  });

  it.each([401, 403])("classifies HTTP %s as a key permission error", async (status) => {
    const fetch = vi.fn(async () => new Response("", { status }));
    await expect(discoverTopSellerGames({ apiKey: "test-key", fetch: fetch as typeof globalThis.fetch, limit: 1 })).rejects.toThrow("STEAM_API_KEY_PERMISSION_ERROR");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed without a key", async () => {
    await expect(discoverTopSellerGames({ apiKey: "", limit: 1 })).rejects.toThrow("STEAM_API_KEY_SETUP_REQUIRED");
  });
});
