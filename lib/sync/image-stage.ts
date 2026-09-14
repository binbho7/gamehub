import type { ImageOutcome, ImageResult } from "../images/types";
import {
  isStageError,
  stageError,
  type CanonicalSyncStage,
  type ImageWorkerClient,
  type StageContext,
  type StageFailureCode,
} from "./stages";

export const IMAGE_OUTCOMES = [
  "ingested", "deduplicated", "concurrent_dedup", "already_ingested", "restored", "skipped",
  "inconsistent_state", "source_rejected", "redirect_rejected", "download_failed", "deadline",
  "invalid_image", "mime_mismatch", "too_large", "storage_conflict", "storage_failed",
  "source_changed", "write_conflict", "d1_write_failed",
] as const satisfies readonly ImageOutcome[];

type MissingImageOutcome = Exclude<ImageOutcome, typeof IMAGE_OUTCOMES[number]>;
const allImageOutcomesCovered: MissingImageOutcome extends never ? true : never = true;
void allImageOutcomesCovered;

const BENIGN_OUTCOMES: readonly ImageOutcome[] = [
  "ingested", "deduplicated", "concurrent_dedup", "already_ingested", "restored", "skipped",
];
const IMAGE_OUTCOME_SET = new Set<string>(IMAGE_OUTCOMES);

function isImageOutcome(value: unknown): value is ImageOutcome {
  return typeof value === "string" && IMAGE_OUTCOME_SET.has(value);
}

function isValidResult(value: unknown, gameId: number): value is ImageResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  if (result.gameId !== gameId) return false;
  if (result.status !== "completed" && result.status !== "partial" && result.status !== "failed") return false;
  if (result.preflightError !== null && ![
    "invalid_request", "game_not_found", "image_limit_exceeded", "game_deadline",
  ].includes(result.preflightError as string)) return false;
  if (!Array.isArray(result.images)) return false;
  return result.images.every((image) => typeof image === "object" && image !== null
    && isImageOutcome((image as Record<string, unknown>).outcome));
}

function summary(result: ImageResult): string {
  const counts = IMAGE_OUTCOMES
    .map((outcome) => [outcome, result.images.filter((image) => image.outcome === outcome).length] as const)
    .filter(([, count]) => count > 0)
    .map(([outcome, count]) => `${outcome}=${count}`);
  return `Images completed${counts.length > 0 ? `; ${counts.join("; ")}` : ""}.`;
}

export function createImageSyncStage(client: ImageWorkerClient): CanonicalSyncStage {
  return {
    async execute(gameId: number, context: StageContext) {
      try {
        const result = await client.ingest(gameId, { write: !context.dryRun });
        if (!isValidResult(result, gameId)) throw stageError("images", "invalid_result");

        const firstFailure = result.images.find((image) => !BENIGN_OUTCOMES.includes(image.outcome));
        if (result.status === "completed") {
          if (result.preflightError !== null || firstFailure !== undefined) {
            throw stageError("images", "invalid_result");
          }
          return { summary: summary(result) };
        }

        if (result.preflightError !== null) throw stageError("images", result.preflightError);
        if (firstFailure !== undefined) throw stageError("images", firstFailure.outcome as StageFailureCode);
        throw stageError("images", result.status === "partial" ? "partial_result" : "failed_result");
      } catch (error) {
        if (isStageError(error, "images")) throw error;
        throw stageError("images", "unexpected_error");
      }
    },
  };
}
