import { and, eq, sql } from "drizzle-orm";
import type { GameHubDatabase } from "../../client";
import { games } from "../../schema";
import { createIgdbEnrichmentStore, isIgdbExternalIdentityUniqueConflict, type IgdbEnrichmentStore } from "../igdb-enrichment";
import { buildIgdbQueries } from "../igdb-enrichment-queries";
import { IgdbError } from "../../../providers/igdb/errors";
import { FenceLostError } from "../../../scheduler/errors";
import { parseScheduledMutationAuthority, type CronSignals, type ScheduledMutationAuthority, type SyncCandidate } from "../../../scheduler/types";
import { compileDomainQuery, executeFencedBatch, fencePredicate } from "./fence";

function writeConflict(cause?: unknown): IgdbError {
  return new IgdbError("write_conflict", "Scheduled IGDB write was rejected", {
    retryable: false,
    ...(isIgdbExternalIdentityUniqueConflict(cause) ? { constraint: "igdb_external_identity_unique" as const } : {}),
  });
}

export function createScheduledIgdbStore(input: {
  binding: D1Database;
  db: GameHubDatabase;
  candidate: SyncCandidate;
  authority: ScheduledMutationAuthority;
  signals: CronSignals;
}): IgdbEnrichmentStore {
  const authority = parseScheduledMutationAuthority(input.authority);
  const candidate = { ...input.candidate };
  const legacy = createIgdbEnrichmentStore(input.db);
  return {
    ...legacy,
    async findSnapshotByGameId(gameId) {
      if (gameId !== candidate.gameId) throw writeConflict();
      const snapshot = await legacy.findSnapshotByGameId(gameId);
      if (!snapshot || snapshot.steamAppId !== candidate.appId) throw writeConflict();
      return snapshot;
    },
    async applyPlan(plan) {
      if (plan.action === "blocked" || plan.gameId !== candidate.gameId
        || plan.creates.some((create) => "gameId" in create.values && create.values.gameId !== candidate.gameId)) {
        throw writeConflict();
      }
      try {
        const identity = sql`exists (
          select 1 from game_external_ids
          where game_id=${candidate.gameId} and provider='steam'
          group by game_id having count(*)=1 and min(external_id)=${candidate.appId}
        )`;
        // This read and all writes share a transaction and the exact identity guard.
        // Even auxiliary taxonomy inserts cannot publish after a mapping change.
        const identityRead = compileDomainQuery(input.db.select({ id: games.id }).from(games)
          .where(and(eq(games.id, candidate.gameId), identity)), { minChanges: 0, maxChanges: 0 });
        const writes = buildIgdbQueries(input.db, plan, and(fencePredicate(authority), identity));
        if (plan.action === "enrich" && writes.length === 0) throw writeConflict();
        const result = await executeFencedBatch(input.binding, authority, [identityRead, ...writes]);
        if (result.results[0].length !== 1) throw writeConflict();
        return { affectedRows: result.affectedRows };
      } catch (cause) {
        if (cause instanceof FenceLostError) input.signals.markAuthorityLoss("fence_lost");
        throw writeConflict(cause);
      }
    },
  };
}
