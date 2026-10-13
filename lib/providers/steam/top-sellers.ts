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

type TopSellerPage = { ids: string[]; nextPageStart?: number };

function parsePage(value: unknown): TopSellerPage {
  const response = (value as { response?: unknown }).response;
  if (!response || typeof response !== "object") throw new Error("STEAM_TOP_SELLERS_SCHEMA_ERROR");
  const root = response as { start_date?: unknown; ranks?: unknown; next_page_start?: unknown };
  if (Array.isArray(root.ranks)) {
    const nextPageStart = root.next_page_start;
    if (nextPageStart !== undefined && (typeof nextPageStart !== "number" || !Number.isInteger(nextPageStart) || nextPageStart < 0)) throw new Error("STEAM_TOP_SELLERS_SCHEMA_ERROR");
    return {
      ids: [...new Set((root.ranks as Array<{ appid?: unknown; app_id?: unknown }>).map((rank) => String(rank.appid ?? rank.app_id ?? "")).filter((id) => /^[1-9][0-9]*$/.test(id)))],
      ...(nextPageStart === undefined ? {} : { nextPageStart }),
    };
  }
  if (Number.isInteger(root.start_date) && Number(root.start_date) >= 0 && root.next_page_start === undefined) {
    return { ids: [] };
  }
  throw new Error("STEAM_TOP_SELLERS_SCHEMA_ERROR");
}

async function getTopSellerPage(fetchImpl: typeof fetch, url: string): Promise<TopSellerPage> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const payload = await getJson(fetchImpl, url, true);
    try {
      return parsePage(payload);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "STEAM_TOP_SELLERS_SCHEMA_ERROR" || attempt === 2) throw error;
      await delay((attempt + 1) * 1000);
    }
  }
  throw new Error("STEAM_TOP_SELLERS_SCHEMA_ERROR");
}

export async function discoverTopSellerGames(options: TopSellerOptions): Promise<TopSellerCandidate[]> {
  if (!options.apiKey.trim()) throw new Error("STEAM_API_KEY_SETUP_REQUIRED");
  const fetchImpl = options.fetch ?? fetch;
  const excluded = options.excludedIds ?? new Set<string>();
  const pageSize = options.pageSize ?? 50;
  const maxPages = options.maxPages ?? 8;
  const seen = new Set(excluded);
  const result: TopSellerCandidate[] = [];
  let pageStart = 0;
  const seenCursors = new Set<number>();
  for (let page = 0; page < maxPages && result.length < options.limit; page += 1) {
    if (seenCursors.has(pageStart)) throw new Error("STEAM_TOP_SELLERS_SCHEMA_ERROR");
    seenCursors.add(pageStart);
    const url = new URL("https://api.steampowered.com/IStoreTopSellersService/GetWeeklyTopSellers/v1/");
    const input = {
      country_code: "US",
      context: { language: "english", country_code: "US" },
      data_request: { include_basic_info: true },
      page_start: pageStart,
      page_count: pageSize,
    };
    url.searchParams.set("key", options.apiKey);
    url.searchParams.set("input_json", JSON.stringify(input));
    const pageResult = await getTopSellerPage(fetchImpl, url.toString());
    const ids = pageResult.ids;
    if (ids.length === 0) break;
    if (pageResult.nextPageStart !== undefined && (pageResult.nextPageStart <= pageStart || seenCursors.has(pageResult.nextPageStart))) {
      throw new Error("STEAM_TOP_SELLERS_SCHEMA_ERROR");
    }
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
    if (pageResult.nextPageStart === undefined) break;
    pageStart = pageResult.nextPageStart;
  }
  if (result.length < options.limit) throw new Error("DISCOVERY_API_GAP");
  return result;
}
