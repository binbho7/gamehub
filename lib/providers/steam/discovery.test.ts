import { describe, expect, it, vi } from "vitest";
import { discoverSteamGames } from "./discovery";

describe("Steam deterministic discovery", () => {
  it("filters historical IDs and verifies AppDetails game type", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("featuredcategories")) return new Response(JSON.stringify({ top_sellers: { items: [{ id: 1, type: "game" }, { id: 2, type: "game" }] } }), { status: 200 });
      const id = new URL(url).searchParams.get("appids")!;
      return new Response(JSON.stringify({ [id]: { success: true, data: { type: "game", steam_appid: Number(id), name: `Game ${id}` } } }), { status: 200 });
    });
    await expect(discoverSteamGames({ fetch: fetch as typeof globalThis.fetch, excludedIds: new Set(["1"]), limit: 1 })).resolves.toEqual([{ steamAppId: "2", title: "Game 2" }]);
  });

  it("fails closed when bounded verified discovery is incomplete", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ top_sellers: { items: [] } }), { status: 200 }));
    await expect(discoverSteamGames({ fetch: fetch as typeof globalThis.fetch, limit: 10 })).rejects.toThrow("DISCOVERY_API_GAP");
  });
});
