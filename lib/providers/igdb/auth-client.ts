import { z } from "zod";
import { IgdbError } from "./errors";

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().finite().positive(),
  token_type: z.string().min(1),
});

export type IgdbAuthClient = {
  getAccessToken(): Promise<string>;
  invalidateAccessToken(): void;
};

export type IgdbAuthClientOptions = {
  clientId?: string;
  clientSecret?: string;
  fetch?: typeof fetch;
  now?: () => number;
  tokenUrl?: string;
  timeoutMs?: number;
  expiryMarginMs?: number;
};

type CachedToken = {
  accessToken: string;
  expiresAtMs: number;
};

export function createIgdbAuthClient(options: IgdbAuthClientOptions = {}): IgdbAuthClient {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const tokenUrl = options.tokenUrl ?? "https://id.twitch.tv/oauth2/token";
  const timeoutMs = options.timeoutMs ?? 10_000;
  const expiryMarginMs = options.expiryMarginMs ?? 60_000;
  let cache: CachedToken | undefined;
  let pending: Promise<string> | undefined;

  const requestAccessToken = async (): Promise<string> => {
    if (!options.clientId?.trim() || !options.clientSecret?.trim()) {
      throw new IgdbError("missing_credentials", "Twitch credentials are required", { retryable: false });
    }

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let response: Response;
      try {
        response = await fetchImpl(tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: options.clientId,
            client_secret: options.clientSecret,
            grant_type: "client_credentials",
          }).toString(),
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) {
          throw new IgdbError("timeout", "Twitch token request timed out", { retryable: true });
        }
        throw new IgdbError("network_error", "Twitch token request failed", { retryable: true });
      }

      if (!response.ok) {
        const code = response.status === 400 || response.status === 401 || response.status === 403
          ? "invalid_credentials"
          : response.status === 429
            ? "rate_limited"
            : response.status >= 500
              ? "provider_unavailable"
              : "http_error";

        throw new IgdbError(code, `Twitch token request returned HTTP ${response.status}`, {
          retryable: response.status === 429 || response.status >= 500,
          status: response.status,
          retryAfter: response.headers.get("Retry-After") ?? undefined,
        });
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        if (controller.signal.aborted) {
          throw new IgdbError("timeout", "Twitch token request timed out", { retryable: true });
        }
        throw new IgdbError("malformed_json", "Twitch token response was invalid JSON", { retryable: false });
      }

      const parsed = tokenResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw new IgdbError("schema_changed", "Twitch token response schema changed", { retryable: false });
      }

      cache = {
        accessToken: parsed.data.access_token,
        expiresAtMs: now() + (parsed.data.expires_in * 1_000) - expiryMarginMs,
      };
      return cache.accessToken;
    } finally {
      clearTimeout(deadline);
    }
  };

  return {
    getAccessToken() {
      if (cache && now() < cache.expiresAtMs) {
        return Promise.resolve(cache.accessToken);
      }

      if (pending) {
        return pending;
      }

      const request = requestAccessToken().finally(() => {
        if (pending === request) {
          pending = undefined;
        }
      });
      pending = request;
      return request;
    },
    invalidateAccessToken() {
      cache = undefined;
    },
  };
}
