import { and, asc, eq, inArray } from "drizzle-orm";
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
  };
}
