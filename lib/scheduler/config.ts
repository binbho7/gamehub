import { z } from "zod";
import type { CronSyncConfig } from "./types";

const configSchema = z.strictObject({
  batchSize: z.number().int().min(1).max(25).default(25),
  platformWallBudgetMs: z.literal(900_000).default(900_000),
  softDeadlineMs: z.number().int().positive().max(720_000).default(720_000),
  gameAdmissionReserveMs: z.number().int().min(780_000).default(780_000),
  finishReserveMs: z.number().int().min(30_000).default(30_000),
  leaseDurationMs: z.number().int().min(1_500_000).default(1_500_000),
}).superRefine((value, ctx) => {
  if (value.softDeadlineMs > value.platformWallBudgetMs) {
    ctx.addIssue({ code: "custom", path: ["softDeadlineMs"], message: "soft deadline exceeds wall budget" });
  }
  if (value.gameAdmissionReserveMs + value.finishReserveMs > value.platformWallBudgetMs) {
    ctx.addIssue({ code: "custom", path: ["gameAdmissionReserveMs"], message: "reserves exceed wall budget" });
  }
  if (value.leaseDurationMs < value.platformWallBudgetMs + value.finishReserveMs) {
    ctx.addIssue({ code: "custom", path: ["leaseDurationMs"], message: "lease has insufficient room" });
  }
});

export function parseCronSyncConfig(value: unknown): CronSyncConfig {
  return configSchema.parse(value === undefined ? {} : value);
}
