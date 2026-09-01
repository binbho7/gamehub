import { and, asc, eq, gt } from "drizzle-orm";
import type { GameHubDatabase } from "../client";
import {
  gameExternalIds,
  gameImages,
  gameOfficialLinks,
  games,
  gameVideos,
} from "../schema";
import {
  canonicalIdSchema,
  createGameSchema,
  externalIdSchema,
  gameImageSchema,
  gameListSchema,
  gameVideoSchema,
  officialLinkSchema,
  updateGameSchema,
  type CreateGameInput,
  type ExternalIdInput,
  type GameImageInput,
  type GameListInput,
  type GameVideoInput,
  type OfficialLinkInput,
  type UpdateGameInput,
} from "../validation";

function normalizeProvider(provider: string) {
  return externalIdSchema.shape.provider.parse(provider);
}

export function createGameRepository(db: GameHubDatabase) {
  return {
    async create(input: CreateGameInput) {
      const values = createGameSchema.parse(input);
      const [created] = await db.insert(games).values(values).returning();
      return created!;
    },

    async findById(id: number) {
      const canonicalId = canonicalIdSchema.parse(id);
      return (await db.select().from(games).where(eq(games.id, canonicalId)).limit(1))[0] ?? null;
    },

    async findBySlug(slug: string) {
      const value = createGameSchema.shape.slug.parse(slug);
      return (await db.select().from(games).where(eq(games.slug, value)).limit(1))[0] ?? null;
    },

    async findByExternalId(provider: string, externalId: string) {
      const lookup = externalIdSchema.pick({ provider: true, externalId: true }).parse({ provider, externalId });
      const row = (await db.select({ game: games })
        .from(gameExternalIds)
        .innerJoin(games, eq(gameExternalIds.gameId, games.id))
        .where(and(
          eq(gameExternalIds.provider, lookup.provider),
          eq(gameExternalIds.externalId, lookup.externalId),
        ))
        .limit(1))[0];
      return row?.game ?? null;
    },

    async list(input: GameListInput = {}) {
      const query = gameListSchema.parse(input);
      const conditions = and(
        query.afterId ? gt(games.id, query.afterId) : undefined,
        query.status ? eq(games.status, query.status) : undefined,
      );
      const rows = await db.select().from(games)
        .where(conditions)
        .orderBy(asc(games.id))
        .limit(query.limit + 1);
      const hasMore = rows.length > query.limit;
      const items = hasMore ? rows.slice(0, query.limit) : rows;
      return { items, nextCursor: hasMore ? items.at(-1)!.id : null };
    },

    async update(id: number, input: UpdateGameInput) {
      const canonicalId = canonicalIdSchema.parse(id);
      const values = updateGameSchema.parse(input);
      const [updated] = await db.update(games)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(games.id, canonicalId))
        .returning();
      return updated ?? null;
    },

    async delete(id: number) {
      const canonicalId = canonicalIdSchema.parse(id);
      const deleted = await db.delete(games).where(eq(games.id, canonicalId)).returning({ id: games.id });
      return deleted.length === 1;
    },

    async addExternalId(gameId: number, input: ExternalIdInput) {
      const canonicalId = canonicalIdSchema.parse(gameId);
      const values = externalIdSchema.parse(input);
      const [created] = await db.insert(gameExternalIds)
        .values({ ...values, gameId: canonicalId })
        .returning();
      return created!;
    },

    async listExternalIds(gameId: number) {
      const canonicalId = canonicalIdSchema.parse(gameId);
      return db.select().from(gameExternalIds)
        .where(eq(gameExternalIds.gameId, canonicalId))
        .orderBy(asc(gameExternalIds.id));
    },

    async addOfficialLink(gameId: number, input: OfficialLinkInput) {
      const canonicalId = canonicalIdSchema.parse(gameId);
      const values = officialLinkSchema.parse(input);
      const [created] = await db.insert(gameOfficialLinks)
        .values({ ...values, gameId: canonicalId })
        .returning();
      return created!;
    },

    async listOfficialLinks(gameId: number) {
      const canonicalId = canonicalIdSchema.parse(gameId);
      return db.select().from(gameOfficialLinks)
        .where(eq(gameOfficialLinks.gameId, canonicalId))
        .orderBy(asc(gameOfficialLinks.id));
    },

    async addImage(gameId: number, input: GameImageInput) {
      const canonicalId = canonicalIdSchema.parse(gameId);
      const values = gameImageSchema.parse(input);
      const [created] = await db.insert(gameImages)
        .values({ ...values, gameId: canonicalId })
        .returning();
      return created!;
    },

    async listImages(gameId: number) {
      const canonicalId = canonicalIdSchema.parse(gameId);
      return db.select().from(gameImages)
        .where(eq(gameImages.gameId, canonicalId))
        .orderBy(asc(gameImages.sortOrder), asc(gameImages.id));
    },

    async addVideo(gameId: number, input: GameVideoInput) {
      const canonicalId = canonicalIdSchema.parse(gameId);
      const values = gameVideoSchema.parse(input);
      const [created] = await db.insert(gameVideos)
        .values({ ...values, gameId: canonicalId })
        .returning();
      return created!;
    },

    async listVideos(gameId: number) {
      const canonicalId = canonicalIdSchema.parse(gameId);
      return db.select().from(gameVideos)
        .where(eq(gameVideos.gameId, canonicalId))
        .orderBy(asc(gameVideos.sortOrder), asc(gameVideos.id));
    },
  };
}

export type GameRepository = ReturnType<typeof createGameRepository>;
