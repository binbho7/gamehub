import { and, eq, getTableColumns, isNull, or, sql, SQL } from "drizzle-orm";
import type { SQLiteTable, SQLiteInsertValue } from "drizzle-orm/sqlite-core";
import type { IgdbEnrichmentPlan } from "../../enrichers/igdb-candidate";
import type { GameHubDatabase } from "../client";
import { companies, gameCompanies, gameExternalIds, gameGenres, gameImages, gameOfficialLinks, gamePlatforms, games, gameVideos, genres, platforms } from "../schema";
import { compileDomainQuery, type BuiltDomainQuery } from "./scheduled/fence";

export function buildIgdbQueries(db: GameHubDatabase, plan: IgdbEnrichmentPlan, guard?: SQL): BuiltDomainQuery[] {
  if (plan.action !== "enrich") return [];
  // SELECT uses the same explicit column order and defaults as Drizzle VALUES.
  // Encoding through each column preserves booleans and SQL lookup expressions.
  function insert<T extends SQLiteTable>(table: T, values: SQLiteInsertValue<T>) {
    if (!guard) return db.insert(table).values(values);
    const fields = Object.entries(getTableColumns(table)).map(([key, column]) => {
      const value = (values as Record<string, unknown>)[key];
      const resolved = value === undefined ? (column.default ?? null) : value;
      return resolved === null ? sql`null` : resolved instanceof SQL ? resolved : sql.param(resolved, column);
    });
    return db.insert(table).select(sql`select ${sql.join(fields, sql`, `)} where ${guard}`);
  }

  type BatchQuery = Parameters<typeof db.batch>[0][number];
  const queries: BatchQuery[] = [];
  const identityAssertions = new Set<BatchQuery>();
  const externalIdentityCreates = plan.creates.filter((create) => create.entity === "external_id");
  for (const create of externalIdentityCreates) {
    // Reasserting an already-bound different identity trips the existing
    // provider/external-ID unique constraint before any candidate write.
    const assertion = db.insert(gameExternalIds).select(sql`
      select
        null,
        ${gameExternalIds.gameId},
        ${gameExternalIds.provider},
        ${gameExternalIds.externalId},
        ${gameExternalIds.externalUrl},
        ${gameExternalIds.createdAt},
        ${gameExternalIds.updatedAt}
      from ${gameExternalIds}
      where ${gameExternalIds.gameId} = ${create.values.gameId}
        and ${gameExternalIds.provider} = ${create.values.provider}
        and ${gameExternalIds.externalId} <> ${create.values.externalId}
        and ${guard ?? sql`1`}
      limit 1
    `);
    identityAssertions.add(assertion);
    queries.push(assertion);
    queries.push(insert(gameExternalIds, create.values));
  }

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
        .where(and(eq(games.id, plan.gameId), or(...nullPredicates), guard)));
    }
  }

  for (const create of plan.creates) {
    switch (create.entity) {
      case "external_id":
        break;
      case "genre":
        queries.push(insert(genres, create.values));
        break;
      case "game_genre":
        queries.push(insert(gameGenres, {
          gameId: create.values.gameId,
          genreId: sql<number>`(
            select ${genres.id}
            from ${genres}
            where ${genres.slug} = ${create.values.genreSlug}
          )`,
        }));
        break;
      case "platform":
        queries.push(insert(platforms, create.values));
        break;
      case "game_platform":
        queries.push(insert(gamePlatforms, {
          gameId: create.values.gameId,
          platformId: sql<number>`(
            select ${platforms.id}
            from ${platforms}
            where ${platforms.slug} = ${create.values.platformSlug}
          )`,
        }));
        break;
      case "company":
        queries.push(insert(companies, create.values));
        break;
      case "game_company":
        queries.push(insert(gameCompanies, {
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
        queries.push(insert(gameOfficialLinks, create.values));
        break;
      case "image":
        queries.push(db.insert(gameImages).select((qb) => qb.select({
          id: sql`null`.as("id"),
          gameId: sql`${create.values.gameId}`.as("game_id"),
          type: sql`${create.values.type}`.as("type"),
          sourceUrl: sql`${create.values.sourceUrl}`.as("source_url"),
          sourceProvider: sql`'igdb'`.as("source_provider"),
          storageUrl: sql`null`.as("storage_url"),
          storageKey: sql`null`.as("storage_key"),
          contentHash: sql`null`.as("content_hash"),
          mimeType: sql`null`.as("mime_type"),
          fileSize: sql`null`.as("file_size"),
          width: sql`${create.values.width}`.as("width"),
          height: sql`${create.values.height}`.as("height"),
          sortOrder: sql`${create.values.sortOrder}`.as("sort_order"),
          createdAt: sql`(unixepoch('subsec') * 1000)`.as("created_at"),
          updatedAt: sql`(unixepoch('subsec') * 1000)`.as("updated_at"),
        }).from(sql`(select 1)`).where(and(guard, sql`not exists (
            select 1
            from ${gameImages}
            where ${gameImages.gameId} = ${create.values.gameId}
              and ${gameImages.sourceUrl} = ${create.values.sourceUrl}
          )`))));
        break;
      case "video":
        queries.push(insert(gameVideos, create.values));
        break;
    }
  }

  return queries.map((query) => compileDomainQuery(query, {
    minChanges: 0,
    // A successful identity assertion never inserts; a conflict aborts the batch.
    maxChanges: identityAssertions.has(query) ? 0 : 1,
  }));
}
