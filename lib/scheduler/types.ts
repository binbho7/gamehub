import type { BulkGameResult } from "../sync/types";
import type { BulkSyncStages } from "../sync/stages";
import { z } from "zod";

export type ScheduledMutationAuthority = Readonly<{
  ownerToken: string;
  fenceEpoch: number;
  leaseExpiresAtMs: number;
}>;

export type LeaseAuthority = ScheduledMutationAuthority;
export type LeaseHandle = LeaseAuthority;

export type LeaseAcquireResult =
  | { status: "acquired"; lease: LeaseHandle }
  | { status: "held" };

export type SyncCandidate = { gameId: number; appId: string };

export type CronSyncConfig = {
  batchSize: number;
  platformWallBudgetMs: number;
  softDeadlineMs: number;
  gameAdmissionReserveMs: number;
  finishReserveMs: number;
  leaseDurationMs: number;
};

export type CronExecutionInput = { executionId: string; scheduledAt: Date };

export type CronFailureCode =
  | "configuration_error"
  | "composition_failed"
  | "lease_acquire_failed"
  | "lease_lost"
  | "fence_lost"
  | "candidate_read_failed"
  | "state_write_failed"
  | "state_conflict"
  | "pipeline_contract_error"
  | "lease_release_failed";

export type SafeCronError = { code: CronFailureCode; message: string };

export type CronExecutionResult = {
  executionId: string;
  status: "completed" | "partial" | "skipped" | "failed";
  selected: number;
  attempted: number;
  succeeded: number;
  failed: number;
  notStarted: number;
  stopReason: "none" | "active_lease" | "soft_deadline" | "unsettled_remote_work" | "authority_lost" | "infrastructure_failure";
  games: BulkGameResult[];
  primaryError: SafeCronError | null;
  secondaryErrors: Array<{
    code: "lease_release_failed" | "lease_lost" | "fence_lost";
    message: string;
  }>;
  leaseDisposition: "not_acquired" | "released" | "retained_until_expiry" | "no_longer_owned";
};

export interface LeaseRepository {
  acquire(ownerToken: string, durationMs: number): Promise<LeaseAcquireResult>;
  assertOwned(lease: LeaseHandle): Promise<{ dbNowMs: number; leaseExpiresAtMs: number }>;
  release(lease: LeaseHandle): Promise<"released" | "fence_lost">;
}

export interface CandidateRepository {
  select(limit: number): Promise<SyncCandidate[]>;
  stillMatches(candidate: SyncCandidate): Promise<boolean>;
}

export type AttemptStamp = {
  gameId: number;
  attemptedAt: Date;
  authority: ScheduledMutationAuthority;
};

export interface SchedulerStateRepository {
  startAttempt(gameId: number, authority: ScheduledMutationAuthority): Promise<AttemptStamp>;
  finishAttempt(stamp: AttemptStamp, status: "succeeded" | "failed"): Promise<void>;
}

export type UnsettledImageWorkReason =
  | "image_delivery_unknown"
  | "image_deadline"
  | "image_mutation_unknown";

export type CronSignals = {
  markAuthorityLoss(code: "lease_lost" | "fence_lost"): void;
  markUnsettled(reason: UnsettledImageWorkReason): void;
  readAuthorityLoss(): "lease_lost" | "fence_lost" | null;
  readUnsettledImageWork(): readonly UnsettledImageWorkReason[];
};

export type CronGameRuntime = Pick<CronSignals, "readAuthorityLoss" | "readUnsettledImageWork"> & {
  stages: BulkSyncStages;
};

const authoritySchema = z.strictObject({
  ownerToken: z.uuid(),
  fenceEpoch: z.number().int().safe().positive(),
  leaseExpiresAtMs: z.number().int().safe().positive(),
});

export function parseScheduledMutationAuthority(value: unknown): ScheduledMutationAuthority {
  const parsed = authoritySchema.parse(value);
  return Object.freeze({ ...parsed });
}
