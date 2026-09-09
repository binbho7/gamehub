import { and, asc, eq, sql } from "drizzle-orm";
import type { ImageProvider } from "../../images/source-policy";
import type { GameHubDatabase } from "../client";
import { gameImages, games } from "../schema";

export type ImageBinding = {
  storageKey: string;
  storageUrl: string;
  contentHash: string;
  mimeType: string;
  fileSize: number;
  width: number;
  height: number;
};

export type ImageIngestSnapshot = {
  game: {
    id: number;
    coverUrl: string | null;
    heroUrl: string | null;
    updatedAt: Date;
  };
  images: Array<{
    id: number;
    gameId: number;
    type: string;
    sourceUrl: string;
    sourceProvider: ImageProvider | null;
    storageUrl: string | null;
    storageKey: string | null;
    contentHash: string | null;
    mimeType: string | null;
    fileSize: number | null;
    width: number | null;
    height: number | null;
    sortOrder: number;
    createdAt: Date;
    updatedAt: Date;
  }>;
};

type ImageSnapshotRow = ImageIngestSnapshot["images"][number];
type CreateImageInput = ImageBinding & {
  gameId: number;
  type: string;
  sourceUrl: string;
  sourceProvider?: ImageProvider | null;
  sortOrder?: number;
  gameUpdatedAt: Date;
};

const imageSelection = {
  id: gameImages.id,
  gameId: gameImages.gameId,
  type: gameImages.type,
  sourceUrl: gameImages.sourceUrl,
  sourceProvider: gameImages.sourceProvider,
  storageUrl: gameImages.storageUrl,
  storageKey: gameImages.storageKey,
  contentHash: gameImages.contentHash,
  mimeType: gameImages.mimeType,
  fileSize: gameImages.fileSize,
  width: gameImages.width,
  height: gameImages.height,
  sortOrder: gameImages.sortOrder,
  createdAt: gameImages.createdAt,
  updatedAt: gameImages.updatedAt,
};

function isPartialStorageMetadata(image: Pick<
  ImageSnapshotRow,
  "storageUrl" | "storageKey" | "contentHash" | "mimeType" | "fileSize"
>): boolean {
  const fields = [
    image.storageUrl,
    image.storageKey,
    image.contentHash,
    image.mimeType,
    image.fileSize,
  ];
  const hasAny = fields.some((field) => field !== null);
  const hasAll = fields.every((field) => field !== null);
  return hasAny && !hasAll;
}

function isCompleteBinding(binding: ImageBinding): boolean {
  return typeof binding.storageKey === "string"
    && typeof binding.storageUrl === "string"
    && typeof binding.contentHash === "string"
    && typeof binding.mimeType === "string"
    && Number.isInteger(binding.fileSize)
    && binding.fileSize > 0
    && Number.isInteger(binding.width)
    && binding.width > 0
    && Number.isInteger(binding.height)
    && binding.height > 0;
}

function sameValue(column: unknown, value: unknown) {
  const normalized = value instanceof Date ? value.getTime() : value;
  return sql`${column} is ${normalized}`;
}

function snapshotPredicates(snapshot: ImageSnapshotRow) {
  return [
    eq(gameImages.id, snapshot.id),
    eq(gameImages.gameId, snapshot.gameId),
    sameValue(gameImages.type, snapshot.type),
    sameValue(gameImages.sourceUrl, snapshot.sourceUrl),
    sameValue(gameImages.sourceProvider, snapshot.sourceProvider),
    sameValue(gameImages.storageUrl, snapshot.storageUrl),
    sameValue(gameImages.storageKey, snapshot.storageKey),
    sameValue(gameImages.contentHash, snapshot.contentHash),
    sameValue(gameImages.mimeType, snapshot.mimeType),
    sameValue(gameImages.fileSize, snapshot.fileSize),
    sameValue(gameImages.width, snapshot.width),
    sameValue(gameImages.height, snapshot.height),
    sameValue(gameImages.sortOrder, snapshot.sortOrder),
    sameValue(gameImages.createdAt, snapshot.createdAt),
    sameValue(gameImages.updatedAt, snapshot.updatedAt),
  ];
}

