import { describe, expect, it, vi } from "vitest";
import { discoverTopSellerGames } from "./top-sellers";

describe("Steam Top Sellers discovery", () => {
  it("pages with page_start/page_count and verifies every candidate with AppDetails", async () => {
    const urls: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); urls.push(url);
      if (url.includes("GetWeeklyTopSellers")) {
        const start = new URL(url).searchParams.get("page_start");
        return new Response(JSON.stringify({ response: { ranks: start === "0" ? [{ appid: 1 }] : [{ appid: 2 }] } }), { status: 200 });
      }
      const id = new URL(url).searchParams.get("appids")!;
      return new Response(JSON.stringify({ [id]: { success: true, data: { type: "game", steam_appid: Number(id), name: `Game ${id}` } } }), { status: 200 });
    });
    await expect(discoverTopSellerGames({ apiKey: "test-key", fetch: fetch as typeof globalThis.fetch, limit: 2, pageSize: 1 })).resolves.toEqual([{ steamAppId: "1", title: "Game 1" }, { steamAppId: "2", title: "Game 2" }]);
    expect(urls.filter((url) => url.includes("GetWeeklyTopSellers"))[1]).toContain("page_start=1");
    expect(urls.filter((url) => url.includes("GetWeeklyTopSellers"))[0]).toContain("page_count=1");
  });

  it("fails closed without a key", async () => {
    await expect(discoverTopSellerGames({ apiKey: "", limit: 1 })).rejects.toThrow("STEAM_API_KEY_SETUP_REQUIRED");
  });
});
