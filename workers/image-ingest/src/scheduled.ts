import { authenticateBearer } from "./auth";
import { validConfiguration, type ImageIngestWorkerDependencies } from "./index";
import { createDatabase } from "../../../lib/db/client";
import { createScheduledImageRepository } from "../../../lib/db/repositories/scheduled/images";
import { createCronSignals } from "../../../lib/scheduler/signals";
import { createR2ImageStore } from "../../../lib/images/r2-store";
import { createScheduledR2ImageStore } from "../../../lib/images/scheduled-r2-store";
import { createImageIngestService } from "../../../lib/images/service";
import { presentImageResult } from "../../../lib/images/presentation";
import { parseScheduledImageRequest, readScheduledImageBody, SCHEDULED_IMAGE_PATH, SCHEDULED_IMAGE_REQUEST_LIMIT, SCHEDULED_IMAGE_RESPONSE_LIMIT } from "../../../lib/images/scheduled-codec";
import type { WorkerEnv } from "../../../lib/images/types";

const error = (status: number, code: string) => Response.json({ error: { code, message: "Image ingest request failed" } }, { status });
export async function handleScheduledImageIngest(request: Request, env: WorkerEnv, context: ExecutionContext, dependencies: ImageIngestWorkerDependencies = {}): Promise<Response> {
  if (new URL(request.url).pathname !== SCHEDULED_IMAGE_PATH) return error(404, "not_found");
  if (request.method !== "POST") return error(405, "method_not_allowed");
  if (!validConfiguration(env) || !env.IMAGE_INGEST_SCHEDULED_TOKEN) return error(500, "configuration_error");
  if (!await authenticateBearer(request, env.IMAGE_INGEST_SCHEDULED_TOKEN)) return error(401, "unauthorized");
  let input;
  try {
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new Error("Invalid content type");
    input = parseScheduledImageRequest(await readScheduledImageBody(request, SCHEDULED_IMAGE_REQUEST_LIMIT, request.signal));
  } catch { return error(400, "invalid_request"); }
  const signals = createCronSignals();
  try {
    const service = dependencies.serviceFactory?.(env, context) ?? createImageIngestService({
      repository: createScheduledImageRepository({ binding: env.DB, db: createDatabase(env.DB), authority: input.authority, signals }),
      r2: createScheduledR2ImageStore(createR2ImageStore(env.IMAGES_BUCKET, env.IMAGE_PUBLIC_BASE_URL)),
      beforeImage() { if (signals.readAuthorityLoss()) throw new Error("Image authority lost"); },
    });
    const result = await service.ingest(input.gameId, { write: true, signal: request.signal });
    const body = JSON.stringify({ version: 1, requestId: input.requestId, authorityStatus: signals.readAuthorityLoss() ? "fence_lost" : "not_observed_lost", result: presentImageResult(result) });
    if (new TextEncoder().encode(body).byteLength > SCHEDULED_IMAGE_RESPONSE_LIMIT) return error(500, "internal_error");
    return new Response(body, { headers: { "content-type": "application/json" } });
  } catch { return error(500, "internal_error"); }
}
