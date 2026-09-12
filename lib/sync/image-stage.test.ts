import { expect, it, vi } from "vitest";
import type { ImageOutcome, ImageResult } from "../images/types";
import type { StageFailureCode } from "./stages";
import { imageItemFixture } from "../../test/helpers/image-result-fixture";
import { createImageSyncStage, IMAGE_OUTCOMES } from "./image-stage";
import { stageError } from "./stages";

const BENIGN: readonly ImageOutcome[] = [
  "ingested", "deduplicated", "concurrent_dedup", "already_ingested", "restored", "skipped",
];

function result(overrides: Partial<ImageResult> = {}): ImageResult {
  return { gameId: 41, status: "completed", preflightError: null, plan: null, images: [], ...overrides };
}

it("forwards only gameId and write and summarizes benign image outcomes", async () => {
  const ingest = vi.fn().mockResolvedValue(result({ images: [imageItemFixture({ outcome: "concurrent_dedup" })] }));

  await expect(createImageSyncStage({ ingest }).execute(41, { dryRun: true }))
    .resolves.toEqual({ summary: "Images completed; concurrent_dedup=1." });
  expect(ingest).toHaveBeenCalledExactlyOnceWith(41, { write: false });

  ingest.mockResolvedValue(result({ status: "partial", images: [imageItemFixture({ outcome: "storage_failed" })] }));
  await expect(createImageSyncStage({ ingest }).execute(41, { dryRun: false }))
    .rejects.toEqual(stageError("images", "storage_failed"));
  expect(ingest).toHaveBeenLastCalledWith(41, { write: true });
});

it("covers every native ImageOutcome and rejects non-benign outcomes in partial results", async () => {
  expect(IMAGE_OUTCOMES).toEqual([
    "ingested", "deduplicated", "concurrent_dedup", "already_ingested", "restored", "skipped",
    "inconsistent_state", "source_rejected", "redirect_rejected", "download_failed", "deadline",
    "invalid_image", "mime_mismatch", "too_large", "storage_conflict", "storage_failed",
    "source_changed", "write_conflict", "d1_write_failed",
  ]);
  expect(new Set(IMAGE_OUTCOMES)).toHaveProperty("size", 19);

  for (const outcome of IMAGE_OUTCOMES) {
    const ingest = vi.fn().mockResolvedValue(result({ status: "partial", images: [imageItemFixture({ outcome })] }));
    const execution = createImageSyncStage({ ingest }).execute(41, { dryRun: false });
    const expected: StageFailureCode = BENIGN.includes(outcome) ? "partial_result" : outcome;
    await expect(execution).rejects.toEqual(stageError("images", expected));
  }
});

it("maps every image preflight error before inspecting image items", async () => {
  const errors: ImageResult["preflightError"][] = [
    "invalid_request", "game_not_found", "image_limit_exceeded", "game_deadline",
  ];
  for (const preflightError of errors) {
    const ingest = vi.fn().mockResolvedValue(result({ status: "failed", preflightError,
      images: [imageItemFixture({ outcome: "ingested" })] }));
    if (preflightError === null) continue;
    await expect(createImageSyncStage({ ingest }).execute(41, { dryRun: true }))
      .rejects.toEqual(stageError("images", preflightError));
  }
});

it("allows a completed empty result and rejects contradictory completed results", async () => {
  const ingest = vi.fn().mockResolvedValue(result());
  await expect(createImageSyncStage({ ingest }).execute(41, { dryRun: false }))
    .resolves.toEqual({ summary: "Images completed." });

  for (const outcome of IMAGE_OUTCOMES.filter((item) => !BENIGN.includes(item))) {
    ingest.mockResolvedValue(result({ images: [imageItemFixture({ outcome })] }));
    await expect(createImageSyncStage({ ingest }).execute(41, { dryRun: false }))
      .rejects.toEqual(stageError("images", "invalid_result"));
  }
  ingest.mockResolvedValue(result({ preflightError: "game_deadline" }));
  await expect(createImageSyncStage({ ingest }).execute(41, { dryRun: false }))
    .rejects.toEqual(stageError("images", "invalid_result"));
});

it("does not turn partial or failed results without a concrete failure into success", async () => {
  const ingest = vi.fn();
  for (const status of ["partial", "failed"] as const) {
    ingest.mockResolvedValue(result({ status }));
    await expect(createImageSyncStage({ ingest }).execute(41, { dryRun: false }))
      .rejects.toEqual(stageError("images", status === "partial" ? "partial_result" : "failed_result"));
  }
});

it("rejects a mismatched game identity and redacts unknown client errors", async () => {
  const ingest = vi.fn().mockResolvedValue(result({ gameId: 42 }));
  await expect(createImageSyncStage({ ingest }).execute(41, { dryRun: false }))
    .rejects.toEqual(stageError("images", "invalid_result"));

  ingest.mockRejectedValue(new Error("Bearer secret-token https://user:password@example.test/?token=secret"));
  await expect(createImageSyncStage({ ingest }).execute(41, { dryRun: false }))
    .rejects.toEqual(stageError("images", "unexpected_error"));
});
