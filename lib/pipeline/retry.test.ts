import { describe, expect, it } from "vitest";
import { canRetry, classifyRetry, retryDelayMs, classifyStageFailure, type RetryClass } from "./retry";
import { STAGE_FAILURE_CODES, type StageFailureCode } from "../sync/stages";

const expectedStageFailureClasses: Record<StageFailureCode, RetryClass> = {
  timeout: "retryable", network_error: "retryable", rate_limited: "retryable", provider_unavailable: "retryable", http_error: "retryable",
  malformed_json: "permanent", schema_changed: "permanent", app_not_found: "permanent", app_id_mismatch: "permanent", unsupported_app_type: "permanent", invalid_app_id: "permanent",
  taxonomy_conflict: "blocked", company_conflict: "blocked", write_conflict: "blocked", write_incomplete: "permanent",
  missing_credentials: "permanent", invalid_credentials: "blocked", authentication_failed: "blocked", canonical_game_not_found: "permanent",
  steam_external_id_missing: "permanent", mapping_not_found: "permanent", mapping_ambiguous: "permanent", unsupported_mapping: "permanent",
  igdb_game_not_found: "permanent", invalid_game_id: "permanent", game_not_found: "permanent", link_limit_exceeded: "permanent", database_unavailable: "permanent",
  local_platform_unavailable: "permanent", write_failed: "permanent", cleanup_failed: "permanent", unexpected_error: "permanent", invalid_url: "permanent",
  unsupported_scheme: "permanent", unsafe_destination: "blocked", dns_failure: "retryable", tls_error: "retryable", redirect_loop: "permanent",
  too_many_redirects: "permanent", invalid_redirect: "permanent", protocol_downgrade: "blocked", inconsistent_state: "blocked", source_rejected: "blocked",
  redirect_rejected: "blocked", download_failed: "retryable", deadline: "retryable", invalid_image: "permanent", mime_mismatch: "permanent", too_large: "permanent",
  storage_conflict: "blocked", storage_failed: "permanent", source_changed: "permanent", d1_write_failed: "permanent", blocked: "blocked", partially_applied: "blocked",
  partial_result: "permanent", failed_result: "permanent", invalid_result: "permanent", worker_network_error: "retryable", worker_http_error: "retryable",
  worker_invalid_response: "permanent", invalid_request: "permanent", image_limit_exceeded: "permanent", game_deadline: "permanent",
  verifier_service_unavailable: "retryable", verifier_timeout: "retryable", verifier_protocol_error: "permanent", verifier_auth_error: "permanent", verifier_invalid_response: "permanent",
};

describe("V2.10 retry policy", () => {
  it("exhaustively classifies every public sync stage failure code and fails unknown codes closed", () => {
    expect(Object.keys(expectedStageFailureClasses).sort()).toEqual([...STAGE_FAILURE_CODES].sort());
    for (const code of STAGE_FAILURE_CODES) expect(classifyStageFailure(code)).toBe(expectedStageFailureClasses[code]);
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
