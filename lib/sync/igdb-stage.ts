import { IgdbError } from "../providers/igdb/errors";
import {
  isStageError,
  stageError,
  type CanonicalSyncStage,
  type IgdbEnricherPort,
  type StageContext,
} from "./stages";

const IGDB_STATUSES = ["enrich", "existing", "blocked"] as const;

function isValidResult(value: unknown, gameId: number, context: StageContext): value is {
  status: (typeof IGDB_STATUSES)[number];
  gameId: number;
  dryRun: boolean;
  plan: { action: (typeof IGDB_STATUSES)[number]; gameId: number };
} {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  if (result.gameId !== gameId || result.dryRun !== context.dryRun) return false;
  if (typeof result.status !== "string" || !IGDB_STATUSES.includes(result.status as typeof IGDB_STATUSES[number])) return false;
  if (typeof result.plan !== "object" || result.plan === null) return false;
  const plan = result.plan as Record<string, unknown>;
  return plan.gameId === gameId && plan.action === result.status;
}

export function createIgdbStage(enricher: IgdbEnricherPort): CanonicalSyncStage {
  return {
    async execute(gameId, context) {
      try {
        const result = await enricher.enrichGame(gameId, { dryRun: context.dryRun });
        if (!isValidResult(result, gameId, context)) throw stageError("igdb", "invalid_result");
        if (result.status === "blocked") throw stageError("igdb", "blocked");
        return { summary: `IGDB ${result.status}.` };
      } catch (error) {
        if (isStageError(error, "igdb")) throw error;
        if (error instanceof IgdbError) throw stageError("igdb", error.code);
        throw stageError("igdb", "unexpected_error");
      }
    },
  };
}
