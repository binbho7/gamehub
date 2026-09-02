import { and, eq, inArray, sql } from "drizzle-orm";
import type { SteamImportPlan } from "../../importers/candidate";
import { SteamImportError } from "../../importers/errors";
import type { GameHubDatabase } from "../client";
import {
  companies,
  gameCompanies,
  gameExternalIds,
  gameGenres,
  gameImages,
  gameOfficialLinks,
  gamePlatforms,
  games,
  gameVideos,
  genres,
  platforms,
} from "../schema";

export type IndexedGame = Pick<typeof games.$inferSelect, "id" | "slug" | "title">;
export type IndexedTaxonomy = Pick<typeof genres.$inferSelect, "id" | "slug" | "name">;
export type IndexedCompany = Pick<typeof companies.$inferSelect, "id" | "slug" | "name">;

export type SteamImportSnapshot = {
  game: typeof games.$inferSelect;
  externalIds: Array<typeof gameExternalIds.$inferSelect>;
  officialLinks: Array<typeof gameOfficialLinks.$inferSelect>;
  genres: IndexedTaxonomy[];
  platforms: IndexedTaxonomy[];
  companies: Array<IndexedCompany & { role: string }>;
  images: Array<typeof gameImages.$inferSelect>;
  videos: Array<typeof gameVideos.$inferSelect>;
};

export type SteamImportStore = {
  findSnapshotByExternalId(provider: string, externalId: string): Promise<SteamImportSnapshot | null>;
  findGameBySlug(slug: string): Promise<IndexedGame | null>;
  findGenresBySlugs(slugs: string[]): Promise<IndexedTaxonomy[]>;
  findPlatformsBySlugs(slugs: string[]): Promise<IndexedTaxonomy[]>;
  findCompaniesBySlugs(slugs: string[]): Promise<IndexedCompany[]>;
  applyPlan(plan: SteamImportPlan): Promise<void>;
};

