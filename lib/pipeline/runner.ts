import { classifyRetry, type RetryClass } from "./retry";
import { ITEM_STAGES, type ItemStage } from "./state";
import type { ItemEvent } from "./transitions";
import type { ItemRow, RunRow, RunSnapshot } from "./run-repository";

export type PipelineRunnerRepository = {
  load(runId: string): Promise<RunSnapshot>;
  transitionRun(expected: RunRow, event: Exclude<import("./transitions").RunEvent, { type: "admit_export" }>, now: number): Promise<RunRow>;
  transitionItem(expected: ItemRow, stage: ItemStage, event: ItemEvent, now: number): Promise<{ item: ItemRow; action: "execute" | "persist" | "skip_execution" }>;
};

export type PipelineRunnerComposition = {
  runStage(input: { steamAppId: string; stage: ItemStage; gameId: number | null; dryRun: boolean }): Promise<{ status: "succeeded"; gameId: number | null; summary: string }>;
};

export type RunPipelineInput = {
  runId: string;
  repository: PipelineRunnerRepository;
  composition: PipelineRunnerComposition;
  write: boolean;
  now?: () => number;
};

const WORKERS = 4;
const PROVIDER_CAPS: Partial<Record<ItemStage, number>> = { import: 4, enrich: 2, verify: 2, images: 2 };

function reason(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
  return "composition_failure";
}

function semaphore(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try { return await operation(); } finally { active--; queue.shift()?.(); }
  };
}

export async function runPipeline(input: RunPipelineInput): Promise<{ status: RunRow["status"]; run: RunRow; items: ItemRow[] }> {
  const now = input.now ?? (() => Date.now());
  const snapshot = await input.repository.load(input.runId);
  if (!input.write) return { status: snapshot.run.status, run: snapshot.run, items: snapshot.items };

  let run = await input.repository.transitionRun(snapshot.run, { type: "start" }, now());
  const items = [...snapshot.items].sort((left, right) => left.ordinal - right.ordinal);
  const providerQueues = new Map<ItemStage, ReturnType<typeof semaphore>>(
    Object.entries(PROVIDER_CAPS).map(([stage, cap]) => [stage as ItemStage, semaphore(cap!)]),
  );
  const writeQueue = semaphore(1);
  let fatal = false;
  let next = 0;
  const completed: ItemRow[] = [];

  const processItem = async (initial: ItemRow) => {
    let current = initial;
    for (const stage of ITEM_STAGES) {
      if (stage === "discover" || current.current_stage !== stage || current.current_state !== "pending") continue;
      try {
        const started = await writeQueue(() => input.repository.transitionItem(current, stage, { type: "start" }, now()));
        current = started.item;
        const runWithCap: (operation: () => Promise<{ status: "succeeded"; gameId: number | null; summary: string }>) => Promise<{ status: "succeeded"; gameId: number | null; summary: string }> =
          providerQueues.get(stage) ?? ((operation) => operation());
        const result = await runWithCap(() =>
          input.composition.runStage({ steamAppId: current.steam_app_id, stage, gameId: current.game_id, dryRun: false }));
        const succeeded = await writeQueue(() => input.repository.transitionItem(current, stage,
          { type: "succeed", ...(stage === "import" ? { gameId: result.gameId! } : {}) }, now()));
        current = succeeded.item;
      } catch (error) {
        const code = reason(error);
        const classification = classifyRetry(code) as RetryClass;
        await writeQueue(() => input.repository.transitionItem(current, stage,
          { type: "fail", retryClass: classification === "run_fatal" ? "permanent" : classification, reasonCode: code }, now()));
        if (classification === "run_fatal") fatal = true;
        return;
      }
    }
    completed.push(current);
  };

  const worker = async () => {
    while (!fatal) {
      const index = next++;
      if (index >= items.length) return;
      await processItem(items[index]);
    }
  };
  // Fixed worker count is intentional: candidates are claimed one at a time and never spread into an unbounded promise array.
  const workers: Array<Promise<void>> = [];
  for (let index = 0; index < Math.min(WORKERS, items.length); index++) workers.push(worker());
  for (const workerPromise of workers) await workerPromise;
  if (fatal) run = await input.repository.transitionRun(run, { type: "fatal" }, now());
  return { status: run.status, run, items: completed };
}
