import { asc, eq, sql } from "drizzle-orm";
import type { GameHubDatabase } from "../db/client";
import {
  companies,
  gameCompanies,
  gameExternalIds,
  gameGenres,
  gameImages,
  gameOfficialLinks,
  gamePlatforms,
  gameVideos,
  games,
  genres,
  platforms,
} from "../db/schema";

export type SiteSnapshotGame = {
  game: Pick<typeof games.$inferSelect, "id" | "slug" | "title" | "summary" | "description" | "status" | "releaseDate" | "coverUrl" | "heroUrl">;
  externalIds: Array<Pick<typeof gameExternalIds.$inferSelect, "id" | "gameId" | "provider" | "externalId" | "externalUrl">>;
  companies: Array<Pick<typeof companies.$inferSelect, "id" | "slug" | "name" | "websiteUrl"> & { role: string; gameId: number }>;
  genres: Array<Pick<typeof genres.$inferSelect, "id" | "slug" | "name">>;
  platforms: Array<Pick<typeof platforms.$inferSelect, "id" | "slug" | "name">>;
  images: Array<Pick<typeof gameImages.$inferSelect, "id" | "gameId" | "type" | "sourceUrl" | "sourceProvider" | "sortOrder">>;
  officialLinks: Array<Pick<typeof gameOfficialLinks.$inferSelect, "id" | "gameId" | "provider" | "platform" | "linkType" | "url" | "region" | "isOfficial" | "verificationStatus" | "verificationMethod">>;
  videos: Array<Pick<typeof gameVideos.$inferSelect, "id" | "gameId" | "provider" | "externalId" | "title" | "sortOrder">>;
};

export type SiteSnapshot = { games: SiteSnapshotGame[] };

const roleOrder = sql<number>`case ${gameCompanies.role} when 'developer' then 0 when 'publisher' then 1 else 2 end`;
const linkTypeOrder = sql<number>`case ${gameOfficialLinks.linkType} when 'official_website' then 0 when 'store' then 1 when 'purchase' then 2 when 'download' then 3 when 'demo' then 4 when 'launcher' then 5 else 6 end`;
const imageTypeOrder = sql<number>`case ${gameImages.type} when 'cover' then 0 when 'hero' then 1 when 'artwork' then 2 when 'screenshot' then 3 else 4 end`;

export async function readSiteSnapshot(db: GameHubDatabase): Promise<SiteSnapshot> {
  const [gameRows, externalIdRows, companyRows, genreRows, platformRows, imageRows, officialLinkRows, videoRows] = await Promise.all([
    db.select({
      id: games.id,
      slug: games.slug,
      title: games.title,
      summary: games.summary,
      description: games.description,
      status: games.status,
      releaseDate: games.releaseDate,
      coverUrl: games.coverUrl,
      heroUrl: games.heroUrl,
    }).from(games).orderBy(asc(games.id), asc(games.slug)),
    db.select({
      id: gameExternalIds.id,
      gameId: gameExternalIds.gameId,
      provider: gameExternalIds.provider,
      externalId: gameExternalIds.externalId,
      externalUrl: gameExternalIds.externalUrl,
    }).from(gameExternalIds).orderBy(asc(gameExternalIds.gameId), asc(gameExternalIds.provider), asc(gameExternalIds.externalId), asc(gameExternalIds.id)),
    db.select({
      id: companies.id,
      gameId: gameCompanies.gameId,
      slug: companies.slug,
      name: companies.name,
      websiteUrl: companies.websiteUrl,
      role: gameCompanies.role,
    }).from(gameCompanies).innerJoin(companies, eq(gameCompanies.companyId, companies.id))
      .orderBy(asc(gameCompanies.gameId), asc(roleOrder), asc(companies.name), asc(companies.id)),
    db.select({ id: genres.id, gameId: gameGenres.gameId, slug: genres.slug, name: genres.name })
      .from(gameGenres).innerJoin(genres, eq(gameGenres.genreId, genres.id))
      .orderBy(asc(gameGenres.gameId), asc(genres.name), asc(genres.id)),
    db.select({ id: platforms.id, gameId: gamePlatforms.gameId, slug: platforms.slug, name: platforms.name })
      .from(gamePlatforms).innerJoin(platforms, eq(gamePlatforms.platformId, platforms.id))
      .orderBy(asc(gamePlatforms.gameId), asc(platforms.name), asc(platforms.id)),
    db.select({
      id: gameImages.id,
      gameId: gameImages.gameId,
      type: gameImages.type,
      sourceUrl: gameImages.sourceUrl,
      sourceProvider: gameImages.sourceProvider,
      sortOrder: gameImages.sortOrder,
    }).from(gameImages)
      .orderBy(asc(gameImages.gameId), asc(imageTypeOrder), asc(gameImages.sortOrder), asc(gameImages.id)),
    db.select({
      id: gameOfficialLinks.id,
      gameId: gameOfficialLinks.gameId,
      provider: gameOfficialLinks.provider,
      platform: gameOfficialLinks.platform,
      linkType: gameOfficialLinks.linkType,
      url: gameOfficialLinks.url,
      region: gameOfficialLinks.region,
      isOfficial: gameOfficialLinks.isOfficial,
      verificationStatus: gameOfficialLinks.verificationStatus,
      verificationMethod: gameOfficialLinks.verificationMethod,
    }).from(gameOfficialLinks)
      .orderBy(asc(gameOfficialLinks.gameId), asc(linkTypeOrder), asc(gameOfficialLinks.provider), asc(gameOfficialLinks.url), asc(gameOfficialLinks.id)),
    db.select({
      id: gameVideos.id,
      gameId: gameVideos.gameId,
      provider: gameVideos.provider,
      externalId: gameVideos.externalId,
      title: gameVideos.title,
      sortOrder: gameVideos.sortOrder,
    }).from(gameVideos)
      .orderBy(asc(gameVideos.gameId), asc(gameVideos.provider), asc(gameVideos.sortOrder), asc(gameVideos.id)),
  ]);

  const byGame = new Map<number, SiteSnapshotGame>();
  for (const game of gameRows) {
    byGame.set(game.id, {
      game,
      externalIds: [], companies: [], genres: [], platforms: [], images: [], officialLinks: [], videos: [],
    });
  }
  const append = (rows: Array<{ gameId: number }>, key: keyof Omit<SiteSnapshotGame, "game">) => {
    for (const row of rows) {
      const target = byGame.get(row.gameId);
      if (target) (target[key] as unknown as Array<{ gameId: number }>).push(row);
    }
  };
  append(externalIdRows, "externalIds");
  append(companyRows, "companies");
  append(genreRows, "genres");
  append(platformRows, "platforms");
  append(imageRows, "images");
  append(officialLinkRows, "officialLinks");
  append(videoRows, "videos");
  return { games: gameRows.map((game) => byGame.get(game.id)!) };
}
