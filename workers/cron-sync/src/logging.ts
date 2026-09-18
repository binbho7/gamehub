import { z } from "zod";
import { STAGE_FAILURE_CODES } from "../../../lib/sync/stages";

const count = z.number().int().safe().nonnegative().max(25);
const milliseconds = z.number().int().safe().nonnegative();
const base = { executionId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/), timestamp: milliseconds };
const game = { gameId: z.number().int().safe().positive(), appId: z.string().regex(/^[1-9]\d{0,9}$/) };
const cronCode = z.enum(["configuration_error", "composition_failed", "lease_acquire_failed", "lease_lost", "fence_lost",
  "candidate_read_failed", "state_write_failed", "state_conflict", "pipeline_contract_error", "lease_release_failed"]);
const schema = z.discriminatedUnion("event", [
  z.strictObject({ ...base, event: z.literal("cron_started") }),
  z.strictObject({ ...base, event: z.literal("lease_acquired"), fenceEpoch: z.number().int().safe().positive() }),
  z.strictObject({ ...base, event: z.literal("lease_skipped") }),
  z.strictObject({ ...base, event: z.literal("candidates_selected"), selected: count }),
  z.strictObject({ ...base, ...game, event: z.literal("game_finished"), status: z.enum(["succeeded", "failed"]),
    stage: z.enum(["steam", "igdb", "links", "images"]).optional(), code: z.enum(STAGE_FAILURE_CODES).optional() }),
  z.strictObject({ ...base, event: z.literal("deadline_stop"), elapsedMs: milliseconds }),
  z.strictObject({ ...base, event: z.literal("authority_lost"), code: z.enum(["lease_lost", "fence_lost"]) }),
  z.strictObject({ ...base, event: z.literal("verifier_unavailable"), code: z.enum([
    "verifier_service_unavailable", "verifier_timeout", "verifier_protocol_error", "verifier_auth_error", "verifier_invalid_response",
  ]) }),
  z.strictObject({ ...base, event: z.literal("cron_finished"), status: z.enum(["completed", "partial", "skipped", "failed"]),
    selected: count, attempted: count, succeeded: count, failed: count, notStarted: count,
    elapsedMs: milliseconds, code: cronCode.optional(),
    leaseDisposition: z.enum(["not_acquired", "released", "retained_until_expiry", "no_longer_owned"]) }),
]);

export type SafeCronEvent = z.infer<typeof schema>;

export function emitCronEvent(event: SafeCronEvent, sink: (line: string) => void): void {
  try {
    const parsed = schema.safeParse(event);
    if (parsed.success) sink(JSON.stringify(parsed.data));
  } catch { /* Logging cannot replay or interrupt work, even for hostile objects/sinks. */ }
}
