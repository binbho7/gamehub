/// <reference types="@cloudflare/workers-types" />

import type { Clock } from "./clock";
import type { ImageCandidate, ImageGameSnapshot } from "./candidates";
import type { DownloadResult } from "./downloader";
import type { ImageValidation } from "./formats";
import type { R2ImageStore } from "./r2-store";
import type { ImageIngestRepository, ImageIngestSnapshot, ImageBinding } from "../db/repositories/image-ingest";

export type ImageOutcome =
  | "ingested" | "deduplicated" | "concurrent_dedup" | "already_ingested" | "restored"
  | "skipped" | "inconsistent_state" | "source_rejected" | "redirect_rejected"
  | "download_failed" | "deadline" | "invalid_image" | "mime_mismatch" | "too_large"
  | "storage_conflict" | "storage_failed" | "source_changed" | "write_conflict" | "d1_write_failed";

export type ImagePlan = {
  gameId: number;
  candidates: ImageCandidate[];
  preflight: "ok" | "game_not_found" | "image_limit_exceeded";
  dryRun: boolean;
};

export type ImageResult = {
  gameId: number;
  status: "completed" | "partial" | "failed";
  preflightError: "invalid_request" | "game_not_found" | "image_limit_exceeded" | "game_deadline" | null;
  images: Array<{ imageId: number | null; outcome: ImageOutcome }>;
};

export type WorkerEnv = {
  DB: D1Database;
  IMAGES_BUCKET: R2Bucket;
  IMAGE_PUBLIC_BASE_URL: string;
  IMAGE_INGEST_TOKEN: string;
};

export type WorkerRequestDto = { gameId: number; write: boolean };

export type ImageIngestDependencies = {
  repository: Pick<ImageIngestRepository, "readImageIngestSnapshot" | "findImageByIdentity" | "conditionallyCreateImage" | "optimisticBindImage">
    & { findImagesByIdentity?: (gameId: number, sourceUrl: string) => Promise<ImageIngestSnapshot["images"]> };
  r2: R2ImageStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  clock?: Clock;
  download?: (request: Parameters<typeof import("./downloader").downloadImageSource>[0]) => Promise<DownloadResult>;
  validate?: (bytes: Uint8Array, contentType: string | null) => ImageValidation;
  hash?: (bytes: Uint8Array) => Promise<string>;
  storageKey?: (hash: string, mimeType: "image/jpeg" | "image/png" | "image/webp") => string;
  gameDeadlineMs?: number;
};

export type { Clock, ImageBinding, ImageCandidate, ImageGameSnapshot, ImageIngestRepository, ImageIngestSnapshot };