export function createSteamImportStore(db: GameHubDatabase): SteamImportStore {
  return {
    async findSnapshotByExternalId(provider, externalId) {
      const matched = (await db.select({ game: games })
        .from(gameExternalIds)
        .innerJoin(games, eq(gameExternalIds.gameId, games.id))
        .where(and(
          eq(gameExternalIds.provider, provider),
          eq(gameExternalIds.externalId, externalId),
        ))
        .limit(1))[0];
      if (!matched) {
        return null;
      }

      const gameId = matched.game.id;
      const [externalIds, officialLinks, genreRows, platformRows, companyRows, images, videos] = await Promise.all([
        db.select().from(gameExternalIds).where(eq(gameExternalIds.gameId, gameId)),
        db.select().from(gameOfficialLinks).where(eq(gameOfficialLinks.gameId, gameId)),
        db.select({ id: genres.id, slug: genres.slug, name: genres.name })
          .from(gameGenres)
          .innerJoin(genres, eq(gameGenres.genreId, genres.id))
          .where(eq(gameGenres.gameId, gameId)),
        db.select({ id: platforms.id, slug: platforms.slug, name: platforms.name })
          .from(gamePlatforms)
          .innerJoin(platforms, eq(gamePlatforms.platformId, platforms.id))
          .where(eq(gamePlatforms.gameId, gameId)),
        db.select({ id: companies.id, slug: companies.slug, name: companies.name, role: gameCompanies.role })
          .from(gameCompanies)
          .innerJoin(companies, eq(gameCompanies.companyId, companies.id))
          .where(eq(gameCompanies.gameId, gameId)),
        db.select().from(gameImages).where(eq(gameImages.gameId, gameId)),
        db.select().from(gameVideos).where(eq(gameVideos.gameId, gameId)),
      ]);

      return {
        game: matched.game,
        externalIds,
        officialLinks,
        genres: genreRows,
        platforms: platformRows,
        companies: companyRows,
        images,
        videos,
      };
    },

    async findGameBySlug(slug) {
      return (await db.select({ id: games.id, slug: games.slug, title: games.title })
        .from(games)
        .where(eq(games.slug, slug))
        .limit(1))[0] ?? null;
    },

    async findGenresBySlugs(slugs) {
      if (slugs.length === 0) return [];
      return db.select({ id: genres.id, slug: genres.slug, name: genres.name })
        .from(genres)
        .where(inArray(genres.slug, slugs));
    },

    async findPlatformsBySlugs(slugs) {
      if (slugs.length === 0) return [];
      return db.select({ id: platforms.id, slug: platforms.slug, name: platforms.name })
        .from(platforms)
        .where(inArray(platforms.slug, slugs));
    },

    async findCompaniesBySlugs(slugs) {
      if (slugs.length === 0) return [];
      return db.select({ id: companies.id, slug: companies.slug, name: companies.name })
        .from(companies)
        .where(inArray(companies.slug, slugs));
    },

    async applyPlan(plan) {
      if (plan.action === "existing" || (plan.action === "update" && plan.updates.length === 0)) {
        return;
      }

      type BatchQuery = Parameters<typeof db.batch>[0][number];
      const queries: BatchQuery[] = [];
      const { candidate } = plan;
      const executeBatch = async () => {
        if (queries.length === 0) return;
        try {
          await db.batch(queries as [typeof queries[number], ...typeof queries[number][]]);
        } catch (cause) {
          const detail = cause instanceof Error ? `: ${cause.message}` : "";
          throw new SteamImportError("write_conflict", `Steam import batch failed${detail}`, cause);
        }
      };

      if (plan.action === "update") {
        if (plan.existingGameId == null) {
          throw new SteamImportError("write_conflict", "Steam update plan is missing its existing game ID");
        }

        const canonicalStoreUrl = `https://store.steampowered.com/app/${candidate.source.externalId}/`;
        for (const update of plan.updates) {
          if (update.entity === "external_id") {
            const externalId = candidate.externalIds.find((item) => (
              `${item.provider}:${item.externalId}` === update.key
              && item.provider === "steam"
              && item.externalId === candidate.source.externalId
            ));
            if (externalId && Object.hasOwn(update.changes, "externalUrl")) {
              queries.push(db.update(gameExternalIds).set({
                externalUrl: externalId.externalUrl,
                updatedAt: new Date(),
              }).where(and(
                eq(gameExternalIds.gameId, plan.existingGameId),
                eq(gameExternalIds.provider, externalId.provider),
                eq(gameExternalIds.externalId, externalId.externalId),
              )));
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
              queries.push(db.update(gameOfficialLinks).set(values).where(and(
                eq(gameOfficialLinks.gameId, plan.existingGameId),
                eq(gameOfficialLinks.provider, "steam"),
                eq(gameOfficialLinks.linkType, "store"),
                eq(gameOfficialLinks.url, canonicalStoreUrl),
              )));
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
              "title" | "thumbnailUrl" | "sortOrder"
            >> = {};
            if (Object.hasOwn(update.changes, "title")) values.title = video.title;
            if (Object.hasOwn(update.changes, "thumbnailUrl")) values.thumbnailUrl = video.thumbnailUrl;
            if (Object.hasOwn(update.changes, "sortOrder")) values.sortOrder = video.sortOrder;
            if (Object.keys(values).length > 0) {
              queries.push(db.update(gameVideos).set(values).where(and(
                eq(gameVideos.gameId, plan.existingGameId),
                eq(gameVideos.provider, video.provider),
                eq(gameVideos.externalId, video.externalId),
              )));
            }
          }
        }

        await executeBatch();
        return;
      }

      const gameIdBySlug = sql<number>`(
        select ${games.id}
        from ${games}
        where ${games.slug} = ${plan.selectedSlug}
      )`;
      const gameIdBySteamMapping = sql<number>`(
        select ${gameExternalIds.gameId}
        from ${gameExternalIds}
        where ${gameExternalIds.provider} = ${candidate.source.provider}
          and ${gameExternalIds.externalId} = ${candidate.source.externalId}
      )`;

      queries.push(db.insert(games).values({
        slug: plan.selectedSlug,
        title: candidate.game.title,
        summary: candidate.game.summary,
        description: candidate.game.description,
        status: candidate.game.status,
        releaseDate: candidate.game.releaseDate,
        coverUrl: candidate.game.coverUrl,
        heroUrl: candidate.game.heroUrl,
      }));
      queries.push(db.insert(gameExternalIds).values(candidate.externalIds.map((externalId) => ({
        gameId: gameIdBySlug,
        provider: externalId.provider,
        externalId: externalId.externalId,
        externalUrl: externalId.externalUrl,
      }))));

      const genreLookups = [...new Map(candidate.genres.map((genre) => [genre.slug, genre])).values()];
      if (genreLookups.length > 0) {
        queries.push(db.insert(genres).values(genreLookups).onConflictDoNothing());
      }
      const platformLookups = [...new Map(candidate.platforms.map((platform) => [platform.slug, platform])).values()];
      if (platformLookups.length > 0) {
        queries.push(db.insert(platforms).values(platformLookups).onConflictDoNothing());
      }
      const companyLookups = [...new Map(plan.resolvedCompanies.map((company) => [company.slug, {
        slug: company.slug,
        name: company.name,
      }])).values()];
      if (companyLookups.length > 0) {
        queries.push(db.insert(companies).values(companyLookups).onConflictDoNothing());
      }

      if (candidate.genres.length > 0) {
        queries.push(db.insert(gameGenres).values(candidate.genres.map((genre) => ({
          gameId: gameIdBySteamMapping,
          genreId: sql<number>`(
            select ${genres.id}
            from ${genres}
            where ${genres.slug} = ${genre.slug}
          )`,
        }))));
      }
      if (candidate.platforms.length > 0) {
        queries.push(db.insert(gamePlatforms).values(candidate.platforms.map((platform) => ({
          gameId: gameIdBySteamMapping,
          platformId: sql<number>`(
            select ${platforms.id}
            from ${platforms}
            where ${platforms.slug} = ${platform.slug}
          )`,
        }))));
      }
      if (plan.resolvedCompanies.length > 0) {
        queries.push(db.insert(gameCompanies).values(plan.resolvedCompanies.map((company) => ({
          gameId: gameIdBySteamMapping,
          companyId: sql<number>`(
            select ${companies.id}
            from ${companies}
            where ${companies.slug} = ${company.slug}
          )`,
          role: company.role,
        }))));
      }

      if (candidate.officialLinks.length > 0) {
        queries.push(db.insert(gameOfficialLinks).values(candidate.officialLinks.map((link) => ({
          gameId: gameIdBySteamMapping,
          provider: link.provider,
          platform: link.platform,
          linkType: link.linkType,
          url: link.url,
          isOfficial: link.isOfficial,
          verificationStatus: link.verificationStatus,
          verificationMethod: link.verificationMethod,
        }))));
      }
      if (candidate.images.length > 0) {
        queries.push(db.insert(gameImages).values(candidate.images.map((image) => ({
          gameId: gameIdBySteamMapping,
          type: image.type,
          sourceUrl: image.sourceUrl,
          width: image.width,
          height: image.height,
          sortOrder: image.sortOrder,
        }))));
      }
      if (candidate.videos.length > 0) {
        queries.push(db.insert(gameVideos).values(candidate.videos.map((video) => ({
          gameId: gameIdBySteamMapping,
          provider: video.provider,
          externalId: video.externalId,
          title: video.title,
          thumbnailUrl: video.thumbnailUrl,
          sortOrder: video.sortOrder,
        }))));
      }

      await executeBatch();
    },
  };
}
