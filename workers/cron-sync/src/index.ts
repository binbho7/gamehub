import { runCronSync } from "../../../lib/scheduler/service";
import { STAGE_FAILURE_CODES, type StageFailureCode } from "../../../lib/sync/stages";
import { composeCronDependencies } from "./composition";
import type { CronWorkerEnv } from "./config";
import { emitCronEvent, type SafeCronEvent } from "./logging";
export { OfficialLinkVerifier } from "./verifier-container";

const cronWorker = {
  async fetch(_request: Request): Promise<Response> {
    void _request;
    return new Response("Not found", { status: 404 });
  },
  async scheduled(controller: ScheduledController, env: CronWorkerEnv, _context: ExecutionContext): Promise<void> {
    void _context;
    const executionId = crypto.randomUUID();
    const started = performance.now();
    const base = () => ({ executionId, timestamp: Date.now() });
    const emit = (event: SafeCronEvent) => emitCronEvent(event, line => console.log(line));
    emit({ ...base(), event: "cron_started" });
    let configured = false;
    try {
      const input = { executionId, scheduledAt: new Date(controller.scheduledTime) };
      const dependencies = composeCronDependencies(env, input);
      configured = true;
      const result = await runCronSync(input, dependencies);
      for (const game of result.games) {
        const failure = game.stages.find(stage => stage.status === "failed");
        const code = failure?.error?.code;
        emit({ ...base(), event: "game_finished", ...(game.gameId === null ? {} : { gameId: game.gameId }), appId: game.appId,
          status: game.status, ...(failure && code && (STAGE_FAILURE_CODES as readonly string[]).includes(code)
            ? { stage: failure.name, code: code as StageFailureCode } : {}) });
        if (failure?.name === "links") {
          // The native adapter preserves these branded verifier service codes;
          // the singleton runner validates them before they reach this boundary.
          switch (code) {
            case "verifier_service_unavailable":
            case "verifier_timeout":
            case "verifier_protocol_error":
            case "verifier_auth_error":
            case "verifier_invalid_response":
              emit({ ...base(), event: "verifier_unavailable", code });
          }
        }
      }
      if (result.stopReason === "soft_deadline") emit({ ...base(), event: "deadline_stop", elapsedMs: Math.floor(dependencies.elapsedMs()) });
      const authorityLoss = [result.primaryError, ...result.secondaryErrors]
        .find(error => error?.code === "lease_lost" || error?.code === "fence_lost");
      if (authorityLoss?.code === "lease_lost" || authorityLoss?.code === "fence_lost") {
        emit({ ...base(), event: "authority_lost", code: authorityLoss.code });
      }
      emit({ ...base(), event: "cron_finished", status: result.status, selected: result.selected, attempted: result.attempted,
        succeeded: result.succeeded, failed: result.failed, notStarted: result.notStarted,
        elapsedMs: Math.floor(performance.now() - started), leaseDisposition: result.leaseDisposition,
        ...(result.primaryError ? { code: result.primaryError.code } : {}) });
    } catch {
      // Never serialize exceptions or env: provider/transport failures may carry secrets.
      emit({ ...base(), event: "cron_finished", status: "failed", selected: 0, attempted: 0, succeeded: 0, failed: 0, notStarted: 0,
        elapsedMs: Math.floor(performance.now() - started), leaseDisposition: configured ? "retained_until_expiry" : "not_acquired",
        code: configured ? "composition_failed" : "configuration_error" });
    }
  },
};
export default cronWorker;
