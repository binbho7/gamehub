import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import type { SteamImportPlan } from "../../importers/candidate";
import type { GameHubDatabase } from "../client";
import { gameExternalIds, gameOfficialLinks, gameVideos } from "../schema";
import { compileDomainQuery, type BuiltDomainQuery } from "./scheduled/fence";

function withGuard(predicates: SQL[], guard?: SQL) {
  return guard ? [...predicates, guard] : predicates;
}

export function buildSteamUpdateQueries(
  db: GameHubDatabase,
  plan: SteamImportPlan,
  guard?: SQL,
): BuiltDomainQuery[] {
  if (plan.action !== "update" || plan.existingGameId == null) return [];

  const queries: BuiltDomainQuery[] = [];
  const { candidate } = plan;
  const canonicalStoreUrl = `https://store.steampowered.com/app/${candidate.source.externalId}/`;

  for (const update of plan.updates) {
    if (update.entity === "external_id") {
      const externalId = candidate.externalIds.find((item) => (
        `${item.provider}:${item.externalId}` === update.key
        && item.provider === "steam"
        && item.externalId === candidate.source.externalId
      ));
      if (externalId && Object.hasOwn(update.changes, "externalUrl")) {
        queries.push(compileDomainQuery(db.update(gameExternalIds).set({
          externalUrl: externalId.externalUrl,
          updatedAt: new Date(),
        }).where(and(...withGuard([
          eq(gameExternalIds.gameId, plan.existingGameId),
          eq(gameExternalIds.provider, externalId.provider),
          eq(gameExternalIds.externalId, externalId.externalId),
          sql`${gameExternalIds.externalUrl} is not ${externalId.externalUrl}`,
        ], guard))), { minChanges: 0, maxChanges: 1 }));
      }
      continue;
    }

    if (update.entity === "official_link") {
      const link = candidate.officialLinks.find((item) => (
        item.url === update.key
        && item.url === canonicalStoreUrl
        && item.provider === "steam"
        && item.linkType === "store"
      ));
      if (!link) continue;
      const values: Partial<Pick<
        typeof gameOfficialLinks.$inferInsert,
        "isOfficial" | "verificationStatus" | "verificationMethod" | "updatedAt"
      >> = {};
      if (Object.hasOwn(update.changes, "isOfficial")) values.isOfficial = link.isOfficial;
      if (Object.hasOwn(update.changes, "verificationStatus")) values.verificationStatus = link.verificationStatus;
      if (Object.hasOwn(update.changes, "verificationMethod")) values.verificationMethod = link.verificationMethod;
      if (Object.keys(values).length > 0) {
        values.updatedAt = new Date();
        const changedPredicates: SQL[] = [];
        if (Object.hasOwn(update.changes, "isOfficial")) {
          changedPredicates.push(sql`${gameOfficialLinks.isOfficial} is not ${link.isOfficial ? 1 : 0}`);
        }
        if (Object.hasOwn(update.changes, "verificationStatus")) {
          changedPredicates.push(sql`${gameOfficialLinks.verificationStatus} is not ${link.verificationStatus}`);
        }
        if (Object.hasOwn(update.changes, "verificationMethod")) {
          changedPredicates.push(sql`${gameOfficialLinks.verificationMethod} is not ${link.verificationMethod}`);
        }
        const changed = or(...changedPredicates);
        if (!changed) continue;
        queries.push(compileDomainQuery(db.update(gameOfficialLinks).set(values).where(and(...withGuard([
          eq(gameOfficialLinks.gameId, plan.existingGameId),
          eq(gameOfficialLinks.provider, "steam"),
          isNull(gameOfficialLinks.platform),
          eq(gameOfficialLinks.linkType, "store"),
          eq(gameOfficialLinks.url, canonicalStoreUrl),
          sql`${gameOfficialLinks.verificationMethod} is not 'manual'`,
          changed,
        ], guard))), { minChanges: 0, maxChanges: 1 }));
      }
      continue;
    }

    if (update.entity === "video") {
      const video = candidate.videos.find((item) => (
        `${item.provider}:${item.externalId}` === update.key
        && item.provider === "steam"
      ));
      if (!video) continue;
      const values: Partial<Pick<
        typeof gameVideos.$inferInsert,
        "title" | "thumbnailUrl"
      >> = {};
      if (Object.hasOwn(update.changes, "title")) values.title = video.title;
      if (Object.hasOwn(update.changes, "thumbnailUrl")) values.thumbnailUrl = video.thumbnailUrl;
      if (Object.keys(values).length > 0) {
        const changedPredicates: SQL[] = [];
        if (Object.hasOwn(update.changes, "title")) {
          changedPredicates.push(sql`${gameVideos.title} is not ${video.title}`);
        }
        if (Object.hasOwn(update.changes, "thumbnailUrl")) {
          changedPredicates.push(sql`${gameVideos.thumbnailUrl} is not ${video.thumbnailUrl}`);
        }
        const changed = or(...changedPredicates);
        if (!changed) continue;
        queries.push(compileDomainQuery(db.update(gameVideos).set(values).where(and(...withGuard([
          eq(gameVideos.gameId, plan.existingGameId),
          eq(gameVideos.provider, video.provider),
          eq(gameVideos.externalId, video.externalId),
          changed,
        ], guard))), { minChanges: 0, maxChanges: 1 }));
      }
    }
  }

  return queries;
}
