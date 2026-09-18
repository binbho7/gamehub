import { and, eq, sql, type SQL } from "drizzle-orm";
import type { GameHubDatabase } from "../client";
import { gameImages, games } from "../schema";
import type { ImageBinding, ImageIngestRepository } from "./image-ingest";
import { compileDomainQuery, type BuiltDomainQuery } from "./scheduled/fence";

type Snapshot = Parameters<ImageIngestRepository["optimisticBindImage"]>[0];
export function validImageBinding(snapshot: Snapshot, binding: ImageBinding): boolean {
  const metadata = [snapshot.storageUrl, snapshot.storageKey, snapshot.contentHash, snapshot.mimeType, snapshot.fileSize];
  if (metadata.some(value => value !== null) && metadata.some(value => value === null)) return false;
  return [binding.storageKey, binding.storageUrl, binding.contentHash, binding.mimeType].every(value => typeof value === "string")
    && [binding.fileSize, binding.width, binding.height].every(value => Number.isInteger(value) && value > 0);
}
export function imageBindQuery(db: GameHubDatabase, snapshot: Snapshot, binding: ImageBinding, guard?: SQL) {
  const same = (column: unknown, value: unknown) => sql`${column} is ${value instanceof Date ? value.getTime() : value}`;
  const query = db.update(gameImages).set({ ...binding, updatedAt: sql`(unixepoch('subsec') * 1000)` }).where(and(
    guard, eq(gameImages.id, snapshot.id), eq(gameImages.gameId, snapshot.gameId),
    same(gameImages.type, snapshot.type), same(gameImages.sourceUrl, snapshot.sourceUrl), same(gameImages.sourceProvider, snapshot.sourceProvider),
    same(gameImages.storageUrl, snapshot.storageUrl), same(gameImages.storageKey, snapshot.storageKey), same(gameImages.contentHash, snapshot.contentHash),
    same(gameImages.mimeType, snapshot.mimeType), same(gameImages.fileSize, snapshot.fileSize), same(gameImages.width, snapshot.width), same(gameImages.height, snapshot.height),
    same(gameImages.sortOrder, snapshot.sortOrder), same(gameImages.createdAt, snapshot.createdAt), same(gameImages.updatedAt, snapshot.updatedAt),
  ));
  return query;
}
export function imageCreateQuery(db: GameHubDatabase, input: Parameters<ImageIngestRepository["conditionallyCreateImage"]>[0], guard?: SQL) {
  const query = db.run(sql`
    insert into ${gameImages} (game_id,type,source_url,source_provider,storage_url,storage_key,content_hash,mime_type,file_size,width,height,sort_order)
    select ${input.gameId},${input.type},${input.sourceUrl},${input.sourceProvider ?? null},${input.storageUrl},${input.storageKey},${input.contentHash},${input.mimeType},${input.fileSize},${input.width},${input.height},${input.sortOrder ?? 0}
    from ${games} where ${games.id}=${input.gameId} and ${games.updatedAt} is ${input.gameUpdatedAt.getTime()}
      and ${guard ?? sql`1=1`}
      and not exists (select 1 from ${gameImages} where ${gameImages.gameId}=${input.gameId} and ${gameImages.sourceUrl}=${input.sourceUrl})
  `);
  return query;
}
export function buildImageBindQuery(db: GameHubDatabase, snapshot: Snapshot, binding: ImageBinding, guard?: SQL): BuiltDomainQuery {
  return compileDomainQuery(imageBindQuery(db, snapshot, binding, guard), { minChanges: 0, maxChanges: 1 });
}
export function buildImageCreateQuery(db: GameHubDatabase, input: Parameters<ImageIngestRepository["conditionallyCreateImage"]>[0], guard?: SQL): BuiltDomainQuery {
  return compileDomainQuery(imageCreateQuery(db, input, guard), { minChanges: 0, maxChanges: 1 });
}
