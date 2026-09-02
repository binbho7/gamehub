export type SteamClientErrorCode =
  | "timeout"
  | "network_error"
  | "rate_limited"
  | "provider_unavailable"
  | "http_error"
  | "malformed_json";

export type SteamResponseErrorCode =
  | "schema_changed"
  | "app_not_found"
  | "app_id_mismatch"
  | "unsupported_app_type";

export type SteamImportInputErrorCode = "invalid_app_id";

export type SteamProviderErrorCode =
  | SteamClientErrorCode
  | SteamResponseErrorCode
  | SteamImportInputErrorCode;

export class SteamProviderError extends Error {
  constructor(
    public readonly code: SteamProviderErrorCode,
    message: string,
    public readonly details: {
      retryable: boolean;
      status?: number;
      retryAfter?: string;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "SteamProviderError";
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

  get cause() {
    return this.details.cause;
  }
}