export function createImageIngestRepository(db: GameHubDatabase) {
  const findIdentityRows = async (
    gameId: number,
    sourceUrl: string,
  ): Promise<ImageSnapshotRow[]> => {
    const rows = await db.select(imageSelection)
      .from(gameImages)
      .where(and(eq(gameImages.gameId, gameId), eq(gameImages.sourceUrl, sourceUrl)))
      .orderBy(asc(gameImages.id));
    return rows as ImageSnapshotRow[];
  };

  const findImageByIdentity = async (
    gameId: number,
    sourceUrl: string,
  ): Promise<ImageSnapshotRow | null> => {
    return (await findIdentityRows(gameId, sourceUrl))[0] ?? null;
  };

  return {
    async readImageIngestSnapshot(gameId: number): Promise<ImageIngestSnapshot | null> {
      const game = (await db.select({
        id: games.id,
        coverUrl: games.coverUrl,
        heroUrl: games.heroUrl,
        updatedAt: games.updatedAt,
      })
        .from(games)
        .where(eq(games.id, gameId))
        .limit(1))[0];
      if (!game) return null;

      const images = await db.select(imageSelection)
        .from(gameImages)
        .where(eq(gameImages.gameId, gameId))
        .orderBy(asc(gameImages.sortOrder), asc(gameImages.id));
      return {
        game,
        images: images as ImageSnapshotRow[],
      };
    },

    findImageByIdentity,

    async findImagesByIdentity(
      gameId: number,
      sourceUrl: string,
    ): Promise<ImageSnapshotRow[]> {
      return findIdentityRows(gameId, sourceUrl);
    },

    async conditionallyCreateImage(input: CreateImageInput): Promise<"created" | "race" | "write_conflict" | "inconsistent_state"> {
      const gameSnapshotPredicate = sql` and ${games.updatedAt} is ${input.gameUpdatedAt.getTime()}`;
      const result = await db.run(sql`
        insert into ${gameImages} (
          game_id,
          type,
          source_url,
          source_provider,
          storage_url,
          storage_key,
          content_hash,
          mime_type,
          file_size,
          width,
          height,
          sort_order
        )
        select
          ${input.gameId},
          ${input.type},
          ${input.sourceUrl},
          ${input.sourceProvider ?? null},
          ${input.storageUrl},
          ${input.storageKey},
          ${input.contentHash},
          ${input.mimeType},
          ${input.fileSize},
          ${input.width},
          ${input.height},
          ${input.sortOrder ?? 0}
        from ${games}
        where ${games.id} = ${input.gameId}${gameSnapshotPredicate}
          and not exists (
            select 1 from ${gameImages}
            where ${gameImages.gameId} = ${input.gameId}
              and ${gameImages.sourceUrl} = ${input.sourceUrl}
          )
      `);
      const changes = Number(result.meta.changes);
      if (changes === 1) return "created";
      if (changes !== 0) throw new Error("Image identity insert changed more than one row");

      // Zero changes means the game snapshot no longer applies, or an identity
      // winner already exists. Reread every identity row before classifying;
      // the repository must not hide duplicate or incompatible legacy rows.
      const rows = await findIdentityRows(input.gameId, input.sourceUrl);
      if (rows.length === 0) return "write_conflict";
      if (rows.length !== 1) return "inconsistent_state";
      const [row] = rows;
      if (row!.type !== input.type) return "inconsistent_state";
      if (row!.sourceProvider !== null && row!.sourceProvider !== (input.sourceProvider ?? null)) {
        return "inconsistent_state";
      }
      return "race";
    },

    async optimisticBindImage(
      snapshot: ImageSnapshotRow,
      binding: ImageBinding,
    ): Promise<"applied" | "write_conflict" | "invariant_failure"> {
      if (isPartialStorageMetadata(snapshot) || !isCompleteBinding(binding)) {
        return "invariant_failure";
      }

      const result = await db.update(gameImages)
        .set({
          storageKey: binding.storageKey,
          storageUrl: binding.storageUrl,
          contentHash: binding.contentHash,
          mimeType: binding.mimeType,
          fileSize: binding.fileSize,
          width: binding.width,
          height: binding.height,
          updatedAt: sql`(unixepoch('subsec') * 1000)`,
        })
        .where(and(...snapshotPredicates(snapshot)))
        .run();
      const changes = Number(result.meta.changes);
      if (changes === 1) return "applied";
      if (changes === 0) return "write_conflict";
      return "invariant_failure";
    },
  };
}

export type ImageIngestRepository = ReturnType<typeof createImageIngestRepository>;
