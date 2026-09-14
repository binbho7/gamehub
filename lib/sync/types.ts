export const STAGE_NAMES = ["steam", "igdb", "links", "images"] as const;

export type StageName = (typeof STAGE_NAMES)[number];

export type NotRunReason =
  | "canonical_game_not_persisted"
  | "previous_stage_failed";

export type PublicError = {
  code: string;
  message: string;
};

export type BulkStageResult = {
  name: StageName;
  status: "succeeded" | "failed" | "not_run";
  summary: string;
  reason?: NotRunReason;
  error?: PublicError;
};

export type BulkGameResult = {
  appId: string;
  gameId: number | null;
  status: "succeeded" | "failed";
  stages: BulkStageResult[];
};

export type BulkGameSyncResult = {
  dryRun: boolean;
  total: number;
  succeeded: number;
  failed: number;
  games: BulkGameResult[];
};
