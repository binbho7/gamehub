import { parseSteamAppDetails } from "./response";

export type TopSellerCandidate = { steamAppId: string; title: string };
export type TopSellerOptions = { apiKey: string; fetch?: typeof fetch; excludedIds?: ReadonlySet<string>; limit: number; pageSize?: number; maxPages?: number };

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
      if (response.ok) return await response.json();
      if (response.status < 500 && response.status !== 429) throw new Error(`Steam top sellers HTTP ${response.status}`);
    } catch (error) {
      if (attempt === 2) throw error;
    }
    await delay((attempt + 1) * 1000);
  }
  throw new Error("STEAM_API_UNAVAILABLE");
}

function idsFromPage(value: unknown): string[] {
  const root = value as { response?: { ranks?: Array<{ appid?: unknown; app_id?: unknown }> } };
  const ranks = root.response?.ranks ?? [];
  return [...new Set(ranks.map((rank) => String(rank.appid ?? rank.app_id ?? "")).filter((id) => /^[1-9][0-9]*$/.test(id)))];
}

export async function discoverTopSellerGames(options: TopSellerOptions): Promise<TopSellerCandidate[]> {
  if (!options.apiKey.trim()) throw new Error("STEAM_API_KEY_SETUP_REQUIRED");
  const fetchImpl = options.fetch ?? fetch;
  const excluded = options.excludedIds ?? new Set<string>();
  const pageSize = options.pageSize ?? 50;
  const maxPages = options.maxPages ?? 8;
  const seen = new Set(excluded);
  const result: TopSellerCandidate[] = [];
  for (let page = 0; page < maxPages && result.length < options.limit; page += 1) {
    const url = new URL("https://api.steampowered.com/IStoreTopSellersService/GetWeeklyTopSellers/v1/");
    url.searchParams.set("key", options.apiKey); url.searchParams.set("country_code", "US"); url.searchParams.set("language", "english");
    url.searchParams.set("page_start", String(page * pageSize)); url.searchParams.set("page_count", String(pageSize));
    const ids = idsFromPage(await getJson(fetchImpl, url.toString()));
    if (ids.length === 0) break;
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const detailsUrl = new URL("https://store.steampowered.com/api/appdetails");
      detailsUrl.searchParams.set("appids", id); detailsUrl.searchParams.set("cc", "us"); detailsUrl.searchParams.set("l", "english");
      try {
        const details = parseSteamAppDetails(await getJson(fetchImpl, detailsUrl.toString()), id);
        if (details.type === "game") result.push({ steamAppId: id, title: details.name });
      } catch { /* AppDetails is the final authority; reject invalid/non-game entries. */ }
      if (result.length >= options.limit) break;
    }
  }
  if (result.length < options.limit) throw new Error("DISCOVERY_API_GAP");
  return result;
}
