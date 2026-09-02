import { SteamProviderError } from "./errors";

export type SteamHttpResponse = {
  body: unknown;
  fetchedAt: Date;
  requestUrl: string;
};

export type SteamClient = {
  fetchAppDetails(appId: string): Promise<SteamHttpResponse>;
};

export type SteamClientOptions = {
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  now?: () => Date;
};

export function createSteamClient(options: SteamClientOptions = {}): SteamClient {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? "https://store.steampowered.com/api/appdetails";
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = options.now ?? (() => new Date());

  return {
    async fetchAppDetails(appId) {
      const url = new URL(baseUrl);
      url.searchParams.set("appids", appId);
      url.searchParams.set("cc", "us");
      url.searchParams.set("l", "english");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;

      try {
        response = await fetchImpl(url, { signal: controller.signal });
      } catch (cause) {
        if (controller.signal.aborted) {
          throw new SteamProviderError("timeout", "Steam request timed out", { retryable: true, cause });
        }
        throw new SteamProviderError("network_error", "Steam request failed", { retryable: true, cause });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const code = response.status === 429
          ? "rate_limited"
          : response.status >= 500
            ? "provider_unavailable"
            : "http_error";

        throw new SteamProviderError(code, `Steam returned HTTP ${response.status}`, {
          retryable: response.status === 429 || response.status >= 500,
          status: response.status,
          retryAfter: response.headers.get("Retry-After") ?? undefined,
        });
      }

      try {
        return {
          body: await response.json(),
          fetchedAt: now(),
          requestUrl: url.toString(),
        };
      } catch (cause) {
        throw new SteamProviderError("malformed_json", "Steam returned invalid JSON", {
          retryable: false,
          cause,
        });
      }
    },
  };
}
