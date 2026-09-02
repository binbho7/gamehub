import { and, eq, inArray } from "drizzle-orm";
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

    async applyPlan() {
      throw new SteamImportError("write_incomplete", "Steam import writes are implemented in Task 7");
    },
  };
}
