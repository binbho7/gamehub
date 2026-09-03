import type { IgdbAuthClient } from "./auth-client";
import { IgdbError } from "./errors";

type IgdbEndpoint = "external_games" | "games";

const igdbEndpoints = new Set<IgdbEndpoint>(["external_games", "games"]);

export type IgdbHttpResponse = {
  body: unknown;
  fetchedAt: Date;
};

export type IgdbClient = {
  request(endpoint: IgdbEndpoint, query: string): Promise<IgdbHttpResponse>;
};

export type IgdbClientOptions = {
  auth: Pick<IgdbAuthClient, "getAccessToken" | "invalidateAccessToken">;
  clientId: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  now?: () => Date;
};

type RequestResult =
  | IgdbHttpResponse
  | { unauthorized: true };

export function createIgdbClient(options: IgdbClientOptions): IgdbClient {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? "https://api.igdb.com/v4";
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = options.now ?? (() => new Date());

  const requestWithToken = async (
    endpoint: IgdbEndpoint,
    query: string,
    accessToken: string,
  ): Promise<RequestResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const timeout = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });

    try {
      let response: Response;
      try {
        const url = new URL(endpoint, `${baseUrl.replace(/\/$/, "")}/`);
        response = await Promise.race([
          fetchImpl(url, {
            method: "POST",
            headers: {
              "Client-ID": options.clientId,
              Authorization: `Bearer ${accessToken}`,
              Accept: "application/json",
            },
            body: query,
            signal: controller.signal,
          }),
          timeout,
        ]);
      } catch {
        if (controller.signal.aborted) {
          throw new IgdbError("timeout", "IGDB request timed out", { retryable: true });
        }
        throw new IgdbError("network_error", "IGDB request failed", { retryable: true });
      }

      if (response.status === 401) {
        return { unauthorized: true };
      }

      if (!response.ok) {
        const code = response.status === 429
          ? "rate_limited"
          : response.status >= 500
            ? "provider_unavailable"
            : "http_error";
        throw new IgdbError(code, `IGDB request returned HTTP ${response.status}`, {
          retryable: response.status === 429 || response.status >= 500,
          status: response.status,
          retryAfter: response.headers.get("Retry-After") ?? undefined,
        });
      }

      try {
        return {
          body: await Promise.race([response.json(), timeout]),
          fetchedAt: now(),
        };
      } catch {
        if (controller.signal.aborted) {
          throw new IgdbError("timeout", "IGDB request timed out", { retryable: true });
        }
        throw new IgdbError("malformed_json", "IGDB response was invalid JSON", { retryable: false });
      }
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async request(endpoint, query) {
      if (!igdbEndpoints.has(endpoint)) {
        throw new IgdbError("http_error", "Invalid IGDB endpoint", { retryable: false });
      }

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const accessToken = await options.auth.getAccessToken();
        const result = await requestWithToken(endpoint, query, accessToken);

        if (!("unauthorized" in result)) {
          return result;
        }

        if (attempt === 0) {
          options.auth.invalidateAccessToken();
          continue;
        }

        throw new IgdbError("authentication_failed", "IGDB authentication failed", {
          retryable: false,
          status: 401,
        });
      }

      throw new IgdbError("authentication_failed", "IGDB authentication failed", { retryable: false });
    },
  };
}
