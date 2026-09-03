export type SteamSearchClientErrorCode =
  | "timeout"
  | "network_error"
  | "rate_limited"
  | "provider_unavailable"
  | "http_error"
  | "malformed_json";

export type SteamSearchResponseErrorCode = "schema_changed";
export type SteamSearchInputErrorCode = "invalid_search_query";
export type SteamSearchInputReason = "empty_query" | "query_too_long" | "invalid_limit";
export type SteamSearchErrorCode =
  | SteamSearchClientErrorCode
  | SteamSearchResponseErrorCode
  | SteamSearchInputErrorCode;

export type SteamSearchErrorDetails = {
  retryable: boolean;
  status?: number;
  retryAfter?: string;
  reason?: SteamSearchInputReason;
  cause?: unknown;
};

export class SteamSearchError extends Error {
  constructor(
    public readonly code: SteamSearchErrorCode,
    message: string,
    public readonly details: SteamSearchErrorDetails,
  ) {
    super(message);
    this.name = "SteamSearchError";
  }

  get retryable() {
    return this.details.retryable;
  }

  get status() {
    return this.details.status;
  }

  get retryAfter() {
    return this.details.retryAfter;
  }

  get reason() {
    return this.details.reason;
  }

  get cause() {
    return this.details.cause;
  }
}
