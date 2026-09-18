import { z } from "zod";
import type { ImageResult } from "./types";
import { IMAGE_OUTCOMES } from "../sync/image-stage";
import { stageError, type ImageWorkerClient } from "../sync/stages";

const id = z.number().int().positive().safe();
const n = z.number().int().nonnegative().safe();
const text = z.string();
const nullableText = text.nullable();
const provider = z.enum(["steam", "igdb"]);
const timing = z.strictObject({
  startedAt: z.number().finite(),
  finishedAt: z.number().finite(),
  durationMs: z.number().nonnegative().finite(),
});
const dimensions = z.strictObject({ width: id, height: id }).nullable();
const redirect = z.strictObject({
  fromUrl: text,
  location: nullableText,
  resolvedUrl: nullableText,
  status: z.number().int(),
});
const attempt = z.strictObject({
  url: text,
  presentationUrl: text,
  provider,
  method: z.literal("GET"),
  hopStatus: z.enum(["redirect", "response", "failed"]),
  status: z.number().int().nullable(),
  headers: z.strictObject({ contentType: nullableText, contentLength: nullableText }),
  location: nullableText,
  redirectChain: z.array(redirect),
  finalUrl: nullableText,
  selectedMimeType: nullableText,
  byteCount: n.nullable(),
  contentHash: nullableText,
  dimensions,
  timing,
  errorCode: nullableText,
});
const item = z.strictObject({
  imageId: id.nullable(),
  outcome: z.enum(IMAGE_OUTCOMES),
  sourceUrl: text,
  presentationUrl: text,
  provider: provider.nullable(),
  attempts: z.array(attempt),
  redirectChain: z.array(redirect),
  finalUrl: nullableText,
  httpStatus: z.number().int().nullable(),
  selectedMimeType: nullableText,
  byteCount: n.nullable(),
  contentHash: nullableText,
  dimensions,
  timing,
  error: z.strictObject({
    stage: z.enum(["source", "download", "validation", "hash", "storage", "d1"]),
    code: text,
  }).nullable(),
});
const candidate = z.strictObject({
  gameId: id,
  type: z.enum(["cover", "hero", "screenshot", "artwork", "logo"]),
  sourceUrl: text,
  provider,
  width: id.nullable(),
  height: id.nullable(),
  sortOrder: n,
  existingId: id.nullable(),
  mode: z.enum(["read_only", "write"]),
  reason: z.enum(["create_missing_scalar", "inspect_existing_storage", "ingest_existing_image"]),
});
const plan = z.strictObject({
  gameId: id,
  gameSnapshot: z.strictObject({
    id,
    coverUrl: nullableText,
    heroUrl: nullableText,
    updatedAt: z.iso.datetime().transform((value) => new Date(value)),
  }).nullable(),
  candidates: z.array(candidate),
  rejected: z.array(z.strictObject({
    imageId: id.nullable(),
    sourceUrl: text,
    mode: z.literal("read_only"),
    reason: z.literal("source_rejected"),
  })),
  preflight: z.enum(["ok", "game_not_found", "image_limit_exceeded"]),
  dryRun: z.boolean(),
});
const imageResponseSchema = z.strictObject({
  gameId: id,
  status: z.enum(["completed", "partial", "failed"]),
  preflightError: z.enum([
    "invalid_request",
    "game_not_found",
    "image_limit_exceeded",
    "game_deadline",
  ]).nullable(),
  plan: plan.nullable(),
  images: z.array(item),
});

type ParsedImageResponse = z.output<typeof imageResponseSchema>;
const imageResultCompatibility: ParsedImageResponse extends ImageResult ? true : never = true;
void imageResultCompatibility;

const benignOutcomes = new Set([
  "ingested",
  "deduplicated",
  "concurrent_dedup",
  "already_ingested",
  "restored",
  "skipped",
]);

export function parseImageWorkerResponse(
  value: unknown,
  gameId: number,
  write: boolean,
): ImageResult {
  const result = imageResponseSchema.parse(value);
  if (result.gameId !== gameId) throw new Error("Worker identity mismatch");
  if (result.plan !== null) {
    if (
      result.plan.gameId !== gameId
      || (result.plan.gameSnapshot !== null && result.plan.gameSnapshot.id !== gameId)
      || result.plan.candidates.some((entry) => entry.gameId !== gameId)
      || result.plan.dryRun !== !write
      || (!write && result.plan.candidates.some((entry) => entry.mode !== "read_only"))
    ) {
      throw new Error("Worker plan mismatch");
    }
  }
  if (
    result.status === "completed"
    && (result.preflightError !== null || result.images.some((entry) => !benignOutcomes.has(entry.outcome)))
  ) {
    throw new Error("Worker completion mismatch");
  }
  return result;
}

export function createImageWorkerClient(input: {
  workerUrl: string;
  token: string;
  fetchImpl: typeof fetch;
}): ImageWorkerClient {
  return {
    async ingest(gameId, options) {
      let response: Response;
      try {
        response = await input.fetchImpl(input.workerUrl, {
          method: "POST",
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${input.token}`,
          },
          body: JSON.stringify({ gameId, write: options.write }),
        });
      } catch {
        throw stageError("images", "worker_network_error");
      }
      if (!response.ok) throw stageError("images", "worker_http_error");
      try {
        return parseImageWorkerResponse(await response.json(), gameId, options.write);
      } catch {
        throw stageError("images", "worker_invalid_response");
      }
    },
  };
}
