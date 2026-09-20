import type { SteamImportResult } from "../importers/candidate";
import type { SteamProviderErrorCode } from "../providers/steam/errors";
import type { IgdbEnrichmentResult } from "../enrichers/igdb-candidate";
import type { IgdbErrorCode } from "../providers/igdb/errors";
import type { LinkVerificationService } from "../verifiers/official-links/service";
import type { LinkVerificationOperationCode } from "../verifiers/official-links/errors";
import type { VerificationCode } from "../verifiers/official-links/types";
import type { VerifierServiceErrorCode } from "../verifiers/official-links/remote/types";
import type { ImageOutcome, ImageResult } from "../images/types";
import type { StageName } from "./types";
import type { SteamImportErrorCode } from "../importers/errors";

export type SteamImporterPort = {
  importGame(input: string | number, options: { dryRun?: boolean }): Promise<SteamImportResult>;
};

export type IgdbEnricherPort = {
  enrichGame(gameId: number, options: { dryRun: boolean }): Promise<IgdbEnrichmentResult>;
};

export type LinkVerifierPort = Pick<LinkVerificationService, "verifyGame">;

export type ImageWorkerClient = {
  ingest(gameId: number, input: { write: boolean }): Promise<ImageResult>;
};

export type StageContext = { dryRun: boolean; snapshotDate?: string };
export type StageOutput = { summary: string };
export type SteamStageOutput = StageOutput & {
  gameId: number | null;
  action: SteamImportResult["plan"]["action"];
};

export type SteamSyncStage = {
  execute(appId: string, context: StageContext): Promise<SteamStageOutput>;
};
export type CanonicalSyncStage = {
  execute(gameId: number, context: StageContext): Promise<StageOutput>;
};
export type BulkSyncStages = {
  steam: SteamSyncStage;
  igdb: CanonicalSyncStage;
  links: CanonicalSyncStage;
  images: CanonicalSyncStage;
};

type AdapterFailureCode =
  | "blocked" | "partially_applied" | "partial_result" | "failed_result"
  | "invalid_result" | "unexpected_error"
  | "worker_network_error" | "worker_http_error" | "worker_invalid_response";

type NonBenignImageOutcome = Exclude<ImageOutcome,
  "ingested" | "deduplicated" | "concurrent_dedup" | "already_ingested" | "restored" | "skipped">;

export type StageFailureCode = SteamProviderErrorCode | SteamImportErrorCode | IgdbErrorCode
  | LinkVerificationOperationCode | Exclude<VerificationCode, "http_result"> | VerifierServiceErrorCode
  | NonBenignImageOutcome | Exclude<ImageResult["preflightError"], null> | AdapterFailureCode;

export type BulkSyncStageError = {
  stage: StageName;
  code: StageFailureCode;
  message: string;
};

export const STAGE_FAILURE_CODES = [
  "timeout", "network_error", "rate_limited", "provider_unavailable", "http_error", "malformed_json",
  "schema_changed", "app_not_found", "app_id_mismatch", "unsupported_app_type", "invalid_app_id",
  "taxonomy_conflict", "company_conflict", "write_conflict", "write_incomplete",
  "missing_credentials", "invalid_credentials", "authentication_failed", "canonical_game_not_found",
  "steam_external_id_missing", "mapping_not_found", "mapping_ambiguous", "unsupported_mapping",
  "igdb_game_not_found", "invalid_game_id", "game_not_found", "link_limit_exceeded", "database_unavailable",
  "local_platform_unavailable", "write_failed", "cleanup_failed", "unexpected_error", "invalid_url",
  "unsupported_scheme", "unsafe_destination", "dns_failure", "tls_error", "redirect_loop",
  "too_many_redirects", "invalid_redirect", "protocol_downgrade", "inconsistent_state", "source_rejected",
  "redirect_rejected", "download_failed", "deadline", "invalid_image", "mime_mismatch", "too_large",
  "storage_conflict", "storage_failed", "source_changed", "d1_write_failed", "blocked", "partially_applied",
  "partial_result", "failed_result", "invalid_result", "worker_network_error", "worker_http_error",
  "worker_invalid_response", "invalid_request", "image_limit_exceeded", "game_deadline",
  "verifier_service_unavailable", "verifier_timeout", "verifier_protocol_error", "verifier_auth_error", "verifier_invalid_response",
] as const satisfies readonly StageFailureCode[];

type MissingStageFailureCode = Exclude<StageFailureCode, typeof STAGE_FAILURE_CODES[number]>;
const allStageFailureCodesCovered: MissingStageFailureCode extends never ? true : never = true;
void allStageFailureCodesCovered;

export function stageError(stage: StageName, code: StageFailureCode): BulkSyncStageError {
  return Object.freeze({
    stage,
    code,
    message: `Bulk sync ${stage} stage failed (${code}).`,
  });
}

export function isStageError(value: unknown, stage: StageName): value is BulkSyncStageError {
  if (typeof value !== "object" || value === null) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  const keySet = new Set(keys);
  if (keys.length !== 3 || !keySet.has("code") || !keySet.has("message") || !keySet.has("stage")) return false;
  if (record.stage !== stage || typeof record.code !== "string" || typeof record.message !== "string") return false;
  if (!(STAGE_FAILURE_CODES as readonly string[]).includes(record.code)) return false;
  return record.message === stageError(stage, record.code as StageFailureCode).message;
}
