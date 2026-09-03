import { SteamSearchError } from "./errors";

export type SteamSearchHttpResponse = {
  body: unknown;
  requestUrl: string;
};

export type SteamSearchClient = {
  search(query: string): Promise<SteamSearchHttpResponse>;
};

export type SteamSearchClientOptions = {
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
};

export function createSteamSearchClient(
  options: SteamSearchClientOptions = {},
): SteamSearchClient {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? "https://store.steampowered.com/api/storesearch/";
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    async search(query) {
      const url = new URL(baseUrl);
      url.searchParams.set("term", query);
      url.searchParams.set("l", "english");
      url.searchParams.set("cc", "US");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        let response: Response;
        try {
          response = await fetchImpl(url, {
            headers: { Accept: "application/json" },
            signal: controller.signal,
          });
        } catch (cause) {
          if (controller.signal.aborted) {
            throw new SteamSearchError("timeout", "Steam search timed out", { retryable: true, cause });
          }
          throw new SteamSearchError("network_error", "Steam search request failed", { retryable: true, cause });
        }

        if (!response.ok) {
          const code = response.status === 429
            ? "rate_limited"
            : response.status >= 500
              ? "provider_unavailable"
              : "http_error";

          throw new SteamSearchError(code, `Steam search returned HTTP ${response.status}`, {
            retryable: response.status === 429 || response.status >= 500,
            status: response.status,
            retryAfter: response.headers.get("Retry-After") ?? undefined,
          });
        }

        try {
          return { body: await response.json(), requestUrl: url.toString() };
        } catch (cause) {
          if (controller.signal.aborted) {
            throw new SteamSearchError("timeout", "Steam search timed out", { retryable: true, cause });
          }
          throw new SteamSearchError("malformed_json", "Steam search returned invalid JSON", {
            retryable: false,
            cause,
          });
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
