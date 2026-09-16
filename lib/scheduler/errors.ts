import type { CronFailureCode, SafeCronError } from "./types";

const MESSAGES: Record<CronFailureCode, string> = {
  configuration_error: "The Cron sync configuration is invalid.",
  composition_failed: "The Cron sync stage dependencies could not be created.",
  lease_acquire_failed: "The Cron sync lease could not be acquired.",
  lease_lost: "The Cron sync lease was lost before an authoritative operation completed.",
  fence_lost: "The Cron sync mutation was rejected because authority was lost.",
  candidate_read_failed: "The Cron sync candidate list could not be read.",
  state_write_failed: "The Cron sync state could not be written.",
  state_conflict: "The Cron sync state changed before it could be finalized.",
  pipeline_contract_error: "The Cron sync pipeline returned an invalid result.",
  lease_release_failed: "The Cron sync lease could not be released.",
};

export function safeCronError(code: CronFailureCode): SafeCronError {
  return Object.freeze({ code, message: MESSAGES[code] });
}

export class FenceLostError extends Error {
  readonly code = "fence_lost" as const;

  constructor() {
    super("The Cron sync mutation was rejected because authority was lost.");
    this.name = "FenceLostError";
  }
}
