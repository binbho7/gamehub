import { z } from "zod";

export const ITEM_STAGES = ["discover", "import", "enrich", "verify", "images", "evaluate"] as const;
export const RUN_STAGES = ["export", "preview", "publish-ready"] as const;
export type ItemStage = typeof ITEM_STAGES[number];
export type RunStage = typeof RUN_STAGES[number];
const common = {
  attemptCount: z.number().int().min(0).max(3),
  reasonCode: z.string().regex(/^[a-z][a-z0-9_]*$/).nullable(),
};
const itemOutcome = z.object({
  state: z.enum(["pending", "running", "succeeded", "retryable_failed", "permanently_failed", "blocked", "skipped"]),
  ...common,
  retryClass: z.enum(["none", "retryable", "permanent", "blocked", "run_fatal"]),
}).strict();
const runOutcome = z.object({
  state: z.enum(["pending", "running", "succeeded", "retryable_failed", "permanently_failed"]),
  ...common,
  retryClass: z.enum(["none", "retryable", "permanent", "run_fatal"]),
}).strict();
export type ItemOutcome = z.infer<typeof itemOutcome>;
export type RunOutcome = z.infer<typeof runOutcome>;
export type ItemStages = Record<ItemStage, ItemOutcome>;
export type RunStages = Record<RunStage, RunOutcome>;
export type RunState = {
  status: "created" | "running" | "paused" | "failed" | "ready";
  currentStage: RunStage | null;
  stages: RunStages;
  artifactSha256: string | null;
};
export const pending = () => ({ state: "pending" as const, attemptCount: 0, reasonCode: null, retryClass: "none" as const });
export function initialItemStages(): ItemStages {
  return { discover: { ...pending(), state: "succeeded" }, import: pending(), enrich: pending(),
    verify: pending(), images: pending(), evaluate: pending() };
}
export function initialRunStages(): RunStages {
  return { export: pending(), preview: pending(), "publish-ready": pending() };
}

// History uses contract stage order and outcome field order, not arbitrary input key order.
export function serializeItemStages(stages: ItemStages): string {
  return JSON.stringify(Object.fromEntries(ITEM_STAGES.map((stage) => [stage, itemOutcome.parse(stages[stage])])));
}
export function serializeRunStages(stages: RunStages): string {
  return JSON.stringify(Object.fromEntries(RUN_STAGES.map((stage) => [stage, runOutcome.parse(stages[stage])])));
}
export function parseItemStages(json: string): ItemStages {
  const value = z.object({ discover: itemOutcome, import: itemOutcome, enrich: itemOutcome,
    verify: itemOutcome, images: itemOutcome, evaluate: itemOutcome }).strict().parse(JSON.parse(json));
  if (serializeItemStages(value) !== json) throw new Error("noncanonical item history");
  return value;
}
export function parseRunStages(json: string): RunStages {
  const value = z.object({ export: runOutcome, preview: runOutcome, "publish-ready": runOutcome }).strict().parse(JSON.parse(json));
  if (serializeRunStages(value) !== json) throw new Error("noncanonical run history");
  return value;
}
