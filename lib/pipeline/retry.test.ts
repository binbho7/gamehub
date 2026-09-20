import { describe, expect, it } from "vitest";
import { canRetry, classifyRetry, retryDelayMs, classifyStageFailure } from "./retry";

describe("V2.10 retry policy", () => {
  it("exhaustively classifies sync stage failure codes and fails unknown codes closed", () => {
    const codes = ["timeout", "network_error", "rate_limited", "provider_unavailable", "http_error", "malformed_json", "schema_changed", "app_not_found", "app_id_mismatch", "unsupported_app_type", "invalid_app_id", "taxonomy_conflict", "company_conflict", "write_conflict", "write_incomplete", "missing_credentials", "invalid_credentials", "authentication_failed", "canonical_game_not_found", "steam_external_id_missing", "mapping_not_found", "mapping_ambiguous", "unsupported_mapping", "igdb_game_not_found", "invalid_game_id", "game_not_found", "link_limit_exceeded", "database_unavailable", "local_platform_unavailable", "write_failed", "cleanup_failed", "unexpected_error", "invalid_url", "unsupported_scheme", "unsafe_destination", "dns_failure", "tls_error", "redirect_loop", "too_many_redirects", "invalid_redirect", "protocol_downgrade", "inconsistent_state", "source_rejected", "redirect_rejected", "download_failed", "deadline", "invalid_image", "mime_mismatch", "too_large", "storage_conflict", "storage_failed", "source_changed", "d1_write_failed", "blocked", "partially_applied", "partial_result", "failed_result", "invalid_result", "worker_network_error", "worker_http_error", "worker_invalid_response", "invalid_request", "image_limit_exceeded", "game_deadline", "verifier_service_unavailable", "verifier_timeout", "verifier_protocol_error", "verifier_auth_error", "verifier_invalid_response"];
    expect(codes.every((code) => classifyStageFailure(code) !== undefined)).toBe(true);
    expect(classifyStageFailure("new_unrecognized_code")).toBe("run_fatal");
  });
  it.each([
    "steam_429", "steam_5xx", "steam_timeout", "steam_network",
    "igdb_timeout", "igdb_429", "igdb_5xx", "igdb_network",
    "link_dns_transient", "link_timeout", "link_429", "link_5xx",
    "image_source_timeout", "image_download_failed", "image_network_transient", "image_service_unavailable",
    "database_busy",
  ])("classifies %s as retryable", (reasonCode) => {
    expect(classifyRetry(reasonCode)).toBe("retryable");
  });

  it.each([
    "steam_invalid_app", "steam_malformed_response", "igdb_no_match", "igdb_malformed_response",
    "link_malformed_url", "link_malformed_response", "image_unsupported_format", "image_malformed_result",
    "database_constraint_conflict",
  ])("classifies %s as permanent", (reasonCode) => {
    expect(classifyRetry(reasonCode)).toBe("permanent");
  });

  it.each([
    "steam_identity_conflict", "igdb_ambiguous", "igdb_invalid_credentials", "igdb_taxonomy_company_conflict",
    "link_unsafe_destination", "link_protocol_downgrade", "link_policy_rejected",
    "image_unsafe_source", "image_source_policy_rejected", "image_storage_conflict",
  ])("classifies %s as blocked", (reasonCode) => {
    expect(classifyRetry(reasonCode)).toBe("blocked");
  });

  it.each(["composition_failure", "config_failure", "d1_failure", "verifier_composition_failure", "image_composition_failure", "database_schema_failure", "database_migration_failure", "database_binding_unavailable"])(
    "classifies %s as run-fatal",
    (reasonCode) => expect(classifyRetry(reasonCode)).toBe("run_fatal"),
  );

  it("does not classify a successful idempotent image outcome as a retry", () => {
    expect(classifyRetry("idempotent_existing")).toBe("success");
  });

  it("allows at most three total attempts for retryable failures", () => {
    expect(canRetry(1, "retryable")).toBe(true);
    expect(canRetry(2, "retryable")).toBe(true);
    expect(canRetry(3, "retryable")).toBe(false);
    expect(canRetry(1, "permanent")).toBe(false);
    expect(canRetry(1, "blocked")).toBe(false);
    expect(canRetry(1, "run_fatal")).toBe(false);
  });

  it("uses only deterministic one- and two-second waits before attempts two and three", () => {
    expect(retryDelayMs(2)).toBe(1000);
    expect(retryDelayMs(3)).toBe(2000);
    expect(retryDelayMs(4)).toBeNull();
  });

  it("accepts only bounded non-negative integer Retry-After values", () => {
    expect(retryDelayMs(2, 500)).toBe(500);
    expect(retryDelayMs(3, 2000)).toBe(2000);
    expect(retryDelayMs(2, 2001)).toBe(1000);
    expect(retryDelayMs(2, -1)).toBe(1000);
    expect(retryDelayMs(2, 1.5)).toBe(1000);
    expect(retryDelayMs(2, Number.NaN)).toBe(1000);
    expect(retryDelayMs(2, 1_000_000)).toBe(1000);
  });
});
