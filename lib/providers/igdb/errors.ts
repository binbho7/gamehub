export type IgdbErrorCode =
  | "missing_credentials"
  | "invalid_credentials"
  | "authentication_failed"
  | "timeout"
  | "network_error"
  | "rate_limited"
  | "provider_unavailable"
  | "http_error"
  | "malformed_json"
  | "schema_changed"
  | "canonical_game_not_found"
  | "steam_external_id_missing"
  | "mapping_not_found"
  | "mapping_ambiguous"
  | "unsupported_mapping"
  | "igdb_game_not_found"
  | "write_conflict"
  | "invalid_game_id";

export type IgdbErrorDetails = {
  retryable: boolean;
  status?: number;
  retryAfter?: string;
  cause?: unknown;
};

export class IgdbError extends Error {
  public readonly code: IgdbErrorCode;
  declare readonly details: IgdbErrorDetails;

  constructor(code: IgdbErrorCode, message: string, details: IgdbErrorDetails) {
    super(message);
    this.name = "IgdbError";
    this.code = code;

    // Keep provider causes available to callers without making credentials or
    // response bodies part of normal error serialization.
    Object.defineProperty(this, "details", {
      configurable: false,
      enumerable: false,
      value: details,
      writable: false,
    });
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

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.retryAfter === undefined ? {} : { retryAfter: this.retryAfter }),
    };
  }
}
