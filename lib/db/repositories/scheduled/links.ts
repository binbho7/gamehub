import type { GameHubDatabase } from "../../client";
import { createLinkVerificationStore, type LinkVerificationStore } from "../link-verification";
import { buildLinkVerificationQueries } from "../link-verification-queries";
import { LinkVerificationError } from "../../../verifiers/official-links/errors";
import { FenceLostError } from "../../../scheduler/errors";
import { parseScheduledMutationAuthority, type CronSignals, type ScheduledMutationAuthority } from "../../../scheduler/types";
import { executeFencedBatch, fencePredicate } from "./fence";

export function createScheduledLinkStore(input: {
  binding: D1Database;
  db: GameHubDatabase;
  authority: ScheduledMutationAuthority;
  signals: CronSignals;
}): LinkVerificationStore {
  const authority = parseScheduledMutationAuthority(input.authority);
  const legacy = createLinkVerificationStore(input.db);
  return {
    ...legacy,
    async writePlan(plan) {
      try {
        const updates = buildLinkVerificationQueries(input.db, plan, fencePredicate(authority));
        const result = await executeFencedBatch(input.binding, authority, updates);
        return {
          affectedRows: result.affectedRows,
          appliedLinkIds: updates.filter((_, index) => result.changes[index] === 1).map(update => update.linkId),
          conflicts: updates.filter((_, index) => result.changes[index] === 0)
            .map(update => ({ linkId: update.linkId, code: "write_conflict" as const })),
        };
      } catch (cause) {
        if (cause instanceof FenceLostError) input.signals.markAuthorityLoss("fence_lost");
        throw new LinkVerificationError("write_failed", "Unable to write link verification data");
      }
    },
  };
}
