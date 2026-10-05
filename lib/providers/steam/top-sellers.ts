import { parseSteamAppDetails } from "./response";

export type TopSellerCandidate = { steamAppId: string; title: string };
export type TopSellerOptions = { apiKey: string; fetch?: typeof fetch; excludedIds?: ReadonlySet<string>; limit: number; pageSize?: number; maxPages?: number };

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function getJson(fetchImpl: typeof fetch, url: string, keyedRequest = false): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
      if (response.ok) return await response.json();
      if (keyedRequest && (response.status === 401 || response.status === 403)) throw new Error("STEAM_API_KEY_PERMISSION_ERROR");
      if (response.status < 500 && response.status !== 429) throw new Error(`Steam top sellers HTTP ${response.status}`);
    } catch (error) {
      if (error instanceof Error && error.message === "STEAM_API_KEY_PERMISSION_ERROR") throw error;
      if (attempt === 2) throw error;
    }
    await delay((attempt + 1) * 1000);
  }
  throw new Error("STEAM_API_UNAVAILABLE");
}

function idsFromPage(value: unknown): string[] {
  const root = value as { response?: { ranks?: Array<{ appid?: unknown; app_id?: unknown }> } };
  if (!Array.isArray(root.response?.ranks)) throw new Error("STEAM_TOP_SELLERS_SCHEMA_ERROR");
  const ranks = root.response.ranks;
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
    const input = {
      country_code: "US",
      context: { language: "english", country_code: "US" },
      data_request: { include_basic_info: true },
      page_start: page * pageSize,
      page_count: pageSize,
    };
    url.searchParams.set("key", options.apiKey);
    url.searchParams.set("input_json", JSON.stringify(input));
    const ids = idsFromPage(await getJson(fetchImpl, url.toString(), true));
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
