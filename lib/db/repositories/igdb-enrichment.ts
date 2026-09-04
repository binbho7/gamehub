import { and, asc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { IgdbEnrichmentPlan } from "../../enrichers/igdb-candidate";
import { IgdbError } from "../../providers/igdb/errors";
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

export const IGDB_MAX_BIND_PARAMS_PER_LOOKUP_QUERY = 80;

const igdbExternalIdentityUniquePattern = /\bUNIQUE constraint failed:\s*game_external_ids\.provider\s*,\s*game_external_ids\.external_id(?:\s*:|$)/i;

export type IgdbEnrichmentSnapshot = {
  game: typeof games.$inferSelect;
  steamAppId: string | null;
  externalIds: Array<typeof gameExternalIds.$inferSelect>;
  officialLinks: Array<typeof gameOfficialLinks.$inferSelect>;
  genres: Array<typeof genres.$inferSelect>;
  platforms: Array<typeof platforms.$inferSelect>;
  companies: Array<typeof companies.$inferSelect & { role: string }>;
  images: Array<typeof gameImages.$inferSelect>;
  videos: Array<typeof gameVideos.$inferSelect>;
};

export type IgdbEnrichmentStore = {
  findSnapshotByGameId(gameId: number): Promise<IgdbEnrichmentSnapshot | null>;
  findExternalIdsByProvider(
    provider: string,
    externalIds: string[],
  ): Promise<Array<typeof gameExternalIds.$inferSelect>>;
  findGenresBySlugs(slugs: string[]): Promise<Array<typeof genres.$inferSelect>>;
  findGenresByNames(names: string[]): Promise<Array<typeof genres.$inferSelect>>;
  findPlatformsBySlugs(slugs: string[]): Promise<Array<typeof platforms.$inferSelect>>;
  findPlatformsByNames(names: string[]): Promise<Array<typeof platforms.$inferSelect>>;
  findCompaniesBySlugs(slugs: string[]): Promise<Array<typeof companies.$inferSelect>>;
  findImagesBySourceUrls(
    gameId: number,
    sourceUrls: string[],
  ): Promise<Array<typeof gameImages.$inferSelect>>;
  findVideosByProviderAndExternalIds(
    gameId: number,
    provider: string,
    externalIds: string[],
  ): Promise<Array<typeof gameVideos.$inferSelect>>;
  findOfficialLinksByUrls(
    gameId: number,
    urls: string[],
  ): Promise<Array<typeof gameOfficialLinks.$inferSelect>>;
  applyPlan(plan: IgdbEnrichmentPlan): Promise<{ affectedRows: number }>;
};

type BoundedLookupOptions<T> = {
  candidates: string[];
  fixedBindCount: number;
  keyOf: (row: T) => string;
  query: (chunk: string[]) => Promise<T[]>;
};

async function runBoundedLookup<T>({
  candidates,
  fixedBindCount,
  keyOf,
  query,
}: BoundedLookupOptions<T>): Promise<T[]> {
  if (!Number.isInteger(fixedBindCount) || fixedBindCount < 0) {
    throw new RangeError("Fixed lookup bind count must be a non-negative integer");
  }
  const chunkSize = IGDB_MAX_BIND_PARAMS_PER_LOOKUP_QUERY - fixedBindCount;
  if (chunkSize <= 0) {
    throw new RangeError("Fixed lookup predicates exhaust the D1 bind budget");
  }

  const uniqueCandidates = [...new Set(candidates)];
  if (uniqueCandidates.length === 0) return [];

  const rowsByCandidate = new Map<string, T[]>();
  for (let offset = 0; offset < uniqueCandidates.length; offset += chunkSize) {
    const chunk = uniqueCandidates.slice(offset, offset + chunkSize);
    if (chunk.length === 0) continue;

    for (const row of await query(chunk)) {
      const key = keyOf(row);
      const rows = rowsByCandidate.get(key);
      if (rows) rows.push(row);
      else rowsByCandidate.set(key, [row]);
    }
  }

  return uniqueCandidates.flatMap((candidate) => rowsByCandidate.get(candidate) ?? []);
}

function isIgdbExternalIdentityUniqueConflict(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;

  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    const record = current as { cause?: unknown; message?: unknown };
    if (
      typeof record.message === "string"
      && igdbExternalIdentityUniquePattern.test(record.message)
    ) {
      return true;
    }
    current = record.cause;
  }

  return false;
}

function usableSteamAppId(externalIds: Array<typeof gameExternalIds.$inferSelect>) {
  const usable = externalIds.filter(({ provider, externalId }) => {
    if (provider !== "steam" || !/^[1-9]\d*$/.test(externalId)) return false;
    const numericId = Number(externalId);
    return Number.isSafeInteger(numericId) && numericId > 0;
  });
  return usable.length === 1 ? usable[0]!.externalId : null;
}

