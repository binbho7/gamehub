import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const utcNow = sql`(unixepoch('subsec') * 1000)`;

export const games = sqliteTable("games", {
  id: integer("id").primaryKey(),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  summary: text("summary"),
  description: text("description"),
  status: text("status").notNull().default("unknown"),
  releaseDate: text("release_date"),
  coverUrl: text("cover_url"),
  heroUrl: text("hero_url"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(utcNow),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(utcNow),
}, (table) => [
  uniqueIndex("games_slug_unique").on(table.slug),
  index("games_status_release_date_idx").on(table.status, table.releaseDate, table.id),
  index("games_release_date_idx").on(table.releaseDate, table.id),
  check("games_status_check", sql`${table.status} in ('unknown', 'announced', 'upcoming', 'early_access', 'released', 'cancelled', 'delisted')`),
  check("games_release_date_check", sql`${table.releaseDate} is null or ${table.releaseDate} glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`),
]);

export const gameCronSyncState = sqliteTable("game_cron_sync_state", {
  gameId: integer("game_id").primaryKey().references(() => games.id, { onDelete: "cascade" }),
  lastAttemptAt: integer("last_attempt_at").notNull(),
  lastStatus: text("last_status").notNull(),
}, (table) => [
  index("game_cron_sync_state_attempt_idx").on(table.lastAttemptAt, table.gameId),
  check(
    "game_cron_sync_state_attempt_check",
    sql`typeof(${table.lastAttemptAt}) = 'integer' and ${table.lastAttemptAt} >= 0`,
  ),
  check(
    "game_cron_sync_state_status_check",
    sql`${table.lastStatus} in ('started', 'succeeded', 'failed')`,
  ),
]);

export const cronSyncLease = sqliteTable("cron_sync_lease", {
  name: text("name").primaryKey(),
  leaseOwnerToken: text("lease_owner_token"),
  leaseExpiresAt: integer("lease_expires_at").notNull().default(0),
  fenceEpoch: integer("fence_epoch").notNull().default(0),
}, (table) => [
  check("cron_sync_lease_name_check", sql`${table.name} = 'game-sync'`),
  check(
    "cron_sync_lease_expiry_check",
    sql`typeof(${table.leaseExpiresAt}) = 'integer' and ${table.leaseExpiresAt} >= 0`,
  ),
  check(
    "cron_sync_lease_epoch_check",
    sql`typeof(${table.fenceEpoch}) = 'integer' and ${table.fenceEpoch} >= 0 and ${table.fenceEpoch} <= 9007199254740991`,
  ),
  check(
    "cron_sync_lease_owner_check",
    sql`(
      ${table.leaseOwnerToken} is null and ${table.leaseExpiresAt} = 0
    ) or (
      typeof(${table.leaseOwnerToken}) = 'text'
      and length(${table.leaseOwnerToken}) > 0
      and ${table.leaseExpiresAt} > 0
    )`,
  ),
]);

export const gameExternalIds = sqliteTable("game_external_ids", {
  id: integer("id").primaryKey(),
  gameId: integer("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  externalId: text("external_id").notNull(),
  externalUrl: text("external_url"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(utcNow),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(utcNow),
}, (table) => [
  uniqueIndex("game_external_ids_provider_external_id_unique").on(table.provider, table.externalId),
  index("game_external_ids_game_id_idx").on(table.gameId),
]);

export const gameOfficialLinks = sqliteTable("game_official_links", {
  id: integer("id").primaryKey(),
  gameId: integer("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  platform: text("platform"),
  linkType: text("link_type").notNull(),
  url: text("url").notNull(),
  region: text("region"),
  isOfficial: integer("is_official", { mode: "boolean" }).notNull().default(true),
  verificationStatus: text("verification_status").notNull().default("unverified"),
  verificationMethod: text("verification_method"),
  httpStatus: integer("http_status"),
  redirectUrl: text("redirect_url"),
  verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
  lastCheckedAt: integer("last_checked_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(utcNow),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(utcNow),
}, (table) => [
  uniqueIndex("game_official_links_game_id_url_unique").on(table.gameId, table.url),
  index("game_official_links_game_id_type_idx").on(table.gameId, table.linkType),
  index("game_official_links_verification_idx").on(table.verificationStatus, table.lastCheckedAt),
  check("game_official_links_type_check", sql`${table.linkType} in ('official_website', 'store', 'purchase', 'download', 'demo', 'launcher')`),
  check("game_official_links_status_check", sql`${table.verificationStatus} in ('unverified', 'pending', 'verified', 'failed', 'reachable_but_unverified', 'broken', 'temporarily_unavailable', 'unsafe', 'unknown')`),
  check("game_official_links_method_check", sql`${table.verificationMethod} is null or ${table.verificationMethod} in ('manual', 'http', 'provider_api')`),
  check("game_official_links_http_status_check", sql`${table.httpStatus} is null or ${table.httpStatus} between 100 and 599`),
]);

export const genres = sqliteTable("genres", {
  id: integer("id").primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(utcNow),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(utcNow),
}, (table) => [
  uniqueIndex("genres_slug_unique").on(table.slug),
  uniqueIndex("genres_name_unique").on(table.name),
]);

export const gameGenres = sqliteTable("game_genres", {
  gameId: integer("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
  genreId: integer("genre_id").notNull().references(() => genres.id, { onDelete: "cascade" }),
}, (table) => [
  primaryKey({ columns: [table.gameId, table.genreId], name: "game_genres_pk" }),
  index("game_genres_genre_id_idx").on(table.genreId, table.gameId),
]);

export const platforms = sqliteTable("platforms", {
  id: integer("id").primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(utcNow),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(utcNow),
}, (table) => [
  uniqueIndex("platforms_slug_unique").on(table.slug),
  uniqueIndex("platforms_name_unique").on(table.name),
]);

export const gamePlatforms = sqliteTable("game_platforms", {
  gameId: integer("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
  platformId: integer("platform_id").notNull().references(() => platforms.id, { onDelete: "cascade" }),
}, (table) => [
  primaryKey({ columns: [table.gameId, table.platformId], name: "game_platforms_pk" }),
  index("game_platforms_platform_id_idx").on(table.platformId, table.gameId),
]);

export const companies = sqliteTable("companies", {
  id: integer("id").primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  websiteUrl: text("website_url"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(utcNow),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(utcNow),
}, (table) => [
  uniqueIndex("companies_slug_unique").on(table.slug),
  index("companies_name_idx").on(table.name),
]);

export const gameCompanies = sqliteTable("game_companies", {
  gameId: integer("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
  companyId: integer("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
}, (table) => [
  primaryKey({ columns: [table.gameId, table.companyId, table.role], name: "game_companies_pk" }),
  index("game_companies_company_role_idx").on(table.companyId, table.role, table.gameId),
  check("game_companies_role_check", sql`${table.role} in ('developer', 'publisher', 'porting', 'support')`),
]);

export const gameImages = sqliteTable("game_images", {
  id: integer("id").primaryKey(),
  gameId: integer("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  sourceUrl: text("source_url").notNull(),
  sourceProvider: text("source_provider"),
  storageUrl: text("storage_url"),
  storageKey: text("storage_key"),
  contentHash: text("content_hash"),
  mimeType: text("mime_type"),
  fileSize: integer("file_size"),
  width: integer("width"),
  height: integer("height"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(utcNow),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(utcNow),
}, (table) => [
  index("game_images_game_order_idx").on(table.gameId, table.type, table.sortOrder, table.id),
  index("game_images_game_sort_order_idx").on(table.gameId, table.sortOrder, table.id),
  check("game_images_type_check", sql`${table.type} in ('cover', 'hero', 'screenshot', 'artwork', 'logo')`),
  check("game_images_source_provider_check", sql`${table.sourceProvider} is null or ${table.sourceProvider} in ('steam', 'igdb')`),
  check("game_images_storage_check", sql`(
    ${table.storageUrl} is null
    and ${table.storageKey} is null
    and ${table.contentHash} is null
    and ${table.mimeType} is null
    and ${table.fileSize} is null
  ) or (
    ${table.storageUrl} is not null
    and ${table.storageKey} is not null
    and ${table.contentHash} is not null
    and ${table.mimeType} is not null
    and ${table.fileSize} is not null
  )`),
  check("game_images_storage_size_check", sql`${table.fileSize} is null or ${table.fileSize} > 0`),
  check("game_images_storage_mime_check", sql`${table.mimeType} is null or ${table.mimeType} in ('image/jpeg', 'image/png', 'image/webp')`),
  check("game_images_storage_hash_check", sql`${table.contentHash} is null or (length(${table.contentHash}) = 64 and ${table.contentHash} not glob '*[^0-9a-f]*')`),
  check("game_images_width_check", sql`${table.width} is null or ${table.width} > 0`),
  check("game_images_height_check", sql`${table.height} is null or ${table.height} > 0`),
  check("game_images_sort_order_check", sql`${table.sortOrder} >= 0`),
]);

export const gameVideos = sqliteTable("game_videos", {
  id: integer("id").primaryKey(),
  gameId: integer("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  externalId: text("external_id").notNull(),
  title: text("title"),
  thumbnailUrl: text("thumbnail_url"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(utcNow),
}, (table) => [
  uniqueIndex("game_videos_game_provider_external_id_unique").on(table.gameId, table.provider, table.externalId),
  index("game_videos_game_order_idx").on(table.gameId, table.sortOrder, table.id),
  check("game_videos_sort_order_check", sql`${table.sortOrder} >= 0`),
]);

export type GameRow = typeof games.$inferSelect;
export type NewGameRow = typeof games.$inferInsert;
