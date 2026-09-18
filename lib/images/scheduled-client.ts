import { parseScheduledMutationAuthority, type CronSignals, type ScheduledMutationAuthority } from "../scheduler/types";
import { stageError, type ImageWorkerClient } from "../sync/stages";
import { parseScheduledImageRequest, parseScheduledImageResponse, readScheduledImageBody, SCHEDULED_IMAGE_PATH, SCHEDULED_IMAGE_RESPONSE_LIMIT } from "./scheduled-codec";

export function createScheduledImageClient(input: { binding: { fetch(request: Request): Promise<Response> }; token: string; authority: ScheduledMutationAuthority; signals: CronSignals; newRequestId: () => string }): ImageWorkerClient {
  const authority = parseScheduledMutationAuthority(input.authority);
  if (!input.token || /\s/.test(input.token)) throw new Error("Invalid scheduled image credential");
  return { async ingest(gameId, options) {
    if (!options.write || input.signals.readAuthorityLoss()) throw stageError("images", "worker_invalid_response");
    const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, mode: "scheduled", requestId: input.newRequestId(), gameId, write: true, authority }));
    const envelope = parseScheduledImageRequest(bytes);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(stageError("images", "worker_network_error")); }, 310_000); });
    try {
      const operation = async () => {
        let response: Response;
        try { response = await input.binding.fetch(new Request(`https://image.internal${SCHEDULED_IMAGE_PATH}`, { method: "POST", redirect: "error", signal: controller.signal, headers: { "content-type": "application/json", authorization: `Bearer ${input.token}` }, body: bytes })); }
        catch { throw stageError("images", "worker_network_error"); }
        if (!response.ok) throw stageError("images", "worker_http_error");
        try { return parseScheduledImageResponse(await readScheduledImageBody(response, SCHEDULED_IMAGE_RESPONSE_LIMIT, controller.signal), envelope); }
        catch { throw stageError("images", "worker_invalid_response"); }
      };
      const response = await Promise.race([operation(), timeout]);
      if (response.authorityStatus === "fence_lost") input.signals.markAuthorityLoss("fence_lost");
      const codes = [response.result.preflightError, ...response.result.images.flatMap(item => [item.outcome, item.error?.code, ...item.attempts.map(attempt => attempt.errorCode)])];
      if (codes.some(code => code === "game_deadline" || code === "deadline" || code === "image_deadline")) input.signals.markUnsettled("image_deadline");
      if (codes.some(code => code === "storage_failed" || code === "d1_write_failed")) input.signals.markUnsettled("image_mutation_unknown");
      return response.result;
    } catch (error) { input.signals.markUnsettled("image_delivery_unknown"); throw error; }
    finally { clearTimeout(timer); }
  } };
}
