export type RetryClass = "retryable" | "permanent" | "blocked" | "run_fatal";
export type RetryOutcome = RetryClass | "success";

export const MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 2_000;

const reasonClasses: Record<string, RetryOutcome> = {
  steam_429: "retryable",
  steam_5xx: "retryable",
  steam_timeout: "retryable",
  steam_network: "retryable",
  steam_invalid_app: "permanent",
  steam_malformed_response: "permanent",
  steam_identity_conflict: "blocked",
  igdb_timeout: "retryable",
  igdb_429: "retryable",
  igdb_5xx: "retryable",
  igdb_network: "retryable",
  igdb_no_match: "permanent",
  igdb_malformed_response: "permanent",
  igdb_ambiguous: "blocked",
  igdb_invalid_credentials: "blocked",
  igdb_taxonomy_company_conflict: "blocked",
  link_dns_transient: "retryable",
  link_timeout: "retryable",
  link_429: "retryable",
  link_5xx: "retryable",
  link_malformed_url: "permanent",
  link_malformed_response: "permanent",
  link_unsafe_destination: "blocked",
  link_protocol_downgrade: "blocked",
  link_policy_rejected: "blocked",
  image_source_timeout: "retryable",
  image_download_failed: "retryable",
  image_network_transient: "retryable",
  image_service_unavailable: "retryable",
  image_unsupported_format: "permanent",
  image_malformed_result: "permanent",
  image_unsafe_source: "blocked",
  image_source_policy_rejected: "blocked",
  image_storage_conflict: "blocked",
  database_busy: "retryable",
  database_constraint_conflict: "permanent",
  composition_failure: "run_fatal",
  config_failure: "run_fatal",
  d1_failure: "run_fatal",
  verifier_composition_failure: "run_fatal",
  image_composition_failure: "run_fatal",
  database_schema_failure: "run_fatal",
  database_migration_failure: "run_fatal",
  database_binding_unavailable: "run_fatal",
  retry_exhausted: "run_fatal",
  artifact_mismatch: "permanent",
  site_data_check_failed: "permanent",
  build_failed: "permanent",
  build_output_invalid: "permanent",
  idempotent_existing: "success",
  evaluation_ineligible: "blocked",
};

const stageFailureRetryable = new Set(["timeout", "network_error", "rate_limited", "provider_unavailable", "http_error", "dns_failure", "tls_error", "download_failed", "deadline", "database_busy", "worker_network_error", "worker_http_error", "verifier_service_unavailable", "verifier_timeout"]);
const stageFailureBlocked = new Set(["taxonomy_conflict", "company_conflict", "write_conflict", "invalid_credentials", "authentication_failed", "unsafe_destination", "protocol_downgrade", "inconsistent_state", "source_rejected", "redirect_rejected", "storage_conflict", "blocked", "partially_applied", "evaluation_ineligible"]);
const stageFailurePermanent = new Set(["malformed_json", "schema_changed", "app_not_found", "app_id_mismatch", "unsupported_app_type", "invalid_app_id", "write_incomplete", "missing_credentials", "canonical_game_not_found", "steam_external_id_missing", "mapping_not_found", "mapping_ambiguous", "unsupported_mapping", "igdb_game_not_found", "invalid_game_id", "game_not_found", "link_limit_exceeded", "database_unavailable", "local_platform_unavailable", "write_failed", "cleanup_failed", "unexpected_error", "invalid_url", "unsupported_scheme", "redirect_loop", "too_many_redirects", "invalid_redirect", "invalid_image", "mime_mismatch", "too_large", "storage_failed", "source_changed", "d1_write_failed", "partial_result", "failed_result", "invalid_result", "worker_invalid_response", "invalid_request", "image_limit_exceeded", "game_deadline", "verifier_protocol_error", "verifier_auth_error", "verifier_invalid_response"]);

/** Exhaustive boundary for raw sync stage codes; unknown codes are run-fatal. */
export function classifyStageFailure(code: string): RetryClass {
  if (stageFailureRetryable.has(code)) return "retryable";
  if (stageFailureBlocked.has(code)) return "blocked";
  if (stageFailurePermanent.has(code)) return "permanent";
  return "run_fatal";
}

export function classifyRetry(reasonCode: string): RetryOutcome {
  return reasonClasses[reasonCode] ?? "run_fatal";
}

export function canRetry(attemptCount: number, classification: RetryOutcome): boolean {
  return classification === "retryable" && Number.isInteger(attemptCount) && attemptCount >= 1 && attemptCount < MAX_ATTEMPTS;
}

export function retryDelayMs(nextAttemptNumber: number, retryAfterMs?: number): number | null {
  const defaultDelay = nextAttemptNumber === 2 ? 1_000 : nextAttemptNumber === 3 ? 2_000 : null;
  if (defaultDelay === null) return null;
  return retryAfterMs !== undefined && Number.isInteger(retryAfterMs) && retryAfterMs >= 0 && retryAfterMs <= MAX_RETRY_AFTER_MS
    ? retryAfterMs
    : defaultDelay;
}
