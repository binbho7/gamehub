/// <reference types="@cloudflare/workers-types" />

import { authenticateBearer } from "./auth";
import { handleScheduledImageIngest } from "./scheduled";
import { SCHEDULED_IMAGE_PATH } from "../../../lib/images/scheduled-codec";
import { parseWorkerRequest } from "./request";
import { createDatabase } from "../../../lib/db/client";
import { createImageIngestRepository } from "../../../lib/db/repositories/image-ingest";
import { presentImageResult } from "../../../lib/images/presentation";
import { createR2ImageStore } from "../../../lib/images/r2-store";
import { createImageIngestService } from "../../../lib/images/service";
import type { ImageResult, WorkerEnv, WorkerRequestDto } from "../../../lib/images/types";

export type { WorkerEnv, WorkerRequestDto };

type ImageIngestService = Pick<ReturnType<typeof createImageIngestService>, "ingest">;

export type ImageIngestWorkerDependencies = {
  serviceFactory?: (env: WorkerEnv, ctx: ExecutionContext) => ImageIngestService;
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

export function validConfiguration(env: WorkerEnv): boolean {
  if (typeof env.IMAGE_INGEST_TOKEN !== "string" || env.IMAGE_INGEST_TOKEN.length === 0) return false;
  if (env.IMAGE_INGEST_SCHEDULED_TOKEN === env.IMAGE_INGEST_TOKEN) return false;
  if (typeof env.IMAGE_PUBLIC_BASE_URL !== "string") return false;
  try {
    const url = new URL(env.IMAGE_PUBLIC_BASE_URL);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.username || url.password || url.hash || url.search) return false;
    if (url.hostname.toLowerCase().endsWith(".r2.dev") || url.hostname.toLowerCase() === "r2.dev") return false;
  } catch {
    return false;
  }
  return env.DB !== undefined && env.IMAGES_BUCKET !== undefined;
}

function defaultServiceFactory(env: WorkerEnv): ImageIngestService {
  const database = createDatabase(env.DB);
  return createImageIngestService({
    repository: createImageIngestRepository(database),
    r2: createR2ImageStore(env.IMAGES_BUCKET, env.IMAGE_PUBLIC_BASE_URL),
  });
}

export async function handleImageIngest(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext,
  dependencies: ImageIngestWorkerDependencies = {},
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/internal/images/ingest") return errorResponse(404, "not_found", "Not found");
  if (request.method !== "POST") return errorResponse(405, "method_not_allowed", "Method not allowed");
  if (!validConfiguration(env)) return errorResponse(500, "configuration_error", "Image ingest is not configured");
  if (!await authenticateBearer(request, env.IMAGE_INGEST_TOKEN)) return errorResponse(401, "unauthorized", "Unauthorized");

  let input: WorkerRequestDto;
  try {
    input = await parseWorkerRequest(request);
  } catch {
    return errorResponse(400, "invalid_request", "Invalid request");
  }

  try {
    const service = dependencies.serviceFactory?.(env, ctx) ?? defaultServiceFactory(env);
    // The request parser is the only source of the write flag. No caller can
    // smuggle a URL, provider, storage key, or mutation operation into this boundary.
    const result: ImageResult = await service.ingest(input.gameId, { write: input.write, signal: request.signal });
    return jsonResponse(presentImageResult(result), 200);
  } catch {
    // Deliberately do not log the exception: service errors can contain source URLs.
    return errorResponse(500, "internal_error", "Image ingest failed");
  }
}

const worker = {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === SCHEDULED_IMAGE_PATH) return handleScheduledImageIngest(request, env, ctx);
    return handleImageIngest(request, env, ctx);
  },
};

export default worker;
