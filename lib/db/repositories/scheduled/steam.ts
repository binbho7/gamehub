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
import { executeFencedBatch, fencePredicate } from "./fence";

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
    if (!snapshot) return null;
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
      if (plan.action === "create" || plan.existingGameId !== input.candidate.gameId) {
        rejectIdentity();
      }
      try {
        const writes = buildSteamUpdateQueries(input.db, plan, fencePredicate(authority));
        return { affectedRows: (await executeFencedBatch(input.binding, authority, writes)).affectedRows };
      } catch (error) {
        if (error instanceof FenceLostError) input.signals.markAuthorityLoss("fence_lost");
        throw new SteamImportError("write_conflict", REJECTED);
      }
    },
  };
}
