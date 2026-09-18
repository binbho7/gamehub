/// <reference types="@cloudflare/workers-types" />
import { z } from "zod";
import { parseCronSyncConfig } from "../../../lib/scheduler/config";
import { safeCronError } from "../../../lib/scheduler/errors";
import type { CronSyncConfig } from "../../../lib/scheduler/types";

export type CronWorkerEnv = Pick<Cloudflare.Env, "DB" | "IMAGE_INGEST" | "VERIFIER_CONTAINER"> & {
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  VERIFIER_SERVICE_SECRET: string;
  IMAGE_INGEST_SCHEDULED_TOKEN: string;
  CRON_BATCH_SIZE?: string;
  CRON_SOFT_DEADLINE_MS?: string;
  CRON_GAME_RESERVE_MS?: string;
  CRON_FINISH_RESERVE_MS?: string;
  CRON_LEASE_MS?: string;
};
export type CronWorkerConfig = {
  sync: CronSyncConfig;
  clientId: string;
  clientSecret: string;
  verifierSecret: string;
  scheduledImageToken: string;
};

const capability = (methods: string[]) => z.custom(value => value !== null
  && typeof value === "object"
  && methods.every(key => typeof (value as Record<string, unknown>)[key] === "function"));
const credential = z.string().min(1).max(4096).regex(/^\S+$/);
const integer = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().safe()).optional();
const environment = z.strictObject({
  DB: capability(["prepare", "batch"]), IMAGE_INGEST: capability(["fetch"]),
  VERIFIER_CONTAINER: capability(["idFromName", "get"]),
  TWITCH_CLIENT_ID: credential, TWITCH_CLIENT_SECRET: credential,
  VERIFIER_SERVICE_SECRET: credential, IMAGE_INGEST_SCHEDULED_TOKEN: credential,
  CRON_BATCH_SIZE: integer, CRON_SOFT_DEADLINE_MS: integer, CRON_GAME_RESERVE_MS: integer,
  CRON_FINISH_RESERVE_MS: integer, CRON_LEASE_MS: integer,
});

export function parseCronWorkerEnvironment(value: unknown): CronWorkerConfig {
  try {
    const env = environment.parse(value);
    return {
      sync: parseCronSyncConfig({ batchSize: env.CRON_BATCH_SIZE, softDeadlineMs: env.CRON_SOFT_DEADLINE_MS,
        gameAdmissionReserveMs: env.CRON_GAME_RESERVE_MS, finishReserveMs: env.CRON_FINISH_RESERVE_MS,
        leaseDurationMs: env.CRON_LEASE_MS }),
      clientId: env.TWITCH_CLIENT_ID, clientSecret: env.TWITCH_CLIENT_SECRET,
      verifierSecret: env.VERIFIER_SERVICE_SECRET, scheduledImageToken: env.IMAGE_INGEST_SCHEDULED_TOKEN,
    };
  } catch { throw safeCronError("configuration_error"); }
}

// Operator-side readiness gate. Account entitlements cannot be inferred from
// local JSON: the deployment operator must verify and confirm the paid tier.
export function assertCronDeploymentReady(cronValue: unknown, imageValue: unknown, paidPlanConfirmed: boolean): void {
  const privateWorker = z.object({ workers_dev: z.literal(false), preview_urls: z.literal(false), routes: z.array(z.never()),
    d1_databases: z.array(z.object({ binding: z.literal("DB"), database_id: z.uuid()
      .refine(id => id !== "00000000-0000-0000-0000-000000000000") })).length(1) });
  try {
    if (!paidPlanConfirmed) throw new Error("Paid platform entitlement required");
    const cron = privateWorker.extend({ limits: z.object({ cpu_ms: z.literal(300000) }),
      triggers: z.object({ crons: z.array(z.literal("0 3 * * *")).max(1) }),
      services: z.array(z.object({ binding: z.literal("IMAGE_INGEST"), service: z.string().min(1) })).length(1),
      containers: z.array(z.object({ max_instances: z.literal(1) })).length(1),
    }).parse(cronValue);
    const image = privateWorker.extend({ name: z.string().min(1) }).parse(imageValue);
    if (cron.d1_databases[0].database_id !== image.d1_databases[0].database_id
      || cron.services[0].service !== image.name) throw new Error("Bindings must share the exact database and service");
  } catch { throw safeCronError("configuration_error"); }
}