export function createIgdbEnrichmentStore(db: GameHubDatabase): IgdbEnrichmentStore {
  return {
    async findSnapshotByGameId(gameId) {
      const game = (await db.select().from(games)
        .where(eq(games.id, gameId))
        .limit(1))[0];
      if (!game) return null;

      const [externalIds, officialLinks, genreRows, platformRows, companyRows, images, videos] = await Promise.all([
        db.select().from(gameExternalIds)
          .where(eq(gameExternalIds.gameId, gameId))
          .orderBy(asc(gameExternalIds.id)),
        db.select().from(gameOfficialLinks)
          .where(eq(gameOfficialLinks.gameId, gameId))
          .orderBy(asc(gameOfficialLinks.id)),
        db.select({
          id: genres.id,
          slug: genres.slug,
          name: genres.name,
          createdAt: genres.createdAt,
          updatedAt: genres.updatedAt,
        })
          .from(gameGenres)
          .innerJoin(genres, eq(gameGenres.genreId, genres.id))
          .where(eq(gameGenres.gameId, gameId))
          .orderBy(asc(genres.id)),
        db.select({
          id: platforms.id,
          slug: platforms.slug,
          name: platforms.name,
          createdAt: platforms.createdAt,
          updatedAt: platforms.updatedAt,
        })
          .from(gamePlatforms)
          .innerJoin(platforms, eq(gamePlatforms.platformId, platforms.id))
          .where(eq(gamePlatforms.gameId, gameId))
          .orderBy(asc(platforms.id)),
        db.select({
          id: companies.id,
          slug: companies.slug,
          name: companies.name,
          websiteUrl: companies.websiteUrl,
          createdAt: companies.createdAt,
          updatedAt: companies.updatedAt,
          role: gameCompanies.role,
        })
          .from(gameCompanies)
          .innerJoin(companies, eq(gameCompanies.companyId, companies.id))
          .where(eq(gameCompanies.gameId, gameId))
          .orderBy(asc(companies.id), asc(gameCompanies.role)),
        db.select().from(gameImages)
          .where(eq(gameImages.gameId, gameId))
          .orderBy(asc(gameImages.sortOrder), asc(gameImages.id)),
        db.select().from(gameVideos)
          .where(eq(gameVideos.gameId, gameId))
          .orderBy(asc(gameVideos.sortOrder), asc(gameVideos.id)),
      ]);

      return {
        game,
        steamAppId: usableSteamAppId(externalIds),
        externalIds,
        officialLinks,
        genres: genreRows,
        platforms: platformRows,
        companies: companyRows,
        images,
        videos,
      };
    },

    async findExternalIdsByProvider(provider, externalIds) {
      return runBoundedLookup({
        candidates: externalIds,
        fixedBindCount: 1,
        keyOf: (row) => row.externalId,
        query: (chunk) => db.select().from(gameExternalIds)
          .where(and(
            eq(gameExternalIds.provider, provider),
            inArray(gameExternalIds.externalId, chunk),
          ))
          .orderBy(asc(gameExternalIds.id)),
      });
    },

    async findGenresBySlugs(slugs) {
      return runBoundedLookup({
        candidates: slugs,
        fixedBindCount: 0,
        keyOf: (row) => row.slug,
        query: (chunk) => db.select().from(genres)
          .where(inArray(genres.slug, chunk))
          .orderBy(asc(genres.id)),
      });
    },

    async findGenresByNames(names) {
      return runBoundedLookup({
        candidates: names,
        fixedBindCount: 0,
        keyOf: (row) => row.name,
        query: (chunk) => db.select().from(genres)
          .where(inArray(genres.name, chunk))
          .orderBy(asc(genres.id)),
      });
    },

    async findPlatformsBySlugs(slugs) {
      return runBoundedLookup({
        candidates: slugs,
        fixedBindCount: 0,
        keyOf: (row) => row.slug,
        query: (chunk) => db.select().from(platforms)
          .where(inArray(platforms.slug, chunk))
          .orderBy(asc(platforms.id)),
      });
    },

    async findPlatformsByNames(names) {
      return runBoundedLookup({
        candidates: names,
        fixedBindCount: 0,
        keyOf: (row) => row.name,
        query: (chunk) => db.select().from(platforms)
          .where(inArray(platforms.name, chunk))
          .orderBy(asc(platforms.id)),
      });
    },

    async findCompaniesBySlugs(slugs) {
      return runBoundedLookup({
        candidates: slugs,
        fixedBindCount: 0,
        keyOf: (row) => row.slug,
        query: (chunk) => db.select().from(companies)
          .where(inArray(companies.slug, chunk))
          .orderBy(asc(companies.id)),
      });
    },

    async findImagesBySourceUrls(gameId, sourceUrls) {
      return runBoundedLookup({
        candidates: sourceUrls,
        fixedBindCount: 1,
        keyOf: (row) => row.sourceUrl,
        query: (chunk) => db.select().from(gameImages)
          .where(and(
            eq(gameImages.gameId, gameId),
            inArray(gameImages.sourceUrl, chunk),
          ))
          .orderBy(asc(gameImages.id)),
      });
    },

    async findVideosByProviderAndExternalIds(gameId, provider, externalIds) {
      return runBoundedLookup({
        candidates: externalIds,
        fixedBindCount: 2,
        keyOf: (row) => row.externalId,
        query: (chunk) => db.select().from(gameVideos)
          .where(and(
            eq(gameVideos.gameId, gameId),
            eq(gameVideos.provider, provider),
            inArray(gameVideos.externalId, chunk),
          ))
          .orderBy(asc(gameVideos.id)),
      });
    },

    async findOfficialLinksByUrls(gameId, urls) {
      return runBoundedLookup({
        candidates: urls,
        fixedBindCount: 1,
        keyOf: (row) => row.url,
        query: (chunk) => db.select().from(gameOfficialLinks)
          .where(and(
            eq(gameOfficialLinks.gameId, gameId),
            inArray(gameOfficialLinks.url, chunk),
          ))
          .orderBy(asc(gameOfficialLinks.id)),
      });
    },

    async applyPlan(plan) {
      if (plan.action === "existing") return { affectedRows: 0 };
      if (plan.action === "blocked") {
        throw new IgdbError(
          "write_conflict",
          "Blocked IGDB enrichment plan cannot be written",
          { retryable: false },
        );
      }

      type BatchQuery = Parameters<typeof db.batch>[0][number];
      const queries: BatchQuery[] = [];
      for (const update of plan.updates) {
        const values: Partial<Record<keyof typeof update.changes, string | SQL>> = {};
        const nullPredicates: SQL[] = [];

        if (update.changes.summary !== undefined) {
          values.summary = sql`coalesce(${games.summary}, ${update.changes.summary})`;
          nullPredicates.push(isNull(games.summary));
        }
        if (update.changes.description !== undefined) {
          values.description = sql`coalesce(${games.description}, ${update.changes.description})`;
          nullPredicates.push(isNull(games.description));
        }
        if (update.changes.releaseDate !== undefined) {
          values.releaseDate = sql`coalesce(${games.releaseDate}, ${update.changes.releaseDate})`;
          nullPredicates.push(isNull(games.releaseDate));
        }
        if (update.changes.coverUrl !== undefined) {
          values.coverUrl = sql`coalesce(${games.coverUrl}, ${update.changes.coverUrl})`;
          nullPredicates.push(isNull(games.coverUrl));
        }
        if (update.changes.heroUrl !== undefined) {
          values.heroUrl = sql`coalesce(${games.heroUrl}, ${update.changes.heroUrl})`;
          nullPredicates.push(isNull(games.heroUrl));
        }

        if (nullPredicates.length > 0) {
          queries.push(db.update(games)
            .set(values)
            .where(and(eq(games.id, plan.gameId), or(...nullPredicates))));
        }
      }

      for (const create of plan.creates) {
        switch (create.entity) {
          case "external_id":
            queries.push(db.insert(gameExternalIds).values(create.values));
            break;
          case "genre":
            queries.push(db.insert(genres).values(create.values));
            break;
          case "game_genre":
            queries.push(db.insert(gameGenres).values({
              gameId: create.values.gameId,
              genreId: sql<number>`(
                select ${genres.id}
                from ${genres}
                where ${genres.slug} = ${create.values.genreSlug}
              )`,
            }));
            break;
          case "platform":
            queries.push(db.insert(platforms).values(create.values));
            break;
          case "game_platform":
            queries.push(db.insert(gamePlatforms).values({
              gameId: create.values.gameId,
              platformId: sql<number>`(
                select ${platforms.id}
                from ${platforms}
                where ${platforms.slug} = ${create.values.platformSlug}
              )`,
            }));
            break;
          case "company":
            queries.push(db.insert(companies).values(create.values));
            break;
          case "game_company":
            queries.push(db.insert(gameCompanies).values({
              gameId: create.values.gameId,
              companyId: sql<number>`(
                select ${companies.id}
                from ${companies}
                where ${companies.slug} = ${create.values.companySlug}
              )`,
              role: create.values.role,
            }));
            break;
          case "official_link":
            queries.push(db.insert(gameOfficialLinks).values(create.values));
            break;
          case "image":
            queries.push(db.insert(gameImages).values(create.values));
            break;
          case "video":
            queries.push(db.insert(gameVideos).values(create.values));
            break;
        }
      }

      if (queries.length === 0) {
        throw new IgdbError(
          "write_conflict",
          "IGDB enrichment plan has no write operations",
          { retryable: false },
        );
      }

      try {
        const results = await db.batch(queries as [BatchQuery, ...BatchQuery[]]);
        return {
          affectedRows: results.reduce((total, result) => total + result.meta.changes, 0),
        };
      } catch (cause) {
        const identityConstraint = isIgdbExternalIdentityUniqueConflict(cause);
        throw new IgdbError(
          "write_conflict",
          "IGDB enrichment write conflict",
          {
            retryable: false,
            ...(identityConstraint ? { constraint: "igdb_external_identity_unique" as const } : {}),
          },
        );
      }
    },
  };
}
