import { and, sql } from "drizzle-orm";
import { FenceLostError } from "../../../scheduler/errors";
import {
  parseScheduledMutationAuthority,
  type CronSignals,
  type ScheduledMutationAuthority,
  type SyncCandidate,
} from "../../../scheduler/types";
import { SteamImportError } from "../../../importers/errors";
import type { SteamImportPlan } from "../../../importers/candidate";
import type { GameHubDatabase } from "../../client";
import { createSteamImportStore, type SteamImportStore } from "../steam-import";
import { buildSteamUpdateQueries } from "../steam-import-queries";
import { compileDomainQuery, executeFencedBatch, fencePredicate } from "./fence";
import { games } from "../../schema";

const REJECTED = "Scheduled Steam write was rejected";

function rejectIdentity(): never {
  throw new SteamImportError("write_conflict", REJECTED);
}

export function createScheduledSteamStore(input: {
  binding: D1Database;
  db: GameHubDatabase;
  candidate: SyncCandidate;
  authority: ScheduledMutationAuthority;
  signals: CronSignals;
}): SteamImportStore {
  const authority = parseScheduledMutationAuthority(input.authority);
  const legacy = createSteamImportStore(input.db);

  async function boundSnapshot(provider: string, externalId: string) {
    if (provider !== "steam" || externalId !== input.candidate.appId) rejectIdentity();
    const snapshot = await legacy.findSnapshotByExternalId(provider, externalId);
    if (!snapshot) rejectIdentity();
    if (snapshot.game.id !== input.candidate.gameId) rejectIdentity();
    const steamIds = snapshot.externalIds.filter((item) => item.provider === "steam");
    if (steamIds.length !== 1 || steamIds[0].externalId !== input.candidate.appId) rejectIdentity();
    return snapshot;
  }

  return {
    findSnapshotByExternalId: boundSnapshot,
    findGameBySlug: (slug) => legacy.findGameBySlug(slug),
    findGenresBySlugs: (slugs) => legacy.findGenresBySlugs(slugs),
    findPlatformsBySlugs: (slugs) => legacy.findPlatformsBySlugs(slugs),
    findCompaniesBySlugs: (slugs) => legacy.findCompaniesBySlugs(slugs),
    async applyPlan(plan: SteamImportPlan) {
      if (plan.action === "create" || plan.existingGameId !== input.candidate.gameId
        || plan.candidate.source.provider !== "steam"
        || plan.candidate.source.externalId !== input.candidate.appId) {
        rejectIdentity();
      }
      try {
        const identity = sql`exists (
          select 1 from game_external_ids
          where game_id=${input.candidate.gameId} and provider='steam'
          group by game_id having count(*)=1 and min(external_id)=${input.candidate.appId}
        )`;
        // D1 batches are transactional: the identity read and every guarded write
        // observe the same mapping, including when an empty plan is applied.
        const identityRead = compileDomainQuery(input.db.select({ id: games.id }).from(games)
          .where(and(sql`${games.id}=${input.candidate.gameId}`, identity)),
        { minChanges: 0, maxChanges: 0 });
        const writes = buildSteamUpdateQueries(input.db, plan, and(fencePredicate(authority), identity));
        const result = await executeFencedBatch(input.binding, authority, [identityRead, ...writes]);
        if (result.results[0].length !== 1) rejectIdentity();
        return { affectedRows: result.affectedRows };
      } catch (error) {
        if (error instanceof FenceLostError) input.signals.markAuthorityLoss("fence_lost");
        throw new SteamImportError("write_conflict", REJECTED);
      }
    },
  };
}
