import { parseSteamAppDetails } from "./response";

export type SteamDiscoveryCandidate = { steamAppId: string; title: string };
export type SteamDiscoveryOptions = { fetch?: typeof fetch; excludedIds?: ReadonlySet<string>; limit: number; pageSize?: number; maxPages?: number };

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
      if (response.ok) return await response.json();
      if (response.status < 500 && response.status !== 429) throw new Error(`Steam discovery HTTP ${response.status}`);
    } catch (error) {
      if (attempt === 2) throw error;
    }
    await sleep(1000 * (attempt + 1));
  }
  throw new Error("Steam discovery unavailable");
}

function browseIds(value: unknown): string[] {
  const record = value as { top_sellers?: { items?: Array<{ id?: unknown; type?: unknown }> }; specials?: { items?: Array<{ id?: unknown; type?: unknown }> } };
  const items = [...(record.top_sellers?.items ?? []), ...(record.specials?.items ?? [])];
  return [...new Set(items.filter((item) => item.type === "game" || item.type === undefined)
    .map((item) => String(item.id ?? ""))
    .filter((id) => /^[1-9][0-9]*$/.test(id)))];
}

export async function discoverSteamGames(options: SteamDiscoveryOptions): Promise<SteamDiscoveryCandidate[]> {
  const fetchImpl = options.fetch ?? fetch;
  const excluded = options.excludedIds ?? new Set<string>();
  const maxPages = options.maxPages ?? 2;
  const pageSize = options.pageSize ?? 100;
  const candidates: SteamDiscoveryCandidate[] = [];
  const seen = new Set<string>(excluded);
  for (let page = 0; page < maxPages && candidates.length < options.limit; page += 1) {
    const url = new URL("https://store.steampowered.com/api/featuredcategories");
    url.searchParams.set("cc", "US"); url.searchParams.set("l", "english"); url.searchParams.set("page", String(page)); url.searchParams.set("count", String(pageSize));
    const ids = browseIds(await getJson(fetchImpl, url.toString()));
    if (ids.length === 0) break;
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const detailsResponse = await getJson(fetchImpl, `https://store.steampowered.com/api/appdetails?appids=${id}&cc=us&l=english`);
      try {
        const details = parseSteamAppDetails(detailsResponse, id);
        if (details.type !== "game") continue;
        candidates.push({ steamAppId: id, title: details.name });
      } catch {
        // Invalid, non-game, DLC, demo, and tool records are rejected fail-closed.
      }
      if (candidates.length >= options.limit) break;
    }
  }
  if (candidates.length < options.limit) throw new Error("DISCOVERY_API_GAP");
  return candidates;
}
